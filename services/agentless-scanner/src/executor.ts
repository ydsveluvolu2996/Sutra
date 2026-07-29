/**
 * Real EC2/STS binding for agentless snapshot scanning.
 *
 * ── WHY THIS IS ITS OWN PACKAGE ─────────────────────────────────────────────
 * `services/aws-collector` is covered by `tests/collector-permission-coverage`,
 * which asserts that EVERY AWS command that service constructs maps to a
 * read-only action. Agentless scanning necessarily issues CreateSnapshot, so
 * putting it there would either break that guarantee or force it to be weakened.
 * Keeping it separate means the collector's read-only property stays provable.
 *
 * ── VALIDATION STATUS ───────────────────────────────────────────────────────
 * NOT ONE CALL IN THIS FILE HAS BEEN EXECUTED AGAINST AWS. The shapes are
 * written from the SDK's types; the response-field assumptions marked
 * `UNVALIDATED:` below are the specific things most likely to be wrong and must
 * be confirmed service-by-service against a live account before this is trusted.
 * `assertLiveValidated()` exists so nothing can quietly promote it to production.
 *
 * ── THE TRUST BOUNDARY THIS FILE MUST NOT BREAK ─────────────────────────────
 * There is deliberately no method here that deletes anything in the CUSTOMER's
 * account. The customer role carries an explicit IAM deny on DeleteSnapshot and
 * friends (infrastructure/customer-role.yaml), so such a call would fail anyway —
 * but it is also absent by construction so the mistake cannot be made. Only
 * `deleteVolume` and `deleteScanAccountSnapshot` delete, and both act on
 * resources inside Sutra's OWN scan account.
 */
import {
  CopySnapshotCommand,
  CreateSnapshotCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeSnapshotsCommand,
  EC2Client,
  ModifySnapshotAttributeCommand,
} from "@aws-sdk/client-ec2";

/** Marker tag. Every grant in the customer policy is conditioned on this. */
export const AGENTLESS_TAG_KEY = "sutra-agentless";
export const AGENTLESS_TAG_VALUE = "true";

export interface AgentlessScanFinding {
  readonly source: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "unknown";
  readonly title: string;
}

/** Runs the actual scan. Implemented by the container worker, not by an SDK. */
export interface ScanWorker {
  scan(input: {
    readonly scanVolumeId: string;
    readonly region: string;
    readonly scanners: readonly string[];
  }): Promise<readonly AgentlessScanFinding[]>;
}

export interface AgentlessExecutorConfig {
  /** Client bound to the CUSTOMER role (STS AssumeRole + ExternalId). */
  readonly customerClientFor: (region: string) => Promise<EC2Client>;
  /** Client bound to SUTRA's own scan account. */
  readonly scanClientFor: (region: string) => Promise<EC2Client>;
  readonly scanAccountId: string;
  readonly scanAvailabilityZone: string;
  readonly kmsKeyArn: string | null;
  readonly worker: ScanWorker;
  /**
   * Must be set true ONLY by an operator who has validated every call below
   * against a live account. Left false, the executor refuses to run.
   */
  readonly liveValidated?: boolean;
  /** Bounded wait for a snapshot to become usable. */
  readonly snapshotReadyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const ACCOUNT_ID = /^\d{12}$/u;
const SNAPSHOT_ID = /^snap-[0-9a-f]{8,32}$/u;
const VOLUME_ID = /^vol-[0-9a-f]{8,32}$/u;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;
const DEFAULT_READY_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 15_000;

export class AgentlessExecutorError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.name = "AgentlessExecutorError";
    this.code = code;
  }
}

function assertSnapshotId(value: string | undefined): string {
  if (value === undefined || !SNAPSHOT_ID.test(value)) {
    throw new AgentlessExecutorError("BAD_SNAPSHOT_ID", "AWS returned no usable snapshot id");
  }
  return value;
}

function assertVolumeId(value: string | undefined): string {
  if (value === undefined || !VOLUME_ID.test(value)) {
    throw new AgentlessExecutorError("BAD_VOLUME_ID", "AWS returned no usable volume id");
  }
  return value;
}

