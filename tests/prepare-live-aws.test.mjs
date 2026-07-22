import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_AWS_SETUP_ACKNOWLEDGEMENT,
  attestCollectorBoundaryPolicyDocument,
  attestCollectorBoundaryPolicyVersion,
  attestCollectorRoleBoundary,
  attestCollectorRoleDefinition,
  attestCollectorRoleHasNoManagedPolicies,
  attestCollectorRoleInlinePolicy,
  attestCollectorRoleInlinePolicyNames,
  attestExistingSourceResources,
  attestExistingSourceStack,
  attestExistingSourceTemplate,
  isExactStackNotFoundError,
  parseCollectorRoleArn,
  parseCollectorBoundaryPolicy,
  parseExactOperatorRole,
  parseOperatorIdentity,
  prepareLiveAws,
  sourceTemplateSha256,
  validateLiveAwsPreparationEnvironment,
} from "../scripts/prepare-live-aws.mjs";

const OPERATOR_PROFILE = "sutra-msp-operator";
const COLLECTOR_PROFILE = "sutra-demo-collector";
const SSO_LOGIN_PROFILE = "sutra-identity-center";
const ACCOUNT_ID = "111122223333";
const OPERATOR_ROLE = "arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_abc";
const COLLECTOR_ROLE = "arn:aws:iam::111122223333:role/sutra/SutraLocalCollectorRole";
const COLLECTOR_BOUNDARY = "arn:aws:iam::111122223333:policy/SutraCollectorBoundary";
const COLLECTOR_BOUNDARY_DOCUMENT = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DenyEveryNonAssumeRoleAction",
      Effect: "Deny",
      NotAction: "sts:AssumeRole",
      Resource: "*",
    },
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
const TEMPLATE_BODY = "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n";
const TEMPLATE_DIGEST = sourceTemplateSha256(TEMPLATE_BODY);

function existingStack(overrides = {}) {
  return {
    StackName: "sutra-local-collector",
    StackId: `arn:aws:cloudformation:us-east-1:${ACCOUNT_ID}:stack/sutra-local-collector/12345678-abcd-1234-abcd-123456789012`,
    StackStatus: "CREATE_COMPLETE",
    Tags: [
      { Key: "sutra:stack-owner", Value: "sutra-live-aws-preparation" },
      { Key: "sutra:stack-purpose", Value: "local-collector-source-role" },
      { Key: "sutra:template-sha256", Value: TEMPLATE_DIGEST },
    ],
    Parameters: [
      { ParameterKey: "OperatorRoleArn", ParameterValue: OPERATOR_ROLE },
      { ParameterKey: "CollectorRoleName", ParameterValue: "SutraLocalCollectorRole" },
    ],
    Outputs: [{ OutputKey: "CollectorRoleArn", OutputValue: COLLECTOR_ROLE }],
    ...overrides,
  };
}

const EXPECTED_STACK = {
  accountId: ACCOUNT_ID,
  operatorRoleArn: OPERATOR_ROLE,
  partition: "aws",
  region: "us-east-1",
  stackName: "sutra-local-collector",
  templateDigest: TEMPLATE_DIGEST,
};

function preparationEnvironment(overrides = {}) {
  return {
    SUTRA_LIVE_AWS_SETUP_ACK: LIVE_AWS_SETUP_ACKNOWLEDGEMENT,
    AWS_PROFILE: OPERATOR_PROFILE,
    SUTRA_COLLECTOR_PROFILE: COLLECTOR_PROFILE,
    AWS_REGION: "us-east-1",
    ...overrides,
  };
}

function validatedProfileSource(selectedProfile) {
  const chain = selectedProfile === OPERATOR_PROFILE
    ? [OPERATOR_PROFILE, SSO_LOGIN_PROFILE]
    : [selectedProfile, OPERATOR_PROFILE, SSO_LOGIN_PROFILE];
  return {
    selectedProfile,
    chain,
    terminal: "sso",
    configFile: "/safe/config",
    credentialsFile: "/safe/credentials",
  };
}

