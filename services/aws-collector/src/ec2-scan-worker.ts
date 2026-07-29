/**
 * Runs a scan on a short-lived EC2 instance, because Fargate cannot mount a disk.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * Mounting a block device requires CAP_SYS_ADMIN. AWS refuses it outright on
 * Fargate: RegisterTaskDefinition with FARGATE plus SYS_ADMIN fails with
 * "SYS_ADMIN is not allowed on Fargate" (checked 2026-07-29; the identical
 * definition under the EC2 launch type registers fine). The stack originally
 * provisioned a Fargate-only cluster, so it could not have hosted a scan.
 *
 * ── WHY AN INSTANCE PER SCAN, NOT ECS ON EC2 CAPACITY ───────────────────────
 * ECS on EC2 would mean managing a launch template, an ASG, a capacity provider
 * and a container-instance role IN ADDITION to the ECS layer — and it puts a race
 * in the worst possible place: the volume has to be attached to whichever host the
 * task happens to land on. Launching the instance ourselves means we know its id
 * before we attach anything, so the attach is deterministic. Nothing is scheduled,
 * so nothing can be scheduled somewhere surprising.
 *
 * ── WHY NOT THE EBS DIRECT APIs ─────────────────────────────────────────────
 * ListSnapshotBlocks/GetSnapshotBlock need no volume, no attach and no privileged
 * container, and would run on Fargate — but they return raw 512 KiB blocks, so a
 * userspace ext4/xfs/btrfs reader has to exist before Trivy can see one file. That
 * is a months-long build that discards a working scanner image, and at roughly
 * 200k API calls per 100 GiB it is not obviously cheaper. Worth revisiting when
 * scan volume justifies it; not now.
 *
 * ── THE COST SHAPE THIS PROTECTS ────────────────────────────────────────────
 * One instance, a few minutes, terminated on completion AND on every failure path,
 * with a hard TTL so a lost scan cannot bill forever. Nothing runs while idle. The
 * failure mode this file is most careful about is NOT a crash — it is a scan that
 * quietly leaves an instance and a volume running.
 *
 * Every AWS call is an injected seam so the ordering, the teardown guarantees and
 * the refusals are unit-tested without an AWS account.
 */

import type { AgentlessScanFinding } from "./executor.js";

const INSTANCE_ID = /^i-[0-9a-f]{8,32}$/u;
const VOLUME_ID = /^vol-[0-9a-f]{8,32}$/u;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;
/** Digest-pinned only: a finding must stay attributable to a scanner build. */
const IMAGE_DIGEST = /^[a-z0-9.\-_/:]+@sha256:[0-9a-f]{64}$/u;

export class ScanWorkerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`agentless-scan-worker: ${code}: ${message}`);
    this.name = "ScanWorkerError";
    this.code = code;
  }
}

export interface LaunchScanInstanceInput {
  readonly region: string;
  readonly scanVolumeId: string;
  /** Device name the user-data expects to appear. */
  readonly deviceName: string;
  readonly scanners: readonly string[];
}

/** The AWS calls this worker makes, in the order it makes them. */
export interface ScanInstanceOperations {
  /** RunInstances. Returns the new instance id. */
  launch(input: LaunchScanInstanceInput): Promise<string>;
  /** Waits until the instance can accept a volume attachment. */
  waitUntilAttachable(instanceId: string, region: string): Promise<void>;
  attachVolume(input: {
    readonly instanceId: string;
    readonly volumeId: string;
    readonly deviceName: string;
    readonly region: string;
  }): Promise<void>;
  /**
   * Reads the findings the instance published, or null while absent. The scanner
   * writes to object storage rather than calling back, so it needs no inbound path
   * and no control-plane credential.
   */
  readPublishedFindings(
    instanceId: string,
    region: string,
  ): Promise<readonly AgentlessScanFinding[] | null>;
  /** Reads a refusal the scanner published, if it refused. */
  readPublishedRefusal(instanceId: string, region: string): Promise<{ code: string; message: string } | null>;
  /** TerminateInstances. MUST be safe to call twice. */
  terminate(instanceId: string, region: string): Promise<void>;
}

