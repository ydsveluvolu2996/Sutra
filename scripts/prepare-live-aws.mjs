import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  assertNoAwsEndpointOverrideEnvironment,
  assertNoStaticAwsCredentialEnvironment,
  resolveValidatedSsoLoginProfile,
  scrubAwsEndpointOverrideEnvironment,
  validateAwsProfileCredentialSource,
} from "./live-aws-host.mjs";

export const LIVE_AWS_SETUP_ACKNOWLEDGEMENT =
  "I_ACKNOWLEDGE_THIS_CREATES_THE_SUTRA_SOURCE_ROLE";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/u;
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const ASSUMED_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/[A-Za-z0-9_+=,.@-]{1,64}$/u;
const IAM_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/([A-Za-z0-9_+=,.@\/-]+)$/u;
const IAM_POLICY_VERSION = /^v[1-9][0-9]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_STACK_OWNER = "sutra-live-aws-preparation";
const SOURCE_STACK_PURPOSE = "local-collector-source-role";
const SOURCE_STACK_TAG_KEYS = Object.freeze({
  owner: "sutra:stack-owner",
  purpose: "sutra:stack-purpose",
  templateDigest: "sutra:template-sha256",
});
const EXPECTED_STACK_PARAMETERS = Object.freeze({
  CollectorRoleName: "SutraLocalCollectorRole",
});
const COLLECTOR_ROLE_NAME = "SutraLocalCollectorRole";
const COLLECTOR_ROLE_PATH = "/sutra/";
const COLLECTOR_ROLE_DESCRIPTION =
  "Short-lived source role used only by the local Sutra sandbox collector.";
const COLLECTOR_ROLE_MAX_SESSION_SECONDS = 3_600;
const COLLECTOR_INLINE_POLICY_NAME = "AssumeDedicatedSutraCustomerRoles";
const EXPECTED_COLLECTOR_ROLE_TAGS = Object.freeze({
  "sutra:access-mode": "assume-role-only",
  "sutra:environment": "disposable-sandbox",
  "sutra:managed-by": "cloudformation",
});
const COLLECTOR_BOUNDARY_POLICY_NAME = "SutraCollectorBoundary";
const COLLECTOR_BOUNDARY_POLICY_PATH = "/";
const EXPECTED_COLLECTOR_BOUNDARY_DOCUMENT = Object.freeze({
  Version: "2012-10-17",
  Statement: Object.freeze([
    Object.freeze({
      Sid: "DenyEveryNonAssumeRoleAction",
      Effect: "Deny",
      NotAction: "sts:AssumeRole",
      Resource: "*",
    }),
    Object.freeze({
      Sid: "DenyAssumeRoleOutsideSutraRoleNamespace",
      Effect: "Deny",
      Action: "sts:AssumeRole",
      NotResource: "arn:aws:iam::*:role/sutra/*",
    }),
    Object.freeze({
      Sid: "AssumeDedicatedSutraCustomerRolesOnly",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: "arn:aws:iam::*:role/sutra/*",
    }),
  ]),
});
const REUSABLE_STACK_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);
const REUSABLE_RESOURCE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);