function capturedIamResponse(args) {
  if (args[1] === "get-policy") {
    return {
      Policy: {
        Arn: COLLECTOR_BOUNDARY,
        PolicyName: "SutraCollectorBoundary",
        Path: "/",
        IsAttachable: true,
        DefaultVersionId: "v1",
      },
    };
  }
  if (args[1] === "get-policy-version") {
    return {
      PolicyVersion: {
        Document: COLLECTOR_BOUNDARY_DOCUMENT,
        VersionId: "v1",
        IsDefaultVersion: true,
      },
    };
  }
  if (args[1] === "list-role-policies") {
    return { PolicyNames: ["AssumeDedicatedSutraCustomerRoles"], IsTruncated: false };
  }
  if (args[1] === "get-role-policy") {
    return {
      RoleName: "SutraLocalCollectorRole",
      PolicyName: "AssumeDedicatedSutraCustomerRoles",
      PolicyDocument: {
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
      },
    };
  }
  if (args[1] === "list-attached-role-policies") {
    return { AttachedPolicies: [], IsTruncated: false };
  }
  const roleName = args[args.indexOf("--role-name") + 1];
  if (roleName === "SutraLocalCollectorRole") {
    return {
      Role: {
        Arn: COLLECTOR_ROLE,
        RoleName: "SutraLocalCollectorRole",
        Path: "/sutra/",
        Description: "Short-lived source role used only by the local Sutra sandbox collector.",
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [{
            Sid: "FederatedOperatorOnly",
            Effect: "Allow",
            Principal: { AWS: OPERATOR_ROLE },
            Action: "sts:AssumeRole",
          }],
        },
        Tags: [
          { Key: "sutra:access-mode", Value: "assume-role-only" },
          { Key: "sutra:environment", Value: "disposable-sandbox" },
          { Key: "sutra:managed-by", Value: "cloudformation" },
          { Key: "sutra:stack-owner", Value: "sutra-live-aws-preparation" },
          { Key: "sutra:stack-purpose", Value: "local-collector-source-role" },
          { Key: "sutra:template-sha256", Value: TEMPLATE_DIGEST },
        ],
        PermissionsBoundary: {
          PermissionsBoundaryType: "Policy",
          PermissionsBoundaryArn: COLLECTOR_BOUNDARY,
        },
      },
    };
  }
  return { Role: { Arn: OPERATOR_ROLE, RoleName: "AWSReservedSSO_Admin_abc" } };
}

test("live AWS preparation requires SSO profiles, acknowledgement, and safe inputs", () => {
  assert.deepEqual(validateLiveAwsPreparationEnvironment(preparationEnvironment()), {
    operatorProfile: OPERATOR_PROFILE,
    collectorProfile: COLLECTOR_PROFILE,
    region: "us-east-1",
    stackName: "sutra-local-collector",
  });
  assert.throws(
    () => validateLiveAwsPreparationEnvironment(preparationEnvironment({ SUTRA_LIVE_AWS_SETUP_ACK: undefined })),
    /SUTRA_LIVE_AWS_SETUP_ACK/u,
  );
  assert.throws(
    () => validateLiveAwsPreparationEnvironment(preparationEnvironment({ AWS_ACCESS_KEY_ID: "must-not-leak" })),
    (error) => error instanceof Error && error.message.includes("AWS_ACCESS_KEY_ID") && !error.message.includes("must-not-leak"),
  );
  assert.throws(
    () => validateLiveAwsPreparationEnvironment(preparationEnvironment({ SUTRA_COLLECTOR_PROFILE: OPERATOR_PROFILE })),
    /must be different/u,
  );
  assert.throws(
    () => validateLiveAwsPreparationEnvironment(preparationEnvironment({ AWS_ENDPOINT_URL_STS: "https://attacker.invalid" })),
    (error) => error instanceof Error && error.message.includes("AWS_ENDPOINT_URL_STS") && !error.message.includes("attacker.invalid"),
  );
  assert.throws(
    () => validateLiveAwsPreparationEnvironment(preparationEnvironment({ AWS_REGION: "us-gov-west-1" })),
    /commercial AWS Regions only/u,
  );
});

test("AWS identity parsers require exact account, partition, and dedicated roles", () => {
  const identity = parseOperatorIdentity({
    Account: ACCOUNT_ID,
    Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
  });
  assert.deepEqual(identity, {
    accountId: ACCOUNT_ID,
    partition: "aws",
    roleName: "AWSReservedSSO_Admin_abc",
  });
  assert.equal(parseExactOperatorRole({
    Role: { Arn: OPERATOR_ROLE, RoleName: "AWSReservedSSO_Admin_abc" },
  }, identity), OPERATOR_ROLE);
  assert.equal(parseCollectorRoleArn({
    Stacks: [{ Outputs: [{ OutputKey: "CollectorRoleArn", OutputValue: COLLECTOR_ROLE }] }],
  }, ACCOUNT_ID, "aws"), COLLECTOR_ROLE);
  assert.throws(
    () => parseOperatorIdentity({ Account: ACCOUNT_ID, Arn: `arn:aws:iam::${ACCOUNT_ID}:user/demo` }),
    /assumed IAM role/u,
  );
  assert.throws(
    () => parseCollectorRoleArn({ Stacks: [{ Outputs: [{ OutputKey: "CollectorRoleArn", OutputValue: `arn:aws:iam::${ACCOUNT_ID}:role/Admin` }] }] }, ACCOUNT_ID, "aws"),
    /unexpected IAM role/u,
  );
});

