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

/** The real implementation (EC2 + KMS) lives in services/aws-collector. */
export interface AgentlessExecutor {
  createSnapshot(input: { readonly volumeId: string; readonly region: string; readonly ttlHours: number }): Promise<{ readonly snapshotId: string }>;
  copySnapshotKms(input: { readonly snapshotId: string; readonly region: string }): Promise<{ readonly snapshotId: string }>;
  createScanVolume(input: { readonly snapshotId: string; readonly region: string }): Promise<{ readonly volumeId: string }>;
  runScan(input: { readonly scanVolumeId: string; readonly scanners: readonly string[] }): Promise<readonly AgentlessScanFinding[]>;
  deleteVolume(input: { readonly volumeId: string }): Promise<void>;
  deleteSnapshot(input: { readonly snapshotId: string }): Promise<void>;
}

export interface AgentlessVolumeResult {
  readonly volumeId: string;
  readonly status: "scanned" | "failed";
  readonly findings: readonly AgentlessScanFinding[];
  readonly error: string | null;
  /** Every resource created for this volume that was successfully deleted. */
  readonly toreDown: readonly string[];
  /** Resources whose teardown failed — must be reconciled by the TTL sweeper. */
  readonly teardownFailures: readonly string[];
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
    // Guaranteed teardown, even on scan failure — bounds cost and blast radius.
    const teardowns: readonly { readonly id: string | null; readonly run: () => Promise<void> }[] = [
      { id: scanVolumeId, run: () => executor.deleteVolume({ volumeId: scanVolumeId as string }) },
      { id: copiedSnapshotId, run: () => executor.deleteSnapshot({ snapshotId: copiedSnapshotId as string }) },
      { id: sourceSnapshotId, run: () => executor.deleteSnapshot({ snapshotId: sourceSnapshotId as string }) },
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
  };
  return { schema: "sutra.aws-agentless-scan-execution.v1", results, summary };
}
