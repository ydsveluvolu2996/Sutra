import assert from "node:assert/strict";
import test from "node:test";

import {
  AwsScanInstanceOperations,
  ScanInstanceOperationsError,
  buildScanUserData,
  findingsPrefix,
  type ReadFindingsObject,
  type ScanInstanceSettings,
} from "../src/scan-instance-operations.js";

const SETTINGS: ScanInstanceSettings = {
  amiId: "ami-0abcdef1234567890",
  instanceType: "t3.medium",
  subnetId: "subnet-0a010828a2ca84cdd",
  securityGroupId: "sg-015790dfd771987fb",
  instanceProfileArn: "arn:aws:iam::738663485493:instance-profile/sutra/ScannerInstanceProfile",
  findingsBucket: "sutra-agentless-scan-findingsbucket-5at3eakxktgc",
  scannerImage: "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/agentless-scanner@sha256:"
    + "7c525ef4a8deb23a3ea4d9f1a232244b3054241a2601c74e3fe32d1ed81fefc6",
  region: "ap-south-1",
  runId: "scan_01HXYZABCDEF",
};
const VOLUME_ID = "vol-0123456789abcdef0";

const operations = (
  overrides: Partial<ScanInstanceSettings> = {},
  readObject: ReadFindingsObject = async () => null,
) =>
  new AwsScanInstanceOperations({
    settings: { ...SETTINGS, ...overrides },
    ec2: () => { throw new Error("no EC2 call expected in this test"); },
    readObject,
  });

/**
 * The user-data runs as root on a host with a customer's disk attached. These are
 * the properties that keep that acceptable, asserted rather than assumed.
 */
test("the user-data embeds no credentials and pipes the registry password", () => {
  const script = buildScanUserData(SETTINGS, VOLUME_ID);
  assert.doesNotMatch(script, /AKIA|aws_secret_access_key|SecretAccessKey/iu, "no static credentials");
  assert.match(script, /get-login-password[\s\S]*--password-stdin/u, "the registry password is piped, never an argument");
});

test("the host resolves the exact EBS volume and grants only its selected device read-only", () => {
  const script = buildScanUserData(SETTINGS, VOLUME_ID);
  assert.match(script, /VOLUME_ID=vol-0123456789abcdef0/u);
  assert.match(script, /VOLUME_SERIAL=vol0123456789abcdef0/u);
  assert.match(script, /lsblk -dn -o PATH,TYPE,SERIAL/u);
  assert.match(script, /serial == target/u);
  assert.match(script, /publish_refusal TARGET_VOLUME_NOT_FOUND/u);
  assert.match(script, /publish_refusal TARGET_VOLUME_AMBIGUOUS/u);
  assert.match(script, /publish_refusal TARGET_VOLUME_PARTITIONS_AMBIGUOUS/u);
  assert.match(script, /--device "\$SCAN_DEVICE":\/dev\/sutra-scan-device:r/u);
  assert.match(script, /SUTRA_SCAN_DEVICE=\/dev\/sutra-scan-device/u);
  assert.doesNotMatch(script, /-v \/dev:\/dev/u);
  assert.doesNotMatch(script, /\/dev:\/dev/u);
});

test("the container gets only SYS_ADMIN, no network, and no privileged mode", () => {
  const script = buildScanUserData(SETTINGS, VOLUME_ID);
  assert.match(script, /--network none/u);
  assert.match(script, /--cap-drop ALL/u);
  assert.match(script, /--cap-add SYS_ADMIN/u);
  assert.match(script, /--security-opt no-new-privileges/u);
  // Asserted against the docker invocation itself, not the whole file: the flag
  // must never be PASSED. It also must not appear anywhere as text, since a host
  // scanner reading this script cannot tell a comment from a command.
  const runLine = script.slice(script.indexOf("docker run"), script.indexOf("STATUS=$?"));
  assert.doesNotMatch(runLine, /--privileged/u, "privileged would discard the whole containment argument");
  assert.doesNotMatch(script, /--privileged/u, "not even in a comment");
});