test("collector boundary attestation requires the exact policy, default version, and role attachment", () => {
  assert.deepEqual(
    attestCollectorBoundaryPolicyDocument(COLLECTOR_BOUNDARY_DOCUMENT),
    COLLECTOR_BOUNDARY_DOCUMENT,
  );
  const policy = parseCollectorBoundaryPolicy(capturedIamResponse(["iam", "get-policy"]), ACCOUNT_ID, "aws");
  assert.deepEqual(policy, { arn: COLLECTOR_BOUNDARY, versionId: "v1" });
  assert.doesNotThrow(() => attestCollectorBoundaryPolicyVersion(
    capturedIamResponse(["iam", "get-policy-version"]),
    "v1",
  ));
  assert.doesNotThrow(() => attestCollectorRoleBoundary(
    capturedIamResponse(["iam", "get-role", "--role-name", "SutraLocalCollectorRole"]),
    ACCOUNT_ID,
    "aws",
  ));

  assert.throws(
    () => attestCollectorBoundaryPolicyDocument({
      ...COLLECTOR_BOUNDARY_DOCUMENT,
      Statement: [{ ...COLLECTOR_BOUNDARY_DOCUMENT.Statement[0], Action: "*" }],
    }),
    /does not match/u,
  );
  assert.throws(
    () => attestCollectorBoundaryPolicyVersion({
      PolicyVersion: {
        Document: COLLECTOR_BOUNDARY_DOCUMENT,
        VersionId: "v2",
        IsDefaultVersion: false,
      },
    }, "v2"),
    /invalid/u,
  );
  assert.throws(
    () => parseCollectorBoundaryPolicy({
      Policy: {
        ...capturedIamResponse(["iam", "get-policy"]).Policy,
        Arn: "arn:aws:iam::999988887777:policy/SutraCollectorBoundary",
      },
    }, ACCOUNT_ID, "aws"),
    /invalid/u,
  );
  assert.throws(
    () => attestCollectorRoleBoundary({
      Role: {
        ...capturedIamResponse(["iam", "get-role", "--role-name", "SutraLocalCollectorRole"]).Role,
        PermissionsBoundary: undefined,
      },
    }, ACCOUNT_ID, "aws"),
    /does not use/u,
  );
});

test("collector role attestation requires exact live IAM state, not CloudFormation drift metadata", () => {
  const role = capturedIamResponse(["iam", "get-role", "--role-name", "SutraLocalCollectorRole"]);
  assert.doesNotThrow(() => attestCollectorRoleDefinition(role, {
    accountId: ACCOUNT_ID,
    operatorRoleArn: OPERATOR_ROLE,
    partition: "aws",
    templateDigest: TEMPLATE_DIGEST,
  }));
  assert.doesNotThrow(() => attestCollectorRoleInlinePolicyNames(
    capturedIamResponse(["iam", "list-role-policies"]),
  ));
  assert.doesNotThrow(() => attestCollectorRoleInlinePolicy(
    capturedIamResponse(["iam", "get-role-policy"]),
    ACCOUNT_ID,
  ));
  assert.doesNotThrow(() => attestCollectorRoleHasNoManagedPolicies(
    capturedIamResponse(["iam", "list-attached-role-policies"]),
  ));

  for (const changedRole of [
    { ...role.Role, MaxSessionDuration: 7200 },
    { ...role.Role, AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] } },
    { ...role.Role, Tags: [...role.Role.Tags, { Key: "unexpected", Value: "tag" }] },
  ]) {
    assert.throws(() => attestCollectorRoleDefinition({ Role: changedRole }, {
      accountId: ACCOUNT_ID,
      operatorRoleArn: OPERATOR_ROLE,
      partition: "aws",
      templateDigest: TEMPLATE_DIGEST,
    }), /reviewed live IAM contract|tags do not exactly match/u);
  }
  assert.throws(
    () => attestCollectorRoleInlinePolicyNames({
      PolicyNames: ["AssumeDedicatedSutraCustomerRoles", "Escalate"],
      IsTruncated: false,
    }),
    /exactly its reviewed inline policy/u,
  );
  assert.throws(
    () => attestCollectorRoleInlinePolicy({
      ...capturedIamResponse(["iam", "get-role-policy"]),
      PolicyDocument: { Version: "2012-10-17", Statement: [] },
    }, ACCOUNT_ID),
    /does not match/u,
  );
  assert.throws(
    () => attestCollectorRoleHasNoManagedPolicies({
      AttachedPolicies: [{ PolicyName: "AdministratorAccess", PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }],
      IsTruncated: false,
    }),
    /must not have attached managed policies/u,
  );
});