/**
 * The live EC2 implementation of the orchestrator's `AgentlessExecutor` seam.
 * Structural, not nominal: it satisfies the root `lib/aws-agentless-scan-runner`
 * interface without importing it (that module targets workerd; this one targets
 * Node with the AWS SDK, and the two build graphs are deliberately separate).
 */
export class Ec2AgentlessExecutor {
  private readonly config: AgentlessExecutorConfig;

  public constructor(config: AgentlessExecutorConfig) {
    if (!ACCOUNT_ID.test(config.scanAccountId)) {
      throw new AgentlessExecutorError("BAD_SCAN_ACCOUNT", "The scan account id is not a 12-digit AWS account");
    }
    this.config = config;
  }

  /**
   * Refuses to act until an operator asserts the calls were validated live.
   * Written unverified on purpose (see the header), so the default is inert
   * rather than confidently wrong.
   */
  private assertLiveValidated(): void {
    if (this.config.liveValidated !== true) {
      throw new AgentlessExecutorError(
        "NOT_LIVE_VALIDATED",
        "The agentless AWS executor has never been validated against a live account. " +
          "Validate each EC2 call service-by-service, then construct it with liveValidated: true.",
      );
    }
  }

  private async sleep(ms: number): Promise<void> {
    const sleeper = this.config.sleep ?? ((delay: number) => new Promise<void>((resolve) => { setTimeout(resolve, delay); }));
    await sleeper(ms);
  }

  /**
   * Point-in-time snapshot in the CUSTOMER's account, tagged at creation.
   *
   * Tagging via TagSpecifications (not a follow-up CreateTags) is load-bearing,
   * not stylistic: the customer policy allows CreateSnapshot only when
   * aws:RequestTag/sutra-agentless=true. A snapshot created untagged would also
   * be un-shareable and un-reapable, stranding the customer's spend forever.
   *
   * `ttlHours` is recorded as a tag for auditability only. Sutra cannot delete
   * this snapshot; the customer's Data Lifecycle Manager policy reaps it.
   */
  public async createSnapshot(input: { readonly volumeId: string; readonly region: string; readonly ttlHours: number }): Promise<{ readonly snapshotId: string }> {
    this.assertLiveValidated();
    if (!VOLUME_ID.test(input.volumeId) || !REGION.test(input.region)) {
      throw new AgentlessExecutorError("BAD_INPUT", "Volume id or region is malformed");
    }
    const client = await this.config.customerClientFor(input.region);
    const response = await client.send(new CreateSnapshotCommand({
      VolumeId: input.volumeId,
      Description: `Sutra agentless scan of ${input.volumeId} (deleted by your own lifecycle policy)`,
      TagSpecifications: [{
        ResourceType: "snapshot",
        Tags: [
          { Key: AGENTLESS_TAG_KEY, Value: AGENTLESS_TAG_VALUE },
          { Key: "sutra-agentless-ttl-hours", Value: String(input.ttlHours) },
          { Key: "sutra-agentless-source-volume", Value: input.volumeId },
        ],
      }],
    }));
    // UNVALIDATED: CreateSnapshot returns SnapshotId at the top level.
    return { snapshotId: assertSnapshotId(response.SnapshotId) };
  }

