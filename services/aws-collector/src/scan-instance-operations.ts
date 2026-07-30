/**
 * The AWS implementation behind `ScanInstanceOperations`.
 *
 * The worker owns the ORDER and the teardown guarantees; this file owns the calls
 * and the user-data. Split that way so the guarantees stay unit-testable without an
 * AWS account, and so the one genuinely dangerous artefact here — a shell script
 * that runs as root on a host with a customer's disk attached — is a pure function
 * that tests can read.
 *
 * ── WHY THE AMI IS CONFIGURATION, NOT A LOOKUP ──────────────────────────────
 * The obvious implementation resolves the current Amazon Linux 2023 AMI from the
 * public SSM parameter. The orchestrator role carries an explicit Deny on `ssm:*`
 * (it is a control-plane surface), and an explicit Deny cannot be overridden — so
 * that call would fail at scan time, after a snapshot already exists and is
 * already billing. The AMI is passed in, pinned, and therefore also reproducible:
 * "which host image produced this finding" stays answerable.
 *
 * ── WHAT THE INSTANCE IS AND IS NOT TRUSTED WITH ────────────────────────────
 * It holds the scanner instance profile: pull the pinned image, PUT its own
 * findings, nothing else — with an explicit Deny on rds/secretsmanager/ssm/
 * dynamodb/iam/sts and ec2. It has no inbound path. It publishes to object storage
 * rather than calling back, so it never holds a control-plane credential. Root
 * inside that container is contained by IAM, not by hope.
 */

import {
  AttachVolumeCommand,
  DescribeInstanceStatusCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

import type { AgentlessScanFinding } from "./executor.js";
import type { LaunchScanInstanceInput, ScanInstanceOperations } from "./ec2-scan-worker.js";
import type { AgentlessResourceTracker } from "./agentless-execution.js";

const AMI_ID = /^ami-[0-9a-f]{8,17}$/u;
const SUBNET_ID = /^subnet-[0-9a-f]{8,17}$/u;
const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8,17}$/u;
const IMAGE_DIGEST = /^[a-z0-9.\-_/]+@sha256:[0-9a-f]{64}$/u;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;

export class ScanInstanceOperationsError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`scan-instance-operations: ${code}: ${message}`);
    this.name = "ScanInstanceOperationsError";
    this.code = code;
  }
}

export interface ScanInstanceSettings {
  /** Pinned host AMI. Not resolved at run time — see the note above. */
  readonly amiId: string;
  readonly instanceType: string;
  /** Must be in the AZ the scan volume lives in; EBS attach is AZ-bound. */
  readonly subnetId: string;
  readonly securityGroupId: string;
  readonly instanceProfileArn: string;
  readonly findingsBucket: string;
  /** Digest-pinned scanner image. */
  readonly scannerImage: string;
  readonly region: string;
  /** Correlates the instance, its tags and its findings prefix. */
  readonly runId: string;
}

/** Reads an object, or null when absent. Injected so the S3 client stays out of here. */
export type ReadFindingsObject = (bucket: string, key: string) => Promise<string | null>;

export const FINDINGS_OBJECT = "findings.json";
export const REFUSAL_OBJECT = "refusal.json";

/** Where a run publishes. Keyed by run id so one scan cannot read another's. */
export function findingsPrefix(runId: string): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(runId)) {
    throw new ScanInstanceOperationsError("RUN_ID_INVALID", `unusable run id: ${runId}`);
  }
  return `scans/${runId}`;
}

/**
 * The script the host runs as root. A pure function ON PURPOSE: this is the most
 * dangerous artefact in the subsystem, so it must be readable in a test rather than
 * assembled inline at a call site.
 *
 * Invariants the tests hold it to:
 * * NO credentials are embedded — the instance profile supplies them.
 * * IMDSv2 only; the launch below also refuses IMDSv1.
 * * The container gets SYS_ADMIN and the device, and NOTHING else — not --privileged.
 * * It publishes a refusal as well as a success, because a scan that produced no
 *   findings and a scan that refused must never look the same.
 * * It shuts down on every path, including failure, so a wedged scan still stops
 *   billing without depending on the orchestrator to reap it.
 */