test("existing stack attestation requires exact ownership, template, parameters, and role resource", () => {
  assert.doesNotThrow(() => attestExistingSourceStack({
    Stacks: [existingStack()],
  }, EXPECTED_STACK));
  assert.doesNotThrow(() => attestExistingSourceTemplate({
    TemplateBody: TEMPLATE_BODY,
  }, TEMPLATE_DIGEST));
  assert.doesNotThrow(() => attestExistingSourceResources({
    StackResourceSummaries: [{
      LogicalResourceId: "CollectorRole",
      PhysicalResourceId: "SutraLocalCollectorRole",
      ResourceType: "AWS::IAM::Role",
      ResourceStatus: "CREATE_COMPLETE",
      DriftInformation: { StackResourceDriftStatus: "IN_SYNC" },
    }],
  }));

  assert.throws(
    () => attestExistingSourceStack({
      Stacks: [existingStack({ Tags: [] })],
    }, EXPECTED_STACK),
    /not owned by this exact Sutra source-role template/u,
  );
  assert.throws(
    () => attestExistingSourceStack({
      Stacks: [existingStack({
        Parameters: [
          { ParameterKey: "OperatorRoleArn", ParameterValue: OPERATOR_ROLE },
          { ParameterKey: "CollectorRoleName", ParameterValue: "UnrelatedRole" },
        ],
      })],
    }, EXPECTED_STACK),
    /parameters do not exactly match/u,
  );
  assert.throws(
    () => attestExistingSourceTemplate({ TemplateBody: `${TEMPLATE_BODY}# changed\n` }, TEMPLATE_DIGEST),
    /does not match/u,
  );
  assert.throws(
    () => attestExistingSourceResources({
      StackResourceSummaries: [
        {
          LogicalResourceId: "CollectorRole",
          PhysicalResourceId: "SutraLocalCollectorRole",
          ResourceType: "AWS::IAM::Role",
          ResourceStatus: "CREATE_COMPLETE",
        },
        {
          LogicalResourceId: "UnrelatedBucket",
          PhysicalResourceId: "unrelated",
          ResourceType: "AWS::S3::Bucket",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    }),
    /exactly one/u,
  );
});

test("only the exact CloudFormation absent-stack error permits creation", () => {
  const absent = new Error(
    "aws exited 255: An error occurred (ValidationError) when calling the DescribeStacks operation: " +
      "Stack with id sutra-local-collector does not exist",
  );
  assert.equal(isExactStackNotFoundError(absent, "sutra-local-collector"), true);
  assert.equal(isExactStackNotFoundError(new Error("AccessDenied: not authorized"), "sutra-local-collector"), false);
  assert.equal(isExactStackNotFoundError(absent, "another-stack"), false);
  assert.equal(isExactStackNotFoundError(
    new Error(`${absent.message}; fallback to another stack`),
    "sutra-local-collector",
  ), false);
});

test("preparation deploys one source role, writes only role-profile settings, and verifies it", async () => {
  const calls = [];
  let identityCalls = 0;
  let deployed = false;
  const runCommand = async (command, args, options) => {
    calls.push({
      kind: "run",
      command,
      args,
      profile: options.environment.AWS_PROFILE,
      endpointKeys: Object.keys(options.environment).filter((key) => key.startsWith("AWS_ENDPOINT_URL")),
    });
    if (args[0] === "cloudformation" && args[1] === "deploy") deployed = true;
  };
  const captureCommand = async (command, args, options) => {
    calls.push({
      kind: "capture",
      command,
      args,
      profile: options.environment.AWS_PROFILE,
      endpointKeys: Object.keys(options.environment).filter((key) => key.startsWith("AWS_ENDPOINT_URL")),
    });
    if (args[0] === "iam") {
      return JSON.stringify(capturedIamResponse(args));
    }
    if (args[0] === "cloudformation") {
      if (!deployed && args[1] === "describe-stacks") {
        throw new Error(
          "aws exited 255: An error occurred (ValidationError) when calling the DescribeStacks operation: " +
            "Stack with id sutra-local-collector does not exist",
        );
      }
      return JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: "CollectorRoleArn", OutputValue: COLLECTOR_ROLE }] }] });
    }
    identityCalls += 1;
    return JSON.stringify(identityCalls === 1
      ? { Account: ACCOUNT_ID, Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session` }
      : { Account: ACCOUNT_ID, Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/SutraLocalCollectorRole/session` });
  };
  const validatedProfiles = [];
  const result = await prepareLiveAws({
    environment: preparationEnvironment({ AWS_ENDPOINT_URL: "", AWS_ENDPOINT_URL_STS: "" }),
    root: "/safe/repository",
    runCommand,
    captureCommand,
    validateProfile: async ({ environment }) => {
      validatedProfiles.push(environment.AWS_PROFILE);
      return validatedProfileSource(environment.AWS_PROFILE);
    },
    secureFiles: async () => undefined,
    readTemplate: async () => TEMPLATE_BODY,
    readBoundaryPolicy: async () => JSON.stringify(COLLECTOR_BOUNDARY_DOCUMENT),
  });

  assert.equal(result.collectorRoleArn, COLLECTOR_ROLE);
  assert.equal(result.collectorBoundaryPolicyArn, COLLECTOR_BOUNDARY);
  assert.deepEqual(validatedProfiles, [OPERATOR_PROFILE, COLLECTOR_PROFILE]);
  const login = calls.find((call) => call.args[0] === "sso" && call.args[1] === "login");
  assert.equal(login?.args[login.args.indexOf("--profile") + 1], SSO_LOGIN_PROFILE);
  assert.equal(login?.profile, SSO_LOGIN_PROFILE);
  assert.ok(calls.some((call) =>
    call.kind === "capture" && call.args[0] === "sts" && call.profile === OPERATOR_PROFILE
  ));
  assert.ok(calls.some((call) => call.args[0] === "iam" && call.args[1] === "get-policy"));
  assert.ok(calls.some((call) =>
    call.args[0] === "iam" && call.args[1] === "get-role" &&
    call.args.includes("SutraLocalCollectorRole")
  ));
  assert.ok(calls.some((call) => call.args[1] === "list-role-policies"));
  assert.ok(calls.some((call) => call.args[1] === "get-role-policy"));
  assert.ok(calls.some((call) => call.args[1] === "list-attached-role-policies"));
  assert.equal(calls.every((call) => call.endpointKeys.length === 0), true);
  const deploy = calls.find((call) => call.args[0] === "cloudformation" && call.args[1] === "deploy");
  assert.ok(deploy);
  assert.ok(deploy.args.includes("sutra:stack-owner=sutra-live-aws-preparation"));
  assert.ok(deploy.args.includes("sutra:stack-purpose=local-collector-source-role"));
  assert.ok(deploy.args.includes(`sutra:template-sha256=${TEMPLATE_DIGEST}`));
  const configuredKeys = calls
    .filter((call) => call.args[0] === "configure")
    .map((call) => call.args[2]);
  assert.deepEqual(configuredKeys, [
    "role_arn", "source_profile", "role_session_name", "duration_seconds", "region", "output",
  ]);
  assert.equal(calls.some((call) => call.args.join(" ").includes("access_key")), false);
  assert.equal(calls.some((call) => call.args.join(" ").includes("secret")), false);
});