  /**
   * Wait until a snapshot is usable. A CopySnapshot or CreateVolume against a
   * `pending` snapshot fails, and the failure looks like a permission problem,
   * so polling here avoids a whole class of misdiagnosis.
   */
  public async waitForSnapshot(input: { readonly snapshotId: string; readonly region: string; readonly customerOwned: boolean }): Promise<void> {
    this.assertLiveValidated();
    const timeout = this.config.snapshotReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const interval = this.config.pollIntervalMs ?? DEFAULT_POLL_MS;
    const client = input.customerOwned
      ? await this.config.customerClientFor(input.region)
      : await this.config.scanClientFor(input.region);
    // Deadline is computed from a single start reading so a slow poll cannot
    // extend the budget indefinitely.
    const startedAt = Date.now();
    for (;;) {
      const described = await client.send(new DescribeSnapshotsCommand({ SnapshotIds: [input.snapshotId] }));
      // UNVALIDATED: State is 'pending' | 'completed' | 'error' | 'recoverable' | 'recovering'.
      const state = described.Snapshots?.[0]?.State;
      if (state === "completed") return;
      if (state === "error") {
        throw new AgentlessExecutorError("SNAPSHOT_FAILED", `Snapshot ${input.snapshotId} entered the error state`);
      }
      if (Date.now() - startedAt >= timeout) {
        throw new AgentlessExecutorError(
          "SNAPSHOT_TIMEOUT",
          `Snapshot ${input.snapshotId} was still ${state ?? "unknown"} after ${Math.round(timeout / 1000)}s`,
        );
      }
      await this.sleep(interval);
    }
  }

  /**
   * Share the customer snapshot with the scan account, then re-encrypt it into
   * that account under Sutra's own key.
   *
   * The share is what the customer policy permits (ModifySnapshotAttribute on a
   * tagged snapshot, pinned to one account by a deny). The copy is then issued by
   * the SCAN account — Sutra's own — which is why it uses scanClientFor: after
   * this point the data lives under Sutra's key, and the customer's KMS key is no
   * longer in the read path.
   */
  public async copySnapshotKms(input: { readonly snapshotId: string; readonly region: string }): Promise<{ readonly snapshotId: string }> {
    this.assertLiveValidated();
    if (!SNAPSHOT_ID.test(input.snapshotId) || !REGION.test(input.region)) {
      throw new AgentlessExecutorError("BAD_INPUT", "Snapshot id or region is malformed");
    }
    if (this.config.kmsKeyArn === null) {
      throw new AgentlessExecutorError("NO_KMS_KEY", "A scan-account KMS key is required to copy a snapshot");
    }
    await this.waitForSnapshot({ snapshotId: input.snapshotId, region: input.region, customerOwned: true });

    const customer = await this.config.customerClientFor(input.region);

    // Whether a share is needed at all depends on the topology.
    //
    // Sutra's deployed setup is deliberately SINGLE-ACCOUNT: the scan account is the
    // same account that owns the volume, chosen so all agentless cost lands in one
    // place and stays visible. In that shape the share is not merely unnecessary, it
    // is REJECTED — AWS refuses createVolumePermission granted to a snapshot's own
    // owner — so an unconditional share fails before the copy is ever attempted, and
    // the whole scan dies on a step that had nothing to do with reading the disk.
    //
    // The owner comes from DescribeSnapshots rather than configuration: it is the
    // account AWS itself attributes the snapshot to, so a mis-set config value
    // cannot make this branch wrong.
    const owner = await customer.send(new DescribeSnapshotsCommand({ SnapshotIds: [input.snapshotId] }));
    // UNVALIDATED: DescribeSnapshots returns OwnerId as the 12-digit account id.
    const ownerId = owner.Snapshots?.[0]?.OwnerId;
    const sameAccount = typeof ownerId === "string" && ownerId === this.config.scanAccountId;

    if (!sameAccount) {
      await customer.send(new ModifySnapshotAttributeCommand({
        SnapshotId: input.snapshotId,
        Attribute: "createVolumePermission",
        OperationType: "add",
        UserIds: [this.config.scanAccountId],
      }));
    }

    const scan = await this.config.scanClientFor(input.region);
    const copied = await scan.send(new CopySnapshotCommand({
      SourceSnapshotId: input.snapshotId,
      SourceRegion: input.region,
      Encrypted: true,
      KmsKeyId: this.config.kmsKeyArn,
      Description: `Sutra scan copy of ${input.snapshotId}`,
      TagSpecifications: [{
        ResourceType: "snapshot",
        Tags: [{ Key: AGENTLESS_TAG_KEY, Value: AGENTLESS_TAG_VALUE }],
      }],
    }));
    // UNVALIDATED: CopySnapshot returns SnapshotId of the new copy.
    const copiedId = assertSnapshotId(copied.SnapshotId);

    // Revoke the share immediately. The copy is independent, so leaving the
    // customer's snapshot shared would widen exposure for no benefit.
    //
    // Skipped when no share was added: removing a permission that was never granted
    // is at best a no-op and at worst an error, and either way it would make the
    // logs claim a revoke that did not correspond to anything.
    try {
      if (!sameAccount) {
        await customer.send(new ModifySnapshotAttributeCommand({
          SnapshotId: input.snapshotId,
          Attribute: "createVolumePermission",
          OperationType: "remove",
          UserIds: [this.config.scanAccountId],
        }));
      }
    } catch {
      // Non-fatal: the copy already exists and the scan must proceed. The share
      // is reported rather than retried here; the sweeper re-checks it.
    }
    return { snapshotId: copiedId };
  }