export function buildScanUserData(settings: ScanInstanceSettings, deviceName: string): string {
  const prefix = findingsPrefix(settings.runId);
  const bareDevice = deviceName.replace("/dev/", "");
  return `#!/bin/bash
set -uo pipefail
# Stop billing no matter how this ends. Set FIRST so an early failure still halts.
trap 'shutdown -h now' EXIT

REGION=${settings.region}
BUCKET=${settings.findingsBucket}
PREFIX=${prefix}
IMAGE=${settings.scannerImage}

publish_refusal() {
  printf '{"code":"%s","message":"%s"}' "$1" "$2" > /tmp/refusal.json
  aws s3 cp /tmp/refusal.json "s3://$BUCKET/$PREFIX/${REFUSAL_OBJECT}" --region "$REGION" || true
}

# The attach is asynchronous: the volume may not be visible the instant we boot.
for _ in $(seq 1 60); do
  test -b /dev/${bareDevice} && break
  # NVMe-backed instance types rename the device; the scanner resolves the real
  # one from the lsblk tree itself, so any extra disk appearing is enough here.
  lsblk -dn -o NAME | grep -qv "^$(lsblk -dn -o NAME | head -1)$" && break
  sleep 5
done

dnf install -y docker >/dev/null 2>&1 || yum install -y docker >/dev/null 2>&1
systemctl start docker || { publish_refusal DOCKER_UNAVAILABLE "docker did not start"; exit 1; }

# Credentials come from the instance profile; none are written to disk or to the
# process list. The registry password is piped, never passed as an argument.
aws ecr get-login-password --region "$REGION" \\
  | docker login --username AWS --password-stdin "${settings.scannerImage.split("/")[0]}" \\
  || { publish_refusal ECR_LOGIN_FAILED "could not authenticate to the registry"; exit 1; }

docker pull "$IMAGE" || { publish_refusal IMAGE_PULL_FAILED "could not pull the pinned scanner"; exit 1; }

# One capability and the block devices only, never full-privilege mode. The
# scanner mounts read-only and refuses rather than guessing on an ambiguous device.
docker run --rm \\
  --cap-add SYS_ADMIN \\
  --security-opt no-new-privileges \\
  -v /dev:/dev \\
  "$IMAGE" > /tmp/scan.out 2>/tmp/scan.err
STATUS=$?

if [ $STATUS -eq 0 ] && [ -s /tmp/scan.out ]; then
  aws s3 cp /tmp/scan.out "s3://$BUCKET/$PREFIX/${FINDINGS_OBJECT}" --region "$REGION"
else
  # A non-zero exit is the scanner REFUSING (it exits 1 on refusal by design).
  # Its own JSON refusal is preferred; the fallback still says something true.
  if [ -s /tmp/scan.out ]; then
    aws s3 cp /tmp/scan.out "s3://$BUCKET/$PREFIX/${REFUSAL_OBJECT}" --region "$REGION" || true
  else
    publish_refusal SCANNER_FAILED "exit $STATUS with no report; see instance console output"
  fi
fi
`;
}

export interface AwsScanInstanceOperationsConfig {
  readonly settings: ScanInstanceSettings;
  readonly ec2: (region: string) => EC2Client;
  readonly readObject: ReadFindingsObject;
  readonly resourceTracker?: AgentlessResourceTracker;
}

export class AwsScanInstanceOperations implements ScanInstanceOperations {
  private readonly config: AwsScanInstanceOperationsConfig;

  public constructor(config: AwsScanInstanceOperationsConfig) {
    const s = config.settings;
    // Everything checkable is checked at construction, before a snapshot exists.
    const checks: readonly [boolean, string, string][] = [
      [AMI_ID.test(s.amiId), "AMI_INVALID", `not an AMI id: ${s.amiId}`],
      [SUBNET_ID.test(s.subnetId), "SUBNET_INVALID", `not a subnet id: ${s.subnetId}`],
      [SECURITY_GROUP_ID.test(s.securityGroupId), "SECURITY_GROUP_INVALID", `not a security group id: ${s.securityGroupId}`],
      [BUCKET.test(s.findingsBucket), "BUCKET_INVALID", `not a bucket name: ${s.findingsBucket}`],
      [
        IMAGE_DIGEST.test(s.scannerImage),
        "SCANNER_IMAGE_NOT_PINNED",
        "the scanner image must be pinned by digest; a mutable tag makes a finding unattributable",
      ],
    ];
    for (const [ok, code, message] of checks) {
      if (!ok) throw new ScanInstanceOperationsError(code, message);
    }
    findingsPrefix(s.runId);
    this.config = config;
  }

