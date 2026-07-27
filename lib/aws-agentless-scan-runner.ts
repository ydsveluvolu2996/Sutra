// Agentless scan orchestration engine. Walks a plan from buildAgentlessScanPlan
// and drives it through an injected AgentlessExecutor — the seam between this
// deterministic orchestration (fully unit-tested with a fake executor) and the
// real AWS/EC2 binding (services/aws-collector, exercised only against a live
// account). The invariant that matters for cost and safety: every resource a
// volume creates (scan volume, copied snapshot, source snapshot) is torn down
// unconditionally, even when the scan itself throws. Nothing here imports the
// AWS SDK; nothing runs until a real executor is supplied.
import type { AgentlessScanPlan } from "./aws-agentless-scan-plan.ts";

export interface AgentlessScanFinding {
  readonly source: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "unknown";
  readonly title: string;
}

/**
 * The real implementation (EC2 + KMS) lives in services/agentless-scanner.
 *
 * Note what is deliberately absent: there is no method that deletes anything in
 * the CUSTOMER's account. Sutra's customer role holds an explicit
 * `NeverDeleteAnything` deny (see infrastructure/customer-role.yaml), so the
 * source snapshot it creates is reaped by the customer-owned Data Lifecycle
 * Manager policy that same template installs — on the account owner's schedule,
 * under the account owner's role, pausable from their own console.
 *
 * Teardown here therefore covers only resources inside SUTRA's scan account
 * (the re-encrypted copy and the scan volume), which Sutra owns outright. The
 * customer-side snapshot is reported as a cleanup handoff instead, so the spend
 * it represents is visible rather than silently assumed away.
 */
export interface AgentlessExecutor {
  createSnapshot(input: { readonly volumeId: string; readonly region: string; readonly ttlHours: number }): Promise<{ readonly snapshotId: string }>;
  copySnapshotKms(input: { readonly snapshotId: string; readonly region: string }): Promise<{ readonly snapshotId: string }>;
  createScanVolume(input: { readonly snapshotId: string; readonly region: string }): Promise<{ readonly volumeId: string }>;
  runScan(input: { readonly scanVolumeId: string; readonly scanners: readonly string[] }): Promise<readonly AgentlessScanFinding[]>;
  /** Scan-account volume. Sutra's own resource. */
  deleteVolume(input: { readonly volumeId: string }): Promise<void>;
  /** Scan-account snapshot copy ONLY — never the customer's source snapshot. */
  deleteScanAccountSnapshot(input: { readonly snapshotId: string }): Promise<void>;
}

export interface AgentlessVolumeResult {
  readonly volumeId: string;
  readonly status: "scanned" | "failed";
  readonly findings: readonly AgentlessScanFinding[];
  readonly error: string | null;
  /** Every resource created for this volume that was successfully deleted. */
  readonly toreDown: readonly string[];
  /** Scan-account resources whose teardown failed — reconciled by the sweeper. */
  readonly teardownFailures: readonly string[];
  /**
   * The customer-account snapshot Sutra created and is NOT permitted to delete.
   * Handed to the customer's lifecycle policy; surfaced as cost until reaped.
   */
  readonly cleanupHandoff: readonly string[];
}

export interface AgentlessScanExecution {
  readonly schema: "sutra.aws-agentless-scan-execution.v1";
  readonly results: readonly AgentlessVolumeResult[];
  readonly summary: {
    readonly scanned: number;
    readonly failed: number;
    readonly findings: number;
    readonly resourcesToreDown: number;
    readonly teardownFailures: number;
    /** Customer-account snapshots awaiting the customer's own lifecycle policy. */
    readonly cleanupHandoffs: number;
  };
}

async function scanOneVolume(
  volume: AgentlessScanPlan["volumes"][number],
  plan: AgentlessScanPlan,
  executor: AgentlessExecutor,
): Promise<AgentlessVolumeResult> {
  const toreDown: string[] = [];
  const teardownFailures: string[] = [];
  let sourceSnapshotId: string | null = null;
  let copiedSnapshotId: string | null = null;
  let scanVolumeId: string | null = null;
  let findings: readonly AgentlessScanFinding[] = [];
  let error: string | null = null;

  try {
    sourceSnapshotId = (await executor.createSnapshot({ volumeId: volume.volumeId, region: volume.region, ttlHours: plan.summary.snapshotTtlHours })).snapshotId;
    const scanSnapshotId = plan.kmsReencrypt
      ? (copiedSnapshotId = (await executor.copySnapshotKms({ snapshotId: sourceSnapshotId, region: volume.region })).snapshotId)
      : sourceSnapshotId;
    scanVolumeId = (await executor.createScanVolume({ snapshotId: scanSnapshotId, region: volume.region })).volumeId;
    findings = await executor.runScan({ scanVolumeId, scanners: plan.scanners });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    // Guaranteed teardown of SUTRA-OWNED resources, even on scan failure. The
    // customer's source snapshot is not in this list by design — Sutra has no
    // delete permission for it — so it is handed off below instead.
    const teardowns: readonly { readonly id: string | null; readonly run: () => Promise<void> }[] = [
      { id: scanVolumeId, run: () => executor.deleteVolume({ volumeId: scanVolumeId as string }) },
      { id: copiedSnapshotId, run: () => executor.deleteScanAccountSnapshot({ snapshotId: copiedSnapshotId as string }) },
    ];
    for (const teardown of teardowns) {
      if (teardown.id === null) continue;
      try {
        await teardown.run();
        toreDown.push(teardown.id);
      } catch {
        teardownFailures.push(teardown.id);
      }
    }
  }

  return {
    volumeId: volume.volumeId,
    status: error === null ? "scanned" : "failed",
    findings,
    error,
    toreDown,
    teardownFailures,
    // Present whenever a source snapshot was created — including on failure,
    // because a failed scan still leaves a billable snapshot behind.
    cleanupHandoff: sourceSnapshotId === null ? [] : [sourceSnapshotId],
  };
}

export async function executeAgentlessScan(
  plan: AgentlessScanPlan,
  executor: AgentlessExecutor,
): Promise<AgentlessScanExecution> {
  const results: AgentlessVolumeResult[] = [];
  // Sequential for deterministic teardown accounting; the plan's concurrency
  // waves inform a future parallel runner, but correctness never depends on it.
  for (const volume of plan.volumes) {
    results.push(await scanOneVolume(volume, plan, executor));
  }
  const summary = {
    scanned: results.filter((result) => result.status === "scanned").length,
    failed: results.filter((result) => result.status === "failed").length,
    findings: results.reduce((sum, result) => sum + result.findings.length, 0),
    resourcesToreDown: results.reduce((sum, result) => sum + result.toreDown.length, 0),
    teardownFailures: results.reduce((sum, result) => sum + result.teardownFailures.length, 0),
    cleanupHandoffs: results.reduce((sum, result) => sum + result.cleanupHandoff.length, 0),
  };
  return { schema: "sutra.aws-agentless-scan-execution.v1", results, summary };
}