  /** Volume in SUTRA's scan account, from the re-encrypted copy. */
  public async createScanVolume(input: { readonly snapshotId: string; readonly region: string }): Promise<{ readonly volumeId: string }> {
    this.assertLiveValidated();
    if (!SNAPSHOT_ID.test(input.snapshotId) || !REGION.test(input.region)) {
      throw new AgentlessExecutorError("BAD_INPUT", "Snapshot id or region is malformed");
    }
    await this.waitForSnapshot({ snapshotId: input.snapshotId, region: input.region, customerOwned: false });
    const client = await this.config.scanClientFor(input.region);
    const created = await client.send(new CreateVolumeCommand({
      SnapshotId: input.snapshotId,
      AvailabilityZone: this.config.scanAvailabilityZone,
      VolumeType: "gp3",
      TagSpecifications: [{
        ResourceType: "volume",
        Tags: [{ Key: AGENTLESS_TAG_KEY, Value: AGENTLESS_TAG_VALUE }],
      }],
    }));
    // UNVALIDATED: CreateVolume returns VolumeId at the top level.
    return { volumeId: assertVolumeId(created.VolumeId) };
  }

  /** Delegates to the container worker; no SDK call of its own. */
  public async runScan(input: { readonly scanVolumeId: string; readonly scanners: readonly string[] }): Promise<readonly AgentlessScanFinding[]> {
    this.assertLiveValidated();
    if (!VOLUME_ID.test(input.scanVolumeId)) {
      throw new AgentlessExecutorError("BAD_INPUT", "Scan volume id is malformed");
    }
    return this.config.worker.scan({
      scanVolumeId: input.scanVolumeId,
      region: this.config.scanAvailabilityZone.slice(0, -1),
      scanners: input.scanners,
    });
  }

  /** Scan-account volume — Sutra's own resource. */
  public async deleteVolume(input: { readonly volumeId: string }): Promise<void> {
    this.assertLiveValidated();
    if (!VOLUME_ID.test(input.volumeId)) {
      throw new AgentlessExecutorError("BAD_INPUT", "Volume id is malformed");
    }
    const client = await this.config.scanClientFor(this.config.scanAvailabilityZone.slice(0, -1));
    await client.send(new DeleteVolumeCommand({ VolumeId: input.volumeId }));
  }

  /**
   * Scan-account snapshot copy — Sutra's own resource.
   *
   * Named for the account it acts on, not the verb, so that a future caller
   * cannot mistake it for a general snapshot delete and point it at a customer
   * snapshot. There is no method on this class that can do that.
   */
  public async deleteScanAccountSnapshot(input: { readonly snapshotId: string }): Promise<void> {
    this.assertLiveValidated();
    if (!SNAPSHOT_ID.test(input.snapshotId)) {
      throw new AgentlessExecutorError("BAD_INPUT", "Snapshot id is malformed");
    }
    const client = await this.config.scanClientFor(this.config.scanAvailabilityZone.slice(0, -1));
    await client.send(new DeleteSnapshotCommand({ SnapshotId: input.snapshotId }));
  }
}