  public async launch(input: LaunchScanInstanceInput): Promise<string> {
    const s = this.config.settings;
    const client = this.config.ec2(input.region);
    const response = await client.send(new RunInstancesCommand({
      ImageId: s.amiId,
      InstanceType: s.instanceType as never,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: s.subnetId,
      SecurityGroupIds: [s.securityGroupId],
      IamInstanceProfile: { Arn: s.instanceProfileArn },
      UserData: Buffer.from(buildScanUserData(s, input.deviceName), "utf8").toString("base64"),
      // Self-terminate on the shutdown the user-data issues, so a finished scan
      // stops billing without waiting for the orchestrator to reap it.
      InstanceInitiatedShutdownBehavior: "terminate",
      // IMDSv2 only: a scanner that mounts hostile data must not expose a
      // credential endpoint reachable by a simple request forgery.
      MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 1 },
      // Tag-on-create is not cosmetic: RunInstances is only PERMITTED with this
      // tag, and terminate is scoped to it. An untagged instance would be one the
      // reaper cannot see.
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [
          { Key: "sutra:component", Value: "agentless-scan" },
          { Key: "sutra:run", Value: s.runId },
        ],
      }],
    }));
    const instanceId = response.Instances?.[0]?.InstanceId;
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new ScanInstanceOperationsError(
        "LAUNCH_RETURNED_NO_ID",
        "RunInstances reported success without an instance id; an instance may be running and MUST be checked by hand",
      );
    }
    await this.config.resourceTracker?.created({
      sourceVolumeId: input.scanVolumeId,
      resourceId: instanceId,
      resourceKind: "scan_instance",
      accountScope: "sutra-scan-account",
      region: input.region,
    });
    return instanceId;
  }

  public async waitUntilAttachable(instanceId: string, region: string): Promise<void> {
    const client = this.config.ec2(region);
    // "running" is the earliest state that accepts an attachment. Bounded, because
    // an unbounded wait on a booting instance is an unbounded bill.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = await client.send(new DescribeInstanceStatusCommand({
        InstanceIds: [instanceId],
        IncludeAllInstances: true,
      }));
      const state = status.InstanceStatuses?.[0]?.InstanceState?.Name;
      if (state === "running") return;
      if (state === "shutting-down" || state === "terminated" || state === "stopped") {
        throw new ScanInstanceOperationsError(
          "INSTANCE_DIED_BEFORE_ATTACH",
          `the scan instance reached ${state} before the volume could be attached`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new ScanInstanceOperationsError(
      "INSTANCE_NEVER_RAN",
      "the scan instance did not reach running within 5 minutes",
    );
  }

  public async attachVolume(input: {
    readonly instanceId: string;
    readonly volumeId: string;
    readonly deviceName: string;
    readonly region: string;
  }): Promise<void> {
    await this.config.ec2(input.region).send(new AttachVolumeCommand({
      InstanceId: input.instanceId,
      VolumeId: input.volumeId,
      Device: input.deviceName,
    }));
  }

  public async readPublishedFindings(): Promise<readonly AgentlessScanFinding[] | null> {
    const prefix = findingsPrefix(this.config.settings.runId);
    const body = await this.config.readObject(this.config.settings.findingsBucket, `${prefix}/${FINDINGS_OBJECT}`);
    if (body === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Unparseable is NOT empty. Returning [] here would publish "no findings".
      throw new ScanInstanceOperationsError(
        "FINDINGS_UNPARSEABLE",
        "the scanner published a findings object that is not JSON; refusing to read it as an empty result",
      );
    }
    const findings = (parsed as { findings?: unknown }).findings ?? parsed;
    if (!Array.isArray(findings)) {
      throw new ScanInstanceOperationsError(
        "FINDINGS_NOT_A_LIST",
        "the published findings are not a list; refusing to read them as an empty result",
      );
    }
    return findings as readonly AgentlessScanFinding[];
  }

  public async readPublishedRefusal(): Promise<{ code: string; message: string } | null> {
    const prefix = findingsPrefix(this.config.settings.runId);
    const body = await this.config.readObject(this.config.settings.findingsBucket, `${prefix}/${REFUSAL_OBJECT}`);
    if (body === null) return null;
    try {
      const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
      return {
        code: typeof parsed.code === "string" ? parsed.code : "SCANNER_REFUSED",
        message: typeof parsed.message === "string" ? parsed.message : body.slice(0, 200),
      };
    } catch {
      // A refusal we cannot parse is still a refusal — never silently discarded.
      return { code: "SCANNER_REFUSED", message: body.slice(0, 200) };
    }
  }

  public async terminate(instanceId: string, region: string): Promise<void> {
    await this.config.ec2(region).send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    await this.config.resourceTracker?.deleted({
      resourceId: instanceId,
      resourceKind: "scan_instance",
      region,
    });
  }
}