function exactValue(environment, key, fallback) {
  const value = environment[key] ?? fallback;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${key} must be a non-empty value without surrounding whitespace`);
  }
  return value;
}

export function validateLiveAwsPreparationEnvironment(environment) {
  if (environment.SUTRA_LIVE_AWS_SETUP_ACK !== LIVE_AWS_SETUP_ACKNOWLEDGEMENT) {
    throw new Error(
      `Set SUTRA_LIVE_AWS_SETUP_ACK exactly to ${LIVE_AWS_SETUP_ACKNOWLEDGEMENT} for this source-role deployment`,
    );
  }
  assertNoStaticAwsCredentialEnvironment(environment);
  assertNoAwsEndpointOverrideEnvironment(environment);

  const operatorProfile = exactValue(environment, "AWS_PROFILE");
  const collectorProfile = exactValue(
    environment,
    "SUTRA_COLLECTOR_PROFILE",
    "sutra-demo-collector",
  );
  const region = exactValue(
    environment,
    "AWS_REGION",
    environment.AWS_DEFAULT_REGION ?? "us-east-1",
  );
  const stackName = exactValue(
    environment,
    "SUTRA_COLLECTOR_STACK_NAME",
    "sutra-local-collector",
  );

  if (!PROFILE_NAME.test(operatorProfile) || !PROFILE_NAME.test(collectorProfile)) {
    throw new Error("AWS profiles must be plain named profiles");
  }
  if (operatorProfile === collectorProfile) {
    throw new Error("The operator and collector AWS profiles must be different");
  }
  if (
    !REGION.test(region) ||
    region.startsWith("us-gov-") ||
    region.startsWith("cn-")
  ) {
    throw new Error("The live source-role preparation currently supports commercial AWS Regions only");
  }
  if (!STACK_NAME.test(stackName)) {
    throw new Error("SUTRA_COLLECTOR_STACK_NAME must be a valid CloudFormation stack name");
  }

  return { operatorProfile, collectorProfile, region, stackName };
}

export function parseOperatorIdentity(value) {
  const account = value?.Account;
  const arn = value?.Arn;
  if (typeof account !== "string" || !ACCOUNT_ID.test(account) || typeof arn !== "string") {
    throw new Error("AWS STS returned an invalid operator identity");
  }
  const match = ASSUMED_ROLE_ARN.exec(arn);
  if (match === null || match[2] !== account || match[3] === undefined) {
    throw new Error("The operator profile must resolve to an assumed IAM role session");
  }
  return { accountId: account, partition: match[1], roleName: match[3] };
}

export function parseExactOperatorRole(value, expected) {
  const role = value?.Role;
  const arn = role?.Arn;
  const roleName = role?.RoleName;
  if (typeof arn !== "string" || typeof roleName !== "string") {
    throw new Error("AWS IAM returned an invalid operator role");
  }
  const match = IAM_ROLE_ARN.exec(arn);
  if (
    match === null ||
    match[1] !== expected.partition ||
    match[2] !== expected.accountId ||
    roleName !== expected.roleName
  ) {
    throw new Error("The IAM operator role does not match the signed-in STS identity");
  }
  return arn;
}

export function parseCollectorRoleArn(value, expectedAccountId, expectedPartition) {
  const stacks = value?.Stacks;
  const outputs = Array.isArray(stacks) && stacks.length === 1 ? stacks[0]?.Outputs : undefined;
  const output = Array.isArray(outputs)
    ? outputs.find((candidate) => candidate?.OutputKey === "CollectorRoleArn")
    : undefined;
  const arn = output?.OutputValue;
  if (typeof arn !== "string") {
    throw new Error("The source-role stack did not return CollectorRoleArn");
  }
  const match = IAM_ROLE_ARN.exec(arn);
  if (
    match === null ||
    match[1] !== expectedPartition ||
    match[2] !== expectedAccountId ||
    match[3] !== "sutra/SutraLocalCollectorRole"
  ) {
    throw new Error("The source-role stack returned an unexpected IAM role");
  }
  return arn;
}

export function collectorBoundaryPolicyArn(accountId, partition) {
  if (!ACCOUNT_ID.test(accountId) || partition !== "aws") {
    throw new Error("The collector boundary account or partition is invalid");
  }
  return `arn:${partition}:iam::${accountId}:policy/${COLLECTOR_BOUNDARY_POLICY_NAME}`;
}

function parsedPolicyDocument(value, label) {
  let document = value;
  if (Buffer.isBuffer(document)) document = document.toString("utf8");
  if (typeof document === "string") {
    try {
      document = JSON.parse(document);
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  }
  return document;
}

export function attestCollectorBoundaryPolicyDocument(value, label = "Collector boundary policy") {
  const document = parsedPolicyDocument(value, label);
  if (!isDeepStrictEqual(document, EXPECTED_COLLECTOR_BOUNDARY_DOCUMENT)) {
    throw new Error(`${label} does not match the reviewed Sutra collector boundary contract`);
  }
  return document;
}

export function parseCollectorBoundaryPolicy(value, expectedAccountId, expectedPartition) {
  const expectedArn = collectorBoundaryPolicyArn(expectedAccountId, expectedPartition);
  const policy = value?.Policy;
  if (
    policy?.Arn !== expectedArn ||
    policy?.PolicyName !== COLLECTOR_BOUNDARY_POLICY_NAME ||
    policy?.Path !== COLLECTOR_BOUNDARY_POLICY_PATH ||
    policy?.IsAttachable !== true ||
    typeof policy?.DefaultVersionId !== "string" ||
    !IAM_POLICY_VERSION.test(policy.DefaultVersionId)
  ) {
    throw new Error("AWS IAM returned an invalid Sutra collector boundary policy");
  }
  return { arn: expectedArn, versionId: policy.DefaultVersionId };
}

export function attestCollectorBoundaryPolicyVersion(value, expectedVersionId) {
  const version = value?.PolicyVersion;
  if (
    typeof expectedVersionId !== "string" ||
    !IAM_POLICY_VERSION.test(expectedVersionId) ||
    version?.VersionId !== expectedVersionId ||
    version?.IsDefaultVersion !== true
  ) {
    throw new Error("AWS IAM returned an invalid Sutra collector boundary policy version");
  }
  attestCollectorBoundaryPolicyDocument(version.Document, "AWS IAM collector boundary policy");
}

export function attestCollectorRoleBoundary(value, expectedAccountId, expectedPartition) {
  const role = value?.Role;
  const expectedRoleArn =
    `arn:${expectedPartition}:iam::${expectedAccountId}:role${COLLECTOR_ROLE_PATH}${COLLECTOR_ROLE_NAME}`;
  if (
    role?.Arn !== expectedRoleArn ||
    role?.RoleName !== COLLECTOR_ROLE_NAME ||
    role?.Path !== COLLECTOR_ROLE_PATH ||
    role?.PermissionsBoundary?.PermissionsBoundaryType !== "Policy" ||
    role?.PermissionsBoundary?.PermissionsBoundaryArn !==
      collectorBoundaryPolicyArn(expectedAccountId, expectedPartition)
  ) {
    throw new Error("The Sutra collector role does not use the reviewed permissions boundary");
  }
}

export function attestCollectorRoleDefinition(value, expected) {
  if (!SHA256.test(expected.templateDigest)) {
    throw new Error("The expected Sutra collector role template digest is invalid");
  }
  const role = value?.Role;
  const expectedRoleArn =
    `arn:aws:iam::${expected.accountId}:role${COLLECTOR_ROLE_PATH}${COLLECTOR_ROLE_NAME}`;
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Sid: "FederatedOperatorOnly",
      Effect: "Allow",
      Principal: { AWS: expected.operatorRoleArn },
      Action: "sts:AssumeRole",
    }],
  };
  if (
    expected.partition !== "aws" ||
    role?.Arn !== expectedRoleArn ||
    role?.RoleName !== COLLECTOR_ROLE_NAME ||
    role?.Path !== COLLECTOR_ROLE_PATH ||
    role?.Description !== COLLECTOR_ROLE_DESCRIPTION ||
    role?.MaxSessionDuration !== COLLECTOR_ROLE_MAX_SESSION_SECONDS ||
    role?.PermissionsBoundary?.PermissionsBoundaryType !== "Policy" ||
    role?.PermissionsBoundary?.PermissionsBoundaryArn !==
      collectorBoundaryPolicyArn(expected.accountId, expected.partition) ||
    !isDeepStrictEqual(
      parsedPolicyDocument(role?.AssumeRolePolicyDocument, "AWS IAM collector trust policy"),
      expectedTrust,
    )
  ) {
    throw new Error("The Sutra collector role does not match its reviewed live IAM contract");
  }
  const tags = exactKeyValueMap(role.Tags, "Key", "Value", "AWS IAM collector role tags");
  requireExactEntries(tags, {
    ...EXPECTED_COLLECTOR_ROLE_TAGS,
    [SOURCE_STACK_TAG_KEYS.owner]: SOURCE_STACK_OWNER,
    [SOURCE_STACK_TAG_KEYS.purpose]: SOURCE_STACK_PURPOSE,
    [SOURCE_STACK_TAG_KEYS.templateDigest]: expected.templateDigest,
  }, "AWS IAM collector role tags");
}

export function attestCollectorRoleInlinePolicyNames(value) {
  if (
    value?.IsTruncated === true ||
    !Array.isArray(value?.PolicyNames) ||
    value.PolicyNames.length !== 1 ||
    value.PolicyNames[0] !== COLLECTOR_INLINE_POLICY_NAME
  ) {
    throw new Error("The Sutra collector role does not have exactly its reviewed inline policy");
  }
}

export function attestCollectorRoleInlinePolicy(value, expectedAccountId) {
  const expectedDocument = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyAssumeRoleOutsideSutraRoleNamespace",
        Effect: "Deny",
        Action: "sts:AssumeRole",
        NotResource: "arn:aws:iam::*:role/sutra/*",
      },
      {
        Sid: "AssumeDedicatedSutraCustomerRolesOnly",
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: "arn:aws:iam::*:role/sutra/*",
      },
    ],
  };
  if (
    !ACCOUNT_ID.test(expectedAccountId) ||
    value?.RoleName !== COLLECTOR_ROLE_NAME ||
    value?.PolicyName !== COLLECTOR_INLINE_POLICY_NAME ||
    !isDeepStrictEqual(
      parsedPolicyDocument(value?.PolicyDocument, "AWS IAM collector inline policy"),
      expectedDocument,
    )
  ) {
    throw new Error("The Sutra collector role inline policy does not match its reviewed contract");
  }
}

export function attestCollectorRoleHasNoManagedPolicies(value) {
  if (
    value?.IsTruncated === true ||
    !Array.isArray(value?.AttachedPolicies) ||
    value.AttachedPolicies.length !== 0
  ) {
    throw new Error("The Sutra collector role must not have attached managed policies");
  }
}

function exactTemplateBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("The source-role template could not be read as exact bytes");
}

export function sourceTemplateSha256(value) {
  return createHash("sha256").update(exactTemplateBytes(value)).digest("hex");
}

function exactKeyValueMap(values, keyName, valueName, label) {
  if (!Array.isArray(values)) throw new Error(`${label} are missing`);
  const result = new Map();
  for (const item of values) {
    const key = item?.[keyName];
    const value = item?.[valueName];
    if (typeof key !== "string" || typeof value !== "string" || result.has(key)) {
      throw new Error(`${label} are malformed or contain duplicates`);
    }
    result.set(key, value);
  }
  return result;
}

function requireExactEntries(actual, expected, label) {
  if (actual.size !== Object.keys(expected).length) {
    throw new Error(`${label} do not exactly match the Sutra source-role template`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual.get(key) !== expectedValue) {
      throw new Error(`${label} do not exactly match the Sutra source-role template`);
    }
  }
}

export function attestExistingSourceStack(value, expected) {
  if (!SHA256.test(expected.templateDigest)) {
    throw new Error("The local source-role template digest is invalid");
  }
  const stacks = value?.Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1) {
    throw new Error("CloudFormation did not return exactly one existing source-role stack");
  }
  const stack = stacks[0];
  const expectedStackPrefix =
    `arn:${expected.partition}:cloudformation:${expected.region}:${expected.accountId}:` +
    `stack/${expected.stackName}/`;
  if (
    stack?.StackName !== expected.stackName ||
    typeof stack?.StackId !== "string" ||
    !stack.StackId.startsWith(expectedStackPrefix) ||
    stack.StackId.slice(expectedStackPrefix.length).length === 0 ||
    stack.StackId.slice(expectedStackPrefix.length).includes("/") ||
    stack.ParentId !== undefined ||
    stack.RootId !== undefined ||
    !REUSABLE_STACK_STATUSES.has(stack.StackStatus)
  ) {
    throw new Error(
      "The existing CloudFormation stack identity or state is not safe for Sutra reuse",
    );
  }

  const tags = exactKeyValueMap(stack.Tags, "Key", "Value", "Existing stack tags");
  const requiredTags = {
    [SOURCE_STACK_TAG_KEYS.owner]: SOURCE_STACK_OWNER,
    [SOURCE_STACK_TAG_KEYS.purpose]: SOURCE_STACK_PURPOSE,
    [SOURCE_STACK_TAG_KEYS.templateDigest]: expected.templateDigest,
  };
  for (const [key, expectedValue] of Object.entries(requiredTags)) {
    if (tags.get(key) !== expectedValue) {
      throw new Error(
        "The existing CloudFormation stack is not owned by this exact Sutra source-role template",
      );
    }
  }

  const parameters = exactKeyValueMap(
    stack.Parameters,
    "ParameterKey",
    "ParameterValue",
    "Existing stack parameters",
  );
  requireExactEntries(parameters, {
    OperatorRoleArn: expected.operatorRoleArn,
    ...EXPECTED_STACK_PARAMETERS,
  }, "Existing stack parameters");
}

export function attestExistingSourceTemplate(value, expectedDigest) {
  if (!SHA256.test(expectedDigest) || typeof value?.TemplateBody !== "string") {
    throw new Error("CloudFormation did not return an exact source-role template body");
  }
  if (sourceTemplateSha256(value.TemplateBody) !== expectedDigest) {
    throw new Error("The existing stack template does not match the local Sutra source-role template");
  }
}

export function attestExistingSourceResources(value) {
  const resources = value?.StackResourceSummaries;
  if (!Array.isArray(resources) || resources.length !== 1) {
    throw new Error("The existing stack does not contain exactly one Sutra source-role resource");
  }
  const resource = resources[0];
  if (
    resource?.LogicalResourceId !== "CollectorRole" ||
    resource?.PhysicalResourceId !== "SutraLocalCollectorRole" ||
    resource?.ResourceType !== "AWS::IAM::Role" ||
    !REUSABLE_RESOURCE_STATUSES.has(resource?.ResourceStatus)
  ) {
    throw new Error("The existing stack resource is not the expected Sutra collector IAM role");
  }
}

export function isExactStackNotFoundError(error, stackName) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("(ValidationError)") &&
    error.message.includes("DescribeStacks operation") &&
    error.message.endsWith(`Stack with id ${stackName} does not exist`);
}

function safeJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function childEnvironment(environment, profile, region) {
  return {
    ...scrubAwsEndpointOverrideEnvironment(environment),
    AWS_PROFILE: profile,
    AWS_REGION: region,
    AWS_DEFAULT_REGION: region,
    AWS_SDK_LOAD_CONFIG: "1",
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
  };
}

function spawnCommand(command, args, options, captureOutput) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (captureOutput) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 1_048_576) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else {
        const detail = captureOutput && stderr.trim().length > 0
          ? `: ${stderr.trim().slice(0, 1_000)}`
          : "";
        reject(new Error(`${command} exited ${signal ?? code}${detail}`));
      }
    });
  });
}

const defaultRun = (command, args, options) =>
  spawnCommand(command, args, options, false);
const defaultCapture = (command, args, options) =>
  spawnCommand(command, args, options, true);

async function secureSharedFiles(profileSource) {
  await mkdir(dirname(profileSource.configFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(profileSource.configFile), 0o700);
  await chmod(profileSource.configFile, 0o600);
}

export async function prepareLiveAws({
  environment,
  root,
  runCommand = defaultRun,
  captureCommand = defaultCapture,
  validateProfile = validateAwsProfileCredentialSource,
  secureFiles = secureSharedFiles,
  readTemplate = readFile,
  readBoundaryPolicy = readFile,
}) {
  const input = validateLiveAwsPreparationEnvironment(environment);
  const operatorEnvironment = childEnvironment(
    environment,
    input.operatorProfile,
    input.region,
  );
  const operatorProfileSource = await validateProfile({
    environment: operatorEnvironment,
  });
  const ssoLoginProfile = resolveValidatedSsoLoginProfile(
    operatorProfileSource,
    input.operatorProfile,
  );
  const ssoLoginEnvironment = childEnvironment(
    environment,
    ssoLoginProfile,
    input.region,
  );

  await runCommand(
    "aws",
    ["sso", "login", "--profile", ssoLoginProfile, "--no-cli-auto-prompt"],
    { cwd: root, environment: ssoLoginEnvironment },
  );
  const identity = parseOperatorIdentity(safeJson(await captureCommand(
    "aws",
    ["sts", "get-caller-identity", "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt"],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS STS"));
  if (identity.partition !== "aws") {
    throw new Error("The live source-role preparation supports only the commercial AWS partition");
  }
  const operatorRoleArn = parseExactOperatorRole(safeJson(await captureCommand(
    "aws",
    ["iam", "get-role", "--role-name", identity.roleName, "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt"],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS IAM"), identity);

  const boundaryPolicyPath = resolve(
    root,
    "infrastructure/sutra-collector-boundary-policy.json",
  );
  attestCollectorBoundaryPolicyDocument(
    await readBoundaryPolicy(boundaryPolicyPath),
    "Local collector boundary policy",
  );
  const expectedBoundaryArn = collectorBoundaryPolicyArn(
    identity.accountId,
    identity.partition,
  );
  const boundaryPolicy = parseCollectorBoundaryPolicy(safeJson(await captureCommand(
    "aws",
    [
      "iam", "get-policy",
      "--policy-arn", expectedBoundaryArn,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS IAM collector boundary policy"), identity.accountId, identity.partition);
  attestCollectorBoundaryPolicyVersion(safeJson(await captureCommand(
    "aws",
    [
      "iam", "get-policy-version",
      "--policy-arn", boundaryPolicy.arn,
      "--version-id", boundaryPolicy.versionId,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS IAM collector boundary policy version"), boundaryPolicy.versionId);

  const templatePath = resolve(root, "infrastructure/local-collector-role.yaml");
  const templateDigest = sourceTemplateSha256(await readTemplate(templatePath));
  const stackExpectation = {
    accountId: identity.accountId,
    operatorRoleArn,
    partition: identity.partition,
    region: input.region,
    stackName: input.stackName,
    templateDigest,
  };
  let existingStack;
  try {
    existingStack = safeJson(await captureCommand(
      "aws",
      [
        "cloudformation", "describe-stacks",
        "--stack-name", input.stackName,
        "--output", "json",
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: root, environment: operatorEnvironment },
    ), "AWS CloudFormation existing-stack preflight");
  } catch (error) {
    if (!isExactStackNotFoundError(error, input.stackName)) throw error;
  }
  if (existingStack !== undefined) {
    attestExistingSourceStack(existingStack, stackExpectation);
    attestExistingSourceTemplate(safeJson(await captureCommand(
      "aws",
      [
        "cloudformation", "get-template",
        "--stack-name", input.stackName,
        "--template-stage", "Original",
        "--output", "json",
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: root, environment: operatorEnvironment },
    ), "AWS CloudFormation existing template"), templateDigest);
    attestExistingSourceResources(safeJson(await captureCommand(
      "aws",
      [
        "cloudformation", "list-stack-resources",
        "--stack-name", input.stackName,
        "--output", "json",
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: root, environment: operatorEnvironment },
    ), "AWS CloudFormation existing resources"));
  }

  await runCommand(
    "aws",
    [
      "cloudformation", "deploy",
      "--stack-name", input.stackName,
      "--template-file", templatePath,
      "--capabilities", "CAPABILITY_NAMED_IAM",
      "--parameter-overrides", `OperatorRoleArn=${operatorRoleArn}`,
      "--tags",
      `${SOURCE_STACK_TAG_KEYS.owner}=${SOURCE_STACK_OWNER}`,
      `${SOURCE_STACK_TAG_KEYS.purpose}=${SOURCE_STACK_PURPOSE}`,
      `${SOURCE_STACK_TAG_KEYS.templateDigest}=${templateDigest}`,
      "--no-fail-on-empty-changeset",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  );
  const collectorRoleArn = parseCollectorRoleArn(safeJson(await captureCommand(
    "aws",
    [
      "cloudformation", "describe-stacks",
      "--stack-name", input.stackName,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS CloudFormation"), identity.accountId, identity.partition);
  const collectorRole = safeJson(await captureCommand(
    "aws",
    [
      "iam", "get-role",
      "--role-name", COLLECTOR_ROLE_NAME,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS IAM collector role");
  attestCollectorRoleDefinition(collectorRole, {
    accountId: identity.accountId,
    operatorRoleArn,
    partition: identity.partition,
    templateDigest,
  });
  attestCollectorRoleInlinePolicyNames(safeJson(await captureCommand(
    "aws",
    [
      "iam", "list-role-policies",
      "--role-name", COLLECTOR_ROLE_NAME,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS IAM collector inline policy list"));
  attestCollectorRoleInlinePolicy(safeJson(await captureCommand(
    "aws",
    [
      "iam", "get-role-policy",
      "--role-name", COLLECTOR_ROLE_NAME,
      "--policy-name", COLLECTOR_INLINE_POLICY_NAME,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS IAM collector inline policy"), identity.accountId);
  attestCollectorRoleHasNoManagedPolicies(safeJson(await captureCommand(
    "aws",
    [
      "iam", "list-attached-role-policies",
      "--role-name", COLLECTOR_ROLE_NAME,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: operatorEnvironment },
  ), "AWS IAM collector managed policy list"));

  for (const [key, value] of [
    ["role_arn", collectorRoleArn],
    ["source_profile", input.operatorProfile],
    ["role_session_name", "sutra-local-demo"],
    ["duration_seconds", "3600"],
    ["region", input.region],
    ["output", "json"],
  ]) {
    await runCommand(
      "aws",
      ["configure", "set", key, value, "--profile", input.collectorProfile],
      { cwd: root, environment: operatorEnvironment },
    );
  }
  await secureFiles(operatorProfileSource);

  const collectorEnvironment = childEnvironment(
    environment,
    input.collectorProfile,
    input.region,
  );
  await validateProfile({ environment: collectorEnvironment });
  const sourceIdentity = parseOperatorIdentity(safeJson(await captureCommand(
    "aws",
    ["sts", "get-caller-identity", "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt"],
    { cwd: root, environment: collectorEnvironment },
  ), "AWS STS source-role preflight"));
  if (sourceIdentity.accountId !== identity.accountId || sourceIdentity.roleName !== "SutraLocalCollectorRole") {
    throw new Error("The collector profile did not resolve to the dedicated Sutra source role");
  }

  return {
    operatorProfile: input.operatorProfile,
    collectorProfile: input.collectorProfile,
    region: input.region,
    accountId: identity.accountId,
    operatorRoleArn,
    collectorRoleArn,
    collectorBoundaryPolicyArn: boundaryPolicy.arn,
  };
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const result = await prepareLiveAws({ environment: process.env, root });
  process.stdout.write("\nSutra source-role preparation completed.\n");
  process.stdout.write(`MSP source account: ${result.accountId}\n`);
  process.stdout.write(`Collector profile: ${result.collectorProfile}\n`);
  process.stdout.write(`Collector role: ${result.collectorRoleArn}\n`);
  process.stdout.write(`Collector permissions boundary: ${result.collectorBoundaryPolicyArn}\n\n`);
  process.stdout.write("Start the guarded live service with:\n");
  process.stdout.write(
    `AWS_PROFILE=${result.collectorProfile} AWS_REGION=${result.region} ` +
      `SUTRA_COLLECTOR_PRINCIPAL_ARN='${result.collectorRoleArn}' ` +
      "SUTRA_LIVE_AWS_ACK='I_ACKNOWLEDGE_THIS_WILL_CONTACT_AWS' pnpm live:aws:host\n",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Live AWS preparation failed";
    process.stderr.write(`Sutra live AWS preparation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