test("preparation refuses to configure a collector profile when its boundary is missing", async () => {
  const calls = [];
  let deployed = false;
  const runCommand = async (command, args) => {
    calls.push({ kind: "run", command, args });
    if (args[0] === "cloudformation" && args[1] === "deploy") deployed = true;
  };
  const captureCommand = async (command, args) => {
    calls.push({ kind: "capture", command, args });
    if (args[0] === "iam") {
      const response = capturedIamResponse(args);
      if (args[1] === "get-role" && args.includes("SutraLocalCollectorRole")) {
        response.Role.PermissionsBoundary = undefined;
      }
      return JSON.stringify(response);
    }
    if (args[0] === "cloudformation") {
      if (!deployed && args[1] === "describe-stacks") {
        throw new Error(
          "aws exited 255: An error occurred (ValidationError) when calling the DescribeStacks operation: " +
            "Stack with id sutra-local-collector does not exist",
        );
      }
      return JSON.stringify({
        Stacks: [{ Outputs: [{ OutputKey: "CollectorRoleArn", OutputValue: COLLECTOR_ROLE }] }],
      });
    }
    return JSON.stringify({
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
    });
  };

  await assert.rejects(() => prepareLiveAws({
    environment: preparationEnvironment(),
    root: "/safe/repository",
    runCommand,
    captureCommand,
    validateProfile: async ({ environment }) =>
      validatedProfileSource(environment.AWS_PROFILE),
    secureFiles: async () => undefined,
    readTemplate: async () => TEMPLATE_BODY,
    readBoundaryPolicy: async () => JSON.stringify(COLLECTOR_BOUNDARY_DOCUMENT),
  }), /does not match its reviewed live IAM contract/u);
  assert.equal(calls.some((call) => call.args[0] === "configure"), false);
});

