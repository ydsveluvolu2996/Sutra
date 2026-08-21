import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

const template = await read("deploy/ec2/cloudformation-single-node.yaml");
const compose = await read("deploy/ec2/compose.prod.yaml");
const setup = await read("scripts/setup-local-pilot.mjs");
const bootstrap = await read("deploy/ec2/bootstrap.sh");
const redeploy = await read("deploy/ec2/redeploy.sh");
const releaseUpdate = await read("deploy/ec2/release-update.sh");
const syncScript = resolve(root, "deploy/ec2/sync-evidence-runtime.sh");

function resourceSection(name, nextName) {
  const start = template.indexOf(`  ${name}:\n`);
  const end = template.indexOf(`  ${nextName}:\n`, start + 1);
  assert.notEqual(start, -1, `${name} resource must exist`);
  assert.notEqual(end, -1, `${nextName} resource must follow ${name}`);
  return template.slice(start, end);
}

test("single-node onboarding provisions retained private KMS evidence storage", () => {
  const key = resourceSection("EvidenceKey", "EvidenceBucket");
  const bucket = resourceSection("EvidenceBucket", "EvidenceBucketPolicy");
  const bucketPolicy = resourceSection("EvidenceBucketPolicy", "EvidenceRuntimeConfigParameter");

  assert.match(key, /DeletionPolicy: Retain/u);
  assert.match(key, /UpdateReplacePolicy: Retain/u);
  assert.match(key, /EnableKeyRotation: true/u);
  assert.match(bucket, /DeletionPolicy: Retain/u);
  assert.match(bucket, /SSEAlgorithm: aws:kms/u);
  assert.match(bucket, /VersioningConfiguration: \{ Status: Enabled \}/u);
  for (const setting of ["BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets"]) {
    assert.match(bucket, new RegExp(`${setting}: true`, "u"));
  }
  assert.match(bucket, /Prefix: evidence\/v1\//u);
  assert.match(bucket, /ExpirationInDays: \{ Ref: EvidenceRetentionDays \}/u);
  assert.match(bucketPolicy, /DenyUnencryptedTransport/u);
  assert.match(bucketPolicy, /DenyUploadsWithoutKms/u);
  assert.match(bucketPolicy, /DenyEvidenceEncryptedWithUnexpectedKey/u);
});

test("single-node workload access is exact-prefix, no-list, no-delete and S3-bound KMS", () => {
  const role = resourceSection("InstanceRole", "NotificationEmailSendingPolicy");
  assert.match(role, /PolicyName: ReadWriteOnlyOpaqueManagedEvidence/u);
  assert.match(role, /s3:GetObject/u);
  assert.match(role, /s3:PutObject/u);
  assert.match(role, /\$\{EvidenceBucket\.Arn\}\/evidence\/v1\/\*/u);
  assert.doesNotMatch(role, /s3:DeleteObject|s3:ListBucket/u);
  assert.match(role, /kms:ViaService:/u);
  assert.match(role, /s3\.\$\{AWS::Region\}\.amazonaws\.com/u);
  assert.match(role, /PolicyName: ReadOnlyExactEvidenceRuntimeConfig/u);
  assert.match(role, /Action: ssm:GetParameter/u);
  assert.match(role, /parameter\/sutra\/private-beta\/evidence-config/u);
  assert.doesNotMatch(role, /ssm:GetParametersByPath/u);
});

test("host and Worker runtime receive all four managed evidence values before startup", () => {
  for (const name of [
    "SUTRA_EVIDENCE_BACKEND",
    "SUTRA_EVIDENCE_BUCKET",
    "SUTRA_EVIDENCE_KMS_KEY_ARN",
    "SUTRA_EVIDENCE_RETENTION_DAYS",
  ]) {
    assert.match(compose, new RegExp(`^      ${name}:`, "mu"));
    assert.match(setup, new RegExp(`"${name}"`, "u"));
  }
  assert.ok(bootstrap.indexOf("sync-evidence-runtime.sh") < bootstrap.indexOf("ensure_cloudflared()"));
  assert.ok(redeploy.indexOf("sync-evidence-runtime.sh") < redeploy.indexOf('DOCKER="docker"'));
  assert.ok(
    releaseUpdate.indexOf('bash "$STAGE_ROOT/deploy/ec2/sync-evidence-runtime.sh"')
      < releaseUpdate.indexOf("# Render before touching"),
  );
});

async function withHostFiles(run) {
  const directory = await mkdtemp(resolve(tmpdir(), "sutra-evidence-sync-"));
  const binaryDirectory = resolve(directory, "bin");
  const environmentFile = resolve(directory, ".env.ec2");
  const dockerEnvironment = resolve(directory, "docker.env");
  const aws = resolve(binaryDirectory, "aws");
  try {
    await mkdir(binaryDirectory);
    await writeFile(aws, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "\${SUTRA_TEST_EVIDENCE_DESCRIPTOR:?}"\n`, "utf8");
    await chmod(aws, 0o755);
    await writeFile(environmentFile, [
      "SUTRA_DOMAIN=sutracmdb.com",
      "AWS_REGION=ap-south-1",
      "SUTRA_EVIDENCE_BACKEND=stale",
      "SUTRA_EVIDENCE_BUCKET=stale",
      "SUTRA_EVIDENCE_KMS_KEY_ARN=stale",
      "SUTRA_EVIDENCE_RETENTION_DAYS=30",
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(dockerEnvironment, "SUTRA_JOB_RUNNER_TOKEN=not-a-live-secret\n", { mode: 0o600 });
    await run({ directory, environmentFile, dockerEnvironment });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const validDescriptor = JSON.stringify({
  backend: "s3",
  bucket: "sutra-private-beta-evidence-test",
  kmsKeyArn: "arn:aws:kms:ap-south-1:738663485493:key/11111111-2222-3333-4444-555555555555",
  retentionDays: 365,
});

test("host sync atomically replaces stale identifiers without logging them", async () => {
  await withHostFiles(async ({ directory, environmentFile, dockerEnvironment }) => {
    const result = await execute("bash", [syncScript, environmentFile, dockerEnvironment], {
      env: {
        ...process.env,
        PATH: `${resolve(directory, "bin")}:${process.env.PATH}`,
        SUTRA_TEST_EVIDENCE_DESCRIPTOR: validDescriptor,
      },
    });
    const contents = await readFile(environmentFile, "utf8");
    assert.match(contents, /^SUTRA_EVIDENCE_BACKEND=s3$/mu);
    assert.match(contents, /^SUTRA_EVIDENCE_BUCKET=sutra-private-beta-evidence-test$/mu);
    assert.match(contents, /^SUTRA_EVIDENCE_KMS_KEY_ARN=arn:aws:kms:ap-south-1:738663485493:key\/11111111-2222-3333-4444-555555555555$/mu);
    assert.match(contents, /^SUTRA_EVIDENCE_RETENTION_DAYS=365$/mu);
    for (const name of ["BACKEND", "BUCKET", "KMS_KEY_ARN", "RETENTION_DAYS"]) {
      assert.equal((contents.match(new RegExp(`^SUTRA_EVIDENCE_${name}=`, "gmu")) ?? []).length, 1);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /sutra-private-beta-evidence-test|11111111-2222/u);
    assert.equal((await stat(environmentFile)).mode & 0o777, 0o600);
  });
});

test("host sync rejects malformed descriptors and later-env overrides without mutation", async () => {
  await withHostFiles(async ({ directory, environmentFile, dockerEnvironment }) => {
    const before = await readFile(environmentFile, "utf8");
    const baseEnvironment = {
      ...process.env,
      PATH: `${resolve(directory, "bin")}:${process.env.PATH}`,
    };
    await assert.rejects(execute("bash", [syncScript, environmentFile, dockerEnvironment], {
      env: {
        ...baseEnvironment,
        SUTRA_TEST_EVIDENCE_DESCRIPTOR: JSON.stringify({
          backend: "s3",
          bucket: "sutra-private-beta-evidence-test",
          kmsKeyArn: "arn:aws:kms:us-east-1:738663485493:key/11111111-2222-3333-4444-555555555555",
          retentionDays: 365,
        }),
      },
    }), /another Region/u);
    assert.equal(await readFile(environmentFile, "utf8"), before);

    await writeFile(dockerEnvironment, "SUTRA_EVIDENCE_BUCKET=unsafe-override\n", { mode: 0o600 });
    await assert.rejects(execute("bash", [syncScript, environmentFile, dockerEnvironment], {
      env: { ...baseEnvironment, SUTRA_TEST_EVIDENCE_DESCRIPTOR: validDescriptor },
    }), /must not be overridden/u);
    assert.equal(await readFile(environmentFile, "utf8"), before);
  });
});
