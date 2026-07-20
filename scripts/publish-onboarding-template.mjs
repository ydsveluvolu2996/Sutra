import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  AWS_CUSTOMER_ROLE_TEMPLATE_VERSION,
} from "../lib/aws-template-contract.ts";
import {
  assertNoAwsEndpointOverrideEnvironment,
  assertNoStaticAwsCredentialEnvironment,
  resolveValidatedSsoLoginProfile,
  scrubAwsEndpointOverrideEnvironment,
  validateAwsProfileCredentialSource,
} from "./live-aws-host.mjs";

export const LIVE_AWS_TEMPLATE_PUBLISH_ACKNOWLEDGEMENT =
  "I_ACKNOWLEDGE_THIS_PUBLISHES_A_PUBLIC_READ_ONLY_TEMPLATE";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REGION = /^[a-z]{2}-[a-z0-9-]+-[0-9]+$/u;
// Dots are intentionally rejected: virtual-hosted S3 URLs for dotted bucket
// names do not match the standard wildcard TLS certificate.
const BUCKET = /^(?!xn--)(?!sthree-)(?!amzn-s3-demo-)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const STS_ROLE = /^arn:aws:sts::([0-9]{12}):assumed-role\/[A-Za-z0-9_+=,.@-]{1,64}\/[A-Za-z0-9_+=,.@-]{1,64}$/u;
const BUCKET_PURPOSE_TAGS = Object.freeze([
  Object.freeze({ Key: "sutra:managed-by", Value: "template-publisher-v1" }),
  Object.freeze({ Key: "sutra:purpose", Value: "customer-role-quick-create" }),
]);

function exactValue(environment, key, fallback) {
  const value = environment[key] ?? fallback;
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    /[\0\r\n]/u.test(value)
  ) throw new Error(`${key} must be a non-empty value without surrounding whitespace`);
  return value;
}

export function validateTemplatePublishEnvironment(environment) {
  if (
    environment.SUTRA_LIVE_AWS_TEMPLATE_ACK !==
    LIVE_AWS_TEMPLATE_PUBLISH_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      `Set SUTRA_LIVE_AWS_TEMPLATE_ACK exactly to ${LIVE_AWS_TEMPLATE_PUBLISH_ACKNOWLEDGEMENT}`,
    );
  }
  assertNoStaticAwsCredentialEnvironment(environment);
  assertNoAwsEndpointOverrideEnvironment(environment);
  const profile = exactValue(environment, "AWS_PROFILE");
  const region = exactValue(
    environment,
    "AWS_REGION",
    environment.AWS_DEFAULT_REGION ?? "us-east-1",
  );
  const configuredBucket = environment.SUTRA_TEMPLATE_BUCKET;
  if (!PROFILE_NAME.test(profile)) throw new Error("AWS_PROFILE must be a plain named profile");
  if (!REGION.test(region) || region.startsWith("us-gov-") || region.startsWith("cn-")) {
    throw new Error("The live quick-launch publisher currently supports commercial AWS Regions only");
  }
  if (configuredBucket !== undefined && !BUCKET.test(configuredBucket)) {
    throw new Error("SUTRA_TEMPLATE_BUCKET must be a valid lowercase S3 bucket name");
  }
  return { profile, region, configuredBucket };
}

function commandEnvironment(environment, profile, region) {
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
      else reject(new Error(
        `${command} exited ${signal ?? code}` +
        (captureOutput && stderr.trim() ? `: ${stderr.trim().slice(0, 1_000)}` : ""),
      ));
    });
  });
}

const defaultRun = (command, args, options) => spawnCommand(command, args, options, false);
const defaultCapture = (command, args, options) => spawnCommand(command, args, options, true);

function parseAccountIdentity(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("AWS STS did not return valid JSON");
  }
  const accountId = value?.Account;
  const arn = value?.Arn;
  if (
    typeof accountId !== "string" || !ACCOUNT_ID.test(accountId) ||
    typeof arn !== "string" || STS_ROLE.exec(arn)?.[1] !== accountId
  ) throw new Error("The template publisher requires an SSO-backed assumed-role identity");
  return accountId;
}

function parsePublishedObject(text, expectedChecksum) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("AWS S3 PutObject did not return valid JSON");
  }
  const versionId = value?.VersionId;
  const checksum = value?.ChecksumSHA256;
  if (
    typeof versionId !== "string" || versionId.length === 0 || versionId.length > 1_024 ||
    versionId === "null" || /[\0\r\n]/u.test(versionId) || checksum !== expectedChecksum
  ) {
    throw new Error("AWS S3 did not confirm the immutable template version and checksum");
  }
  return versionId;
}

function bucketPurposeTagging() {
  return JSON.stringify({ TagSet: BUCKET_PURPOSE_TAGS });
}