test("the instance shuts down on every path, including failure", () => {
  const script = buildScanUserData(SETTINGS, VOLUME_ID);
  // Set as a trap on EXIT, so an early `exit 1` still halts and stops billing.
  assert.match(script, /trap 'shutdown -h now' EXIT/u);
  assert.ok(
    script.indexOf("trap 'shutdown -h now' EXIT") < script.indexOf("docker run"),
    "the trap must be armed before anything can fail",
  );
});

test("the private runtime never installs packages from public repositories", () => {
  const script = buildScanUserData(SETTINGS, VOLUME_ID);
  assert.doesNotMatch(script, /\b(?:dnf|yum|apt-get)\s+install\b/u);
  assert.match(script, /command -v docker/u);
  assert.match(script, /command -v aws/u);
  assert.match(script, /publish_refusal HOST_PREREQUISITES_MISSING/u);
});

test("a failure publishes a refusal, so no findings and a refusal never look alike", () => {
  const script = buildScanUserData(SETTINGS, VOLUME_ID);
  for (const code of [
    "TARGET_VOLUME_NOT_FOUND",
    "TARGET_VOLUME_AMBIGUOUS",
    "TARGET_VOLUME_PARTITIONS_AMBIGUOUS",
    "TARGET_DEVICE_INVALID",
    "HOST_PREREQUISITES_MISSING",
    "DOCKER_UNAVAILABLE",
    "ECR_LOGIN_FAILED",
    "IMAGE_PULL_FAILED",
    "SCANNER_FAILED",
  ]) {
    assert.match(script, new RegExp(`publish_refusal ${code}`, "u"), `${code} must be published`);
  }
  assert.match(script, /refusal\.json/u);
});

test("an invalid EBS volume identity is refused before user-data is created", () => {
  assert.throws(
    () => buildScanUserData(SETTINGS, "/dev/sdf"),
    (error: unknown) =>
      error instanceof ScanInstanceOperationsError && error.code === "VOLUME_ID_INVALID",
  );
});

test("the findings prefix is per-run, so one scan cannot read another's", () => {
  assert.equal(findingsPrefix("scan_01HXYZABCDEF"), "scans/scan_01HXYZABCDEF");
  assert.throws(() => findingsPrefix("../../etc"), (e: unknown) =>
    e instanceof ScanInstanceOperationsError && e.code === "RUN_ID_INVALID");
});

test("malformed infrastructure ids are refused at construction, before a snapshot exists", () => {
  for (const [override, code] of [
    [{ amiId: "not-an-ami" }, "AMI_INVALID"],
    [{ subnetId: "subnet-zzz" }, "SUBNET_INVALID"],
    [{ securityGroupId: "sg-zzz" }, "SECURITY_GROUP_INVALID"],
    [{ findingsBucket: "Not A Bucket" }, "BUCKET_INVALID"],
    [{ scannerImage: "sutra/agentless-scanner:0.1.0" }, "SCANNER_IMAGE_NOT_PINNED"],
  ] as const) {
    assert.throws(
      () => operations(override),
      (e: unknown) => e instanceof ScanInstanceOperationsError && e.code === code,
      `${code} must be refused`,
    );
  }
});

test("an unparseable findings object is refused, never read as an empty result", async () => {
  const ops = operations({}, async () => "not json at all");
  await assert.rejects(
    () => ops.readPublishedFindings(),
    (e: unknown) => e instanceof ScanInstanceOperationsError && e.code === "FINDINGS_UNPARSEABLE",
  );
});

test("a findings object that is not a list is refused for the same reason", async () => {
  const ops = operations({}, async () => JSON.stringify({ findings: "lots" }));
  await assert.rejects(
    () => ops.readPublishedFindings(),
    (e: unknown) => e instanceof ScanInstanceOperationsError && e.code === "FINDINGS_NOT_A_LIST",
  );
});

test("absent findings read as null (still running), not as an empty list", async () => {
  assert.equal(await operations({}, async () => null).readPublishedFindings(), null);
});

test("an unparseable refusal is still surfaced as a refusal", async () => {
  const ops = operations({}, async () => "scanner died horribly");
  const refusal = await ops.readPublishedRefusal();
  assert.equal(refusal?.code, "SCANNER_REFUSED");
  assert.match(refusal?.message ?? "", /died horribly/u);
});