test("preparation reuses only a completely attested existing stack", async () => {
  const calls = [];
  let identityCalls = 0;
  const runCommand = async (command, args, options) => {
    calls.push({ kind: "run", command, args, profile: options.environment.AWS_PROFILE });
  };
  const captureCommand = async (command, args, options) => {
    calls.push({ kind: "capture", command, args, profile: options.environment.AWS_PROFILE });
    if (args[0] === "iam") {
      return JSON.stringify(capturedIamResponse(args));
    }
    if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
      return JSON.stringify({ Stacks: [existingStack()] });
    }
    if (args[0] === "cloudformation" && args[1] === "get-template") {
      return JSON.stringify({ TemplateBody: TEMPLATE_BODY });
    }
    if (args[0] === "cloudformation" && args[1] === "list-stack-resources") {
      return JSON.stringify({
        StackResourceSummaries: [{
          LogicalResourceId: "CollectorRole",
          PhysicalResourceId: "SutraLocalCollectorRole",
          ResourceType: "AWS::IAM::Role",
          ResourceStatus: "CREATE_COMPLETE",
          DriftInformation: { StackResourceDriftStatus: "NOT_CHECKED" },
        }],
      });
    }
    identityCalls += 1;
    return JSON.stringify(identityCalls === 1
      ? { Account: ACCOUNT_ID, Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session` }
      : { Account: ACCOUNT_ID, Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/SutraLocalCollectorRole/session` });
  };

  const result = await prepareLiveAws({
    environment: preparationEnvironment(),
    root: "/safe/repository",
    runCommand,
    captureCommand,
    validateProfile: async ({ environment }) =>
      validatedProfileSource(environment.AWS_PROFILE),
    secureFiles: async () => undefined,
    readTemplate: async () => TEMPLATE_BODY,
    readBoundaryPolicy: async () => JSON.stringify(COLLECTOR_BOUNDARY_DOCUMENT),
  });

  assert.equal(result.collectorRoleArn, COLLECTOR_ROLE);
  const operations = calls
    .filter((call) => call.args[0] === "cloudformation")
    .map((call) => call.args[1]);
  assert.deepEqual(operations.slice(0, 4), [
    "describe-stacks", "get-template", "list-stack-resources", "deploy",
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call.args[0] === "iam")
      .map((call) => call.args[1])
      .filter((operation) => [
        "list-role-policies",
        "get-role-policy",
        "list-attached-role-policies",
      ].includes(operation)),
    ["list-role-policies", "get-role-policy", "list-attached-role-policies"],
  );
});

test("preparation stops before deploy when an existing stack is unrelated", async () => {
  let deployed = false;
  const runCommand = async (_command, args) => {
    if (args[0] === "cloudformation" && args[1] === "deploy") deployed = true;
  };
  const captureCommand = async (_command, args) => {
    if (args[0] === "iam") {
      return JSON.stringify(capturedIamResponse(args));
    }
    if (args[0] === "cloudformation") {
      return JSON.stringify({ Stacks: [existingStack({ Tags: [] })] });
    }
    return JSON.stringify({
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
    });
  };

  await assert.rejects(() => prepareLiveAws({
    environment: preparationEnvironment(),
    root: "/safe/repository",
    runCommand,
    captureCommand,
    validateProfile: async ({ environment }) =>
      validatedProfileSource(environment.AWS_PROFILE),
    secureFiles: async () => undefined,
    readTemplate: async () => TEMPLATE_BODY,
    readBoundaryPolicy: async () => JSON.stringify(COLLECTOR_BOUNDARY_DOCUMENT),
  }), /not owned by this exact Sutra source-role template/u);
  assert.equal(deployed, false);
});