function assertBucketPurposeAttested(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Refusing to modify an existing S3 bucket without the Sutra purpose marker");
  }
  if (!Array.isArray(value?.TagSet) || value.TagSet.length > 50) {
    throw new Error("Refusing to modify an existing S3 bucket without the Sutra purpose marker");
  }
  const tags = new Map();
  for (const candidate of value.TagSet) {
    if (
      typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
      typeof candidate.Key !== "string" || typeof candidate.Value !== "string" ||
      tags.has(candidate.Key)
    ) {
      throw new Error("Refusing to modify an existing S3 bucket without the Sutra purpose marker");
    }
    tags.set(candidate.Key, candidate.Value);
  }
  if (BUCKET_PURPOSE_TAGS.some((tag) => tags.get(tag.Key) !== tag.Value)) {
    throw new Error("Refusing to modify an existing S3 bucket without the Sutra purpose marker");
  }
}

export function isExactMissingBucketError(error) {
  return error instanceof Error &&
    /\((?:404|NoSuchBucket)\)/u.test(error.message) &&
    /when calling the HeadBucket operation/u.test(error.message);
}

export function isExactMissingBucketTagSetError(error) {
  return error instanceof Error &&
    /\(NoSuchTagSet\)/u.test(error.message) &&
    /when calling the GetBucketTagging operation/u.test(error.message);
}

export function attestBucketIsEmpty(objectsText, versionsText) {
  let objects;
  let versions;
  try {
    objects = JSON.parse(objectsText);
    versions = JSON.parse(versionsText);
  } catch {
    throw new Error("Refusing to recover an unmarked S3 bucket without exact empty-bucket evidence");
  }
  if (
    typeof objects !== "object" || objects === null || Array.isArray(objects) ||
    typeof versions !== "object" || versions === null || Array.isArray(versions) ||
    objects?.KeyCount !== 0 ||
    objects?.IsTruncated === true ||
    (objects?.Contents !== undefined && !Array.isArray(objects.Contents)) ||
    (Array.isArray(objects?.Contents) && objects.Contents.length > 0) ||
    versions?.IsTruncated === true ||
    (versions?.Versions !== undefined && !Array.isArray(versions.Versions)) ||
    (Array.isArray(versions?.Versions) && versions.Versions.length > 0) ||
    (versions?.DeleteMarkers !== undefined && !Array.isArray(versions.DeleteMarkers)) ||
    (Array.isArray(versions?.DeleteMarkers) && versions.DeleteMarkers.length > 0)
  ) {
    throw new Error("Refusing to recover an unmarked S3 bucket unless it is empty");
  }
}

function bucketPolicy(bucket, objectKey) {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "PublicReadReviewedSutraOnboardingTemplate",
      Effect: "Allow",
      Principal: "*",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      Resource: `arn:aws:s3:::${bucket}/${objectKey}`,
    }],
  });
}