export interface Ec2ScanWorkerConfig {
  readonly operations: ScanInstanceOperations;
  /** Digest-pinned scanner image the instance runs. */
  readonly scannerImage: string;
  /** Bounded wait for the scan to publish. */
  readonly scanTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly deviceName?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SCAN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 15_000;
/** Not /dev/sda1 — that is the root device on every sane AMI. */
const DEFAULT_DEVICE = "/dev/sdf";

export class Ec2ScanWorker {
  private readonly config: Ec2ScanWorkerConfig;

  public constructor(config: Ec2ScanWorkerConfig) {
    if (!IMAGE_DIGEST.test(config.scannerImage)) {
      throw new ScanWorkerError(
        "SCANNER_IMAGE_NOT_PINNED",
        "the scanner image must be pinned by digest; a mutable tag makes a finding unattributable",
      );
    }
    this.config = config;
  }

  public async scan(input: {
    readonly scanVolumeId: string;
    readonly region: string;
    readonly scanners: readonly string[];
  }): Promise<readonly AgentlessScanFinding[]> {
    if (!VOLUME_ID.test(input.scanVolumeId)) {
      throw new ScanWorkerError("VOLUME_ID_INVALID", `not an EBS volume id: ${input.scanVolumeId}`);
    }
    if (!REGION.test(input.region)) {
      throw new ScanWorkerError("REGION_INVALID", `not an AWS region: ${input.region}`);
    }
    if (input.scanners.length === 0) {
      // An empty scanner list would run a scan that cannot find anything and then
      // report an empty result, which is indistinguishable from a clean disk.
      throw new ScanWorkerError("NO_SCANNERS", "refusing to run a scan with no scanners selected");
    }

    const deviceName = this.config.deviceName ?? DEFAULT_DEVICE;
    const sleep = this.config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const timeoutMs = this.config.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
    const pollMs = this.config.pollIntervalMs ?? DEFAULT_POLL_MS;

    const instanceId = await this.config.operations.launch({
      region: input.region,
      scanVolumeId: input.scanVolumeId,
      deviceName,
      scanners: input.scanners,
    });
    if (!INSTANCE_ID.test(instanceId)) {
      // We cannot terminate what we cannot name, so this is reported loudly rather
      // than swallowed: an unterminatable instance bills until someone notices.
      throw new ScanWorkerError(
        "INSTANCE_ID_UNUSABLE",
        `launch returned an unusable instance id (${instanceId}); it may still be running and MUST be checked by hand`,
      );
    }

    // From here every exit path terminates. try/finally rather than terminating at
    // each return, because the expensive mistake is a path that forgets.
    try {
      await this.config.operations.waitUntilAttachable(instanceId, input.region);
      await this.config.operations.attachVolume({
        instanceId,
        volumeId: input.scanVolumeId,
        deviceName,
        region: input.region,
      });

      const deadline = timeoutMs;
      let waited = 0;
      for (;;) {
        const refusal = await this.config.operations.readPublishedRefusal(instanceId, input.region);
        if (refusal !== null) {
          // A refusal is a RESULT, not an absence. Surfacing it as an error keeps it
          // out of the findings path, where an empty list would read as "clean".
          throw new ScanWorkerError(
            `SCANNER_REFUSED_${refusal.code}`,
            `the scanner refused to report: ${refusal.message}`,
          );
        }
        const findings = await this.config.operations.readPublishedFindings(instanceId, input.region);
        if (findings !== null) return findings;
        if (waited >= deadline) {
          throw new ScanWorkerError(
            "SCAN_TIMED_OUT",
            `the scanner published neither findings nor a refusal within ${Math.round(deadline / 1000)}s; `
            + "the instance is being terminated and this run has NO result — do not read it as clean",
          );
        }
        await sleep(pollMs);
        waited += pollMs;
      }
    } finally {
      // Never let a teardown failure mask the real error, and never let it stop the
      // attempt either: an orphaned instance is a standing cost.
      try {
        await this.config.operations.terminate(instanceId, input.region);
      } catch {
        // Intentionally swallowed. The caller's error (or result) is the useful
        // signal; the TTL guard in the infrastructure is the backstop for a
        // terminate that genuinely failed.
      }
    }
  }
}