export async function publishOnboardingTemplate({
  environment,
  root,
  runCommand = defaultRun,
  captureCommand = defaultCapture,
  validateProfile = validateAwsProfileCredentialSource,
  fetchTemplate = fetch,
}) {
  const input = validateTemplatePublishEnvironment(environment);
  const awsEnvironment = commandEnvironment(environment, input.profile, input.region);
  const profileSource = await validateProfile({ environment: awsEnvironment });
  const ssoLoginProfile = resolveValidatedSsoLoginProfile(profileSource, input.profile);
  const ssoLoginEnvironment = commandEnvironment(
    environment,
    ssoLoginProfile,
    input.region,
  );
  await runCommand(
    "aws",
    ["sso", "login", "--profile", ssoLoginProfile, "--no-cli-auto-prompt"],
    { cwd: root, environment: ssoLoginEnvironment },
  );
  const accountId = parseAccountIdentity(await captureCommand(
    "aws",
    ["sts", "get-caller-identity", "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt"],
    { cwd: root, environment: awsEnvironment },
  ));
  const deterministicBucket = `sutra-onboarding-${accountId}-${input.region}`;
  const bucket = input.configuredBucket ?? deterministicBucket;
  if (!BUCKET.test(bucket)) throw new Error("The derived S3 template bucket name is invalid");

  const templatePath = resolve(root, "public/sutra-customer-onboarding-role.yaml");
  const contents = await readFile(templatePath);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== AWS_CUSTOMER_ROLE_TEMPLATE_SHA256) {
    throw new Error("The public onboarding template does not match its reviewed SHA-256 contract");
  }
  const checksumBase64 = createHash("sha256").update(contents).digest("base64");
  const objectKey = `templates/${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}/${digest}.yaml`;

  let bucketExists = true;
  try {
    await captureCommand(
      "aws",
      [
        "s3api", "head-bucket",
        "--bucket", bucket,
        "--expected-bucket-owner", accountId,
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: root, environment: awsEnvironment },
    );
  } catch (error) {
    if (!isExactMissingBucketError(error)) {
      throw new Error("Unable to prove the template bucket is absent in the signed-in AWS account");
    }
    bucketExists = false;
  }
  let tagBucket = false;
  if (!bucketExists) {
    const createArguments = ["s3api", "create-bucket", "--bucket", bucket];
    if (input.region !== "us-east-1") {
      createArguments.push(
        "--create-bucket-configuration",
        `LocationConstraint=${input.region}`,
      );
    }
    createArguments.push("--no-cli-pager", "--no-cli-auto-prompt");
    await runCommand("aws", createArguments, { cwd: root, environment: awsEnvironment });
    await captureCommand(
      "aws",
      [
        "s3api", "head-bucket",
        "--bucket", bucket,
        "--expected-bucket-owner", accountId,
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: root, environment: awsEnvironment },
    );
    tagBucket = true;
  } else {
    let tagging;
    try {
      tagging = await captureCommand(
        "aws",
        [
          "s3api", "get-bucket-tagging",
          "--bucket", bucket,
          "--expected-bucket-owner", accountId,
          "--output", "json",
          "--no-cli-pager",
          "--no-cli-auto-prompt",
        ],
        { cwd: root, environment: awsEnvironment },
      );
    } catch (error) {
      if (bucket !== deterministicBucket || !isExactMissingBucketTagSetError(error)) {
        throw new Error("Refusing to modify an existing S3 bucket without the Sutra purpose marker");
      }
      const [objects, versions] = await Promise.all([
        captureCommand(
          "aws",
          [
            "s3api", "list-objects-v2",
            "--bucket", bucket,
            "--max-keys", "1",
            "--expected-bucket-owner", accountId,
            "--output", "json",
            "--no-cli-pager",
            "--no-cli-auto-prompt",
          ],
          { cwd: root, environment: awsEnvironment },
        ),
        captureCommand(
          "aws",
          [
            "s3api", "list-object-versions",
            "--bucket", bucket,
            "--max-keys", "1",
            "--expected-bucket-owner", accountId,
            "--output", "json",
            "--no-cli-pager",
            "--no-cli-auto-prompt",
          ],
          { cwd: root, environment: awsEnvironment },
        ),
      ]);
      attestBucketIsEmpty(objects, versions);
      tagBucket = true;
    }
    if (!tagBucket) assertBucketPurposeAttested(tagging);
  }
  if (tagBucket) {
    await runCommand(
      "aws",
      [
        "s3api", "put-bucket-tagging",
        "--bucket", bucket,
        "--tagging", bucketPurposeTagging(),
        "--expected-bucket-owner", accountId,
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: root, environment: awsEnvironment },
    );
  }

  for (const args of [
    ["s3api", "put-bucket-ownership-controls", "--bucket", bucket, "--ownership-controls", "Rules=[{ObjectOwnership=BucketOwnerEnforced}]"],
    ["s3api", "put-public-access-block", "--bucket", bucket, "--public-access-block-configuration", "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"],
    ["s3api", "put-bucket-versioning", "--bucket", bucket, "--versioning-configuration", "Status=Enabled"],
    ["s3api", "put-bucket-encryption", "--bucket", bucket, "--server-side-encryption-configuration", "Rules=[{ApplyServerSideEncryptionByDefault={SSEAlgorithm=AES256},BucketKeyEnabled=false}]"],
    ["s3api", "put-bucket-policy", "--bucket", bucket, "--policy", bucketPolicy(bucket, objectKey)],
  ]) {
    await runCommand(
      "aws",
      [
        ...args,
        "--expected-bucket-owner", accountId,
        "--no-cli-pager",
        "--no-cli-auto-prompt",
      ],
      { cwd: root, environment: awsEnvironment },
    );
  }

  const versionId = parsePublishedObject(await captureCommand(
    "aws",
    [
      "s3api", "put-object",
      "--bucket", bucket,
      "--key", objectKey,
      "--body", templatePath,
      "--content-type", "application/yaml",
      "--cache-control", "public,max-age=31536000,immutable",
      "--checksum-algorithm", "SHA256",
      "--checksum-sha256", checksumBase64,
      "--metadata", `template-version=${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION},template-sha256=${digest}`,
      "--expected-bucket-owner", accountId,
      "--output", "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    { cwd: root, environment: awsEnvironment },
  ), checksumBase64);

  const publishedUrl = new URL(
    `https://${bucket}.s3.${input.region}.amazonaws.com/${objectKey}`,
  );
  publishedUrl.searchParams.set("versionId", versionId);
  const url = publishedUrl.toString();
  const response = await fetchTemplate(url, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error("The published CloudFormation template is not publicly readable");
  const published = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(published).digest("hex") !== digest) {
    throw new Error("The publicly readable CloudFormation template failed digest verification");
  }

  return {
    accountId,
    bucket,
    region: input.region,
    objectKey,
    versionId,
    templateVersion: AWS_CUSTOMER_ROLE_TEMPLATE_VERSION,
    sha256: digest,
    url,
  };
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const result = await publishOnboardingTemplate({ environment: process.env, root });
  process.stdout.write("\nReviewed Sutra onboarding template published and digest-verified.\n");
  process.stdout.write(`Template: ${result.url}\n`);
  process.stdout.write("Use this non-secret value when starting the live app:\n");
  process.stdout.write(`SUTRA_CUSTOMER_ROLE_TEMPLATE_URL='${result.url}'\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Template publishing failed";
    process.stderr.write(`Sutra template publishing failed: ${message}\n`);
    process.exitCode = 1;
  });
}
