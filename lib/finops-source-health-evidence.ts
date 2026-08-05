import type {
  FinopsActiveBillingPartition,
} from "../db/finops-active-billing-query-repository";
import type { PilotConnection, PilotState, PilotSyncRun } from "./pilot-types";
import type {
  FinopsSourceEvidence,
  FinopsSourceId,
  FinopsSourceScope,
} from "./finops-source-health";

const MAX_ACTIVE_PARTITIONS = 36;
const MAX_PARTITION_RECORDS = 250_000;
const MAX_HISTORY_RECORDS =
  MAX_ACTIVE_PARTITIONS * MAX_PARTITION_RECORDS;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface PersistedFinopsEvidenceInput {
  readonly scope: FinopsSourceScope;
  readonly connection: PilotConnection;
  readonly pilotState: PilotState;
  readonly activeBillingPartitions:
    readonly FinopsActiveBillingPartition[];
}

export class PersistedFinopsEvidenceError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_MISMATCH"
    | "LIMIT_EXCEEDED";

  public constructor(code: PersistedFinopsEvidenceError["code"]) {
    super("Persisted FinOps source evidence rejected");
    this.name = "PersistedFinopsEvidenceError";
    this.code = code;
  }
}

function sumObservedItems(
  entries: PilotState["coverage"] | NonNullable<PilotState["latestRunCoverage"]>["entries"],
): number {
  return entries.reduce(
    (total, entry) => total + (Number.isSafeInteger(entry.itemsObserved) && entry.itemsObserved >= 0 ? entry.itemsObserved : 0),
    0,
  );
}

function attemptOutcome(run: PilotSyncRun | undefined): FinopsSourceEvidence["lastAttemptOutcome"] {
  if (run === undefined) return null;
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "partial") return "partial";
  if (run.status === "failed" || run.status === "cancelled") return "failed";
  if (run.status === "queued" || run.status === "running") return "in_progress";
  return "unknown";
}

function attemptTime(run: PilotSyncRun | undefined): string | null {
  return run?.finishedAt ?? run?.startedAt ?? run?.createdAt ?? null;
}

function inventoryEvidence(input: PersistedFinopsEvidenceInput): FinopsSourceEvidence {
  const liveConnection = input.connection.sourceKind === "aws_trust_role";
  const configured = liveConnection && input.connection.status !== "disabled";
  // Fixture runs are intentionally not projected into the readiness state at
  // all. Their existence may be useful in a demo workspace, but it is not
  // evidence of a customer AWS source delivery.
  const latestRun = liveConnection ? input.pilotState.syncRuns[0] : undefined;
  const outcome = attemptOutcome(latestRun);
  const activeLiveSnapshot =
    liveConnection
    &&
    input.pilotState.activeSnapshot !== null
    && input.pilotState.activeSnapshot.origin.kind === "aws_live";
  const delivered = liveConnection
    && (activeLiveSnapshot || input.connection.lastSuccessfulSyncAt !== null);
  const collectionPartial =
    liveConnection
    && (
      latestRun?.coverageState === "partial"
      || input.pilotState.latestRunCoverage?.entries.some((entry) =>
        entry.status === "partial" || entry.status === "failed"
      ) === true
    );
  const coverageAssessment =
    collectionPartial
      ? "partial"
      : delivered
        && (
          latestRun?.coverageState === "complete"
          || input.pilotState.activeSnapshot?.coverageState === "complete"
        )
        ? "complete"
        : "unknown";
  const latestFailed = outcome === "failed";
  const latestAttemptFinished =
    latestRun?.status === "succeeded"
    || latestRun?.status === "partial"
    || latestRun?.status === "failed"
    || latestRun?.status === "cancelled";
  const coverageEntries =
    latestAttemptFinished && input.pilotState.latestRunCoverage !== null
      ? input.pilotState.latestRunCoverage.entries
      : input.pilotState.coverage;

  return {
    scope: input.scope,
    sourceId: "data_collection_telemetry",
    configured,
    deliveryObserved: delivered,
    lastAttemptAt: attemptTime(latestRun),
    lastAttemptOutcome: outcome,
    lastSuccessAt: liveConnection ? input.connection.lastSuccessfulSyncAt : null,
    dataThroughAt: activeLiveSnapshot ? input.pilotState.activeSnapshot?.collectedAt ?? null : null,
    coverage: {
      assessment: coverageAssessment,
      acceptedRecords: delivered ? sumObservedItems(coverageEntries) : null,
      // Inventory enumerations do not expose an authoritative expected resource
      // count. "Complete" means all declared collectors completed, not that an
      // unknown account-wide resource count was guessed.
      expectedRecords: null,
      rejectedRecords: null,
    },
    lastError: latestFailed
      ? {
          code: latestRun?.status === "cancelled" ? "COLLECTION_CANCELLED" : "COLLECTION_FAILED",
          message: latestRun?.status === "cancelled"
            ? "The latest AWS inventory collection was cancelled."
            : "The latest AWS inventory collection failed.",
          at: attemptTime(latestRun) ?? latestRun?.createdAt ?? input.connection.updatedAt,
        }
      : null,
    evidenceBasis: liveConnection
      ? "Tenant-scoped AWS connection, sync run, collector coverage, and active live snapshot records."
      : "Simulated fixture collection is excluded from production readiness.",
    limitations: [
      "Inventory collector health does not prove that separate billing, recommendation, support, compliance, or service telemetry exports are configured.",
      ...(!liveConnection ? ["Fixture data is not accepted as live FinOps source evidence."] : []),
    ],
  };
}

type SupportedBillingSourceId =
  | "aws_cur2_data_export"
  | "aws_focus_1_2_data_export";

function reject(
  code: PersistedFinopsEvidenceError["code"] = "INVALID_INPUT",
): never {
  throw new PersistedFinopsEvidenceError(code);
}

function validIso(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function assertInput(input: PersistedFinopsEvidenceInput): void {
  if (
    input === null
    || typeof input !== "object"
    || input.scope === null
    || typeof input.scope !== "object"
    || !IDENTIFIER.test(input.scope.orgId)
    || !IDENTIFIER.test(input.scope.customerId)
    || !IDENTIFIER.test(input.scope.connectionId)
    || input.connection === null
    || typeof input.connection !== "object"
    || input.connection.id !== input.scope.connectionId
    || input.connection.customerId !== input.scope.customerId
    || input.pilotState === null
    || typeof input.pilotState !== "object"
    || !Array.isArray(input.activeBillingPartitions)
  ) reject();
  if (input.activeBillingPartitions.length > MAX_ACTIVE_PARTITIONS) {
    reject("LIMIT_EXCEEDED");
  }
  for (const partition of input.activeBillingPartitions) {
    if (
      partition === null
      || typeof partition !== "object"
      || partition.scope === null
      || typeof partition.scope !== "object"
      || partition.evidence === null
      || typeof partition.evidence !== "object"
      || partition.scope.organizationId !== input.scope.orgId
      || partition.scope.customerId !== input.scope.customerId
      || partition.scope.connectionId !== input.scope.connectionId
    ) reject("SCOPE_MISMATCH");
    const { evidence } = partition;
    if (
      !IDENTIFIER.test(partition.scope.organizationId)
      || !IDENTIFIER.test(partition.scope.customerId)
      || !IDENTIFIER.test(partition.scope.connectionId)
      || typeof partition.scope.exportName !== "string"
      || partition.scope.exportName.length === 0
      || partition.scope.exportName.length > 256
      || !PERIOD.test(partition.scope.billingPeriod)
      || !GENERATION_ID.test(partition.scope.generationId)
      || !SHA256.test(evidence.activeManifestSha256)
      || typeof evidence.activeSourceTable !== "string"
      || evidence.activeSourceTable.length === 0
      || evidence.activeSourceTable.length > 1_024
      || !Number.isSafeInteger(evidence.acceptedRows)
      || evidence.acceptedRows < 0
      || !Number.isSafeInteger(evidence.rejectedRows)
      || evidence.rejectedRows < 0
      || evidence.acceptedRows + evidence.rejectedRows
        > MAX_PARTITION_RECORDS
      || !Number.isSafeInteger(
        evidence.acceptedRows + evidence.rejectedRows,
      )
      || !validIso(evidence.activeObservedAtIso)
      || !validIso(evidence.activeCommittedAtIso)
      || (
        evidence.activeSourceUpdatedAtIso !== null
        && !validIso(evidence.activeSourceUpdatedAtIso)
      )
    ) reject("INVALID_INPUT");
  }
}

function sourceIdFor(
  partition: FinopsActiveBillingPartition,
): SupportedBillingSourceId | null {
  if (
    partition.evidence.activeSourceFormat === "aws-cur"
    && partition.evidence.activeSourceVersion === "2.0"
  ) return "aws_cur2_data_export";
  if (
    partition.evidence.activeSourceFormat === "focus"
    && partition.evidence.activeSourceVersion === "1.2"
  ) return "aws_focus_1_2_data_export";
  return null;
}

function newestFirst(
  left: FinopsActiveBillingPartition,
  right: FinopsActiveBillingPartition,
): number {
  return right.scope.billingPeriod.localeCompare(left.scope.billingPeriod)
    || right.evidence.activeCommittedAtIso.localeCompare(
      left.evidence.activeCommittedAtIso,
    )
    || left.scope.exportName.localeCompare(right.scope.exportName)
    || left.scope.generationId.localeCompare(right.scope.generationId);
}

function sameExportDefinition(
  left: FinopsActiveBillingPartition,
  right: FinopsActiveBillingPartition,
): boolean {
  return left.scope.exportName === right.scope.exportName
    && left.evidence.activeSourceTable
      === right.evidence.activeSourceTable
    && left.evidence.activeSourceFormat
      === right.evidence.activeSourceFormat
    && left.evidence.activeSourceVersion
      === right.evidence.activeSourceVersion;
}

/**
 * Select one newest export definition for a source kind. A second definition
 * with an overlapping period is never merged into its record counts.
 */
function canonicalHistory(
  partitions: readonly FinopsActiveBillingPartition[],
  sourceId?: SupportedBillingSourceId,
): readonly FinopsActiveBillingPartition[] {
  const eligible = [...partitions]
    .filter((partition) => {
      const partitionSourceId = sourceIdFor(partition);
      return partitionSourceId !== null
        && (sourceId === undefined || partitionSourceId === sourceId);
    })
    .sort(newestFirst);
  const newest = eligible[0];
  if (newest === undefined) return [];
  const periods = new Set<string>();
  return eligible.flatMap((partition) => {
    if (
      !sameExportDefinition(partition, newest)
      || periods.has(partition.scope.billingPeriod)
    ) return [];
    periods.add(partition.scope.billingPeriod);
    return [partition];
  });
}

function historyCounts(
  history: readonly FinopsActiveBillingPartition[],
): {
  readonly acceptedRecords: number;
  readonly rejectedRecords: number;
  readonly expectedRecords: number;
} {
  let acceptedRecords = 0;
  let rejectedRecords = 0;
  for (const partition of history) {
    acceptedRecords += partition.evidence.acceptedRows;
    rejectedRecords += partition.evidence.rejectedRows;
    if (
      !Number.isSafeInteger(acceptedRecords)
      || !Number.isSafeInteger(rejectedRecords)
      || acceptedRecords > MAX_HISTORY_RECORDS
      || rejectedRecords > MAX_HISTORY_RECORDS
    ) reject("LIMIT_EXCEEDED");
  }
  const expectedRecords = acceptedRecords + rejectedRecords;
  if (
    !Number.isSafeInteger(expectedRecords)
    || expectedRecords > MAX_HISTORY_RECORDS
  ) reject("LIMIT_EXCEEDED");
  return { acceptedRecords, rejectedRecords, expectedRecords };
}

function activeBillingEvidence(
  input: PersistedFinopsEvidenceInput,
  sourceId: FinopsSourceId,
  history: readonly FinopsActiveBillingPartition[],
): FinopsSourceEvidence {
  const newest = history[0];
  if (newest === undefined) return reject();
  const counts = historyCounts(history);
  const partial = counts.rejectedRecords > 0;
  const sourceKind =
    `${newest.evidence.activeSourceFormat}/${newest.evidence.activeSourceVersion}`;
  return {
    scope: input.scope,
    sourceId,
    configured: true,
    deliveryObserved: true,
    lastAttemptAt: newest.evidence.activeObservedAtIso,
    lastAttemptOutcome: partial ? "partial" : "succeeded",
    lastSuccessAt: newest.evidence.activeCommittedAtIso,
    dataThroughAt:
      newest.evidence.activeSourceUpdatedAtIso
      ?? newest.evidence.activeObservedAtIso,
    coverage: {
      assessment: partial ? "partial" : "complete",
      ...counts,
    },
    lastError: null,
    evidenceBasis:
      `Immutable active billing generations; source=${sourceKind}; `
      + `exportName=${newest.scope.exportName}; `
      + `sourceTable=${newest.evidence.activeSourceTable}; `
      + `newestGenerationId=${newest.scope.generationId}; `
      + `periods=${history.length}.`,
    limitations: [
      "Coverage is ingestion acceptance for one canonical export definition and does not by itself prove invoice reconciliation.",
      "Only immutable active-generation source, observation, commit, and row-count evidence is used; staging delivery fields are excluded.",
    ],
  };
}

function billingWorkspaceEvidence(
  input: PersistedFinopsEvidenceInput,
  history: readonly FinopsActiveBillingPartition[],
): FinopsSourceEvidence {
  const liveConnection =
    input.connection.sourceKind === "aws_trust_role"
    && input.connection.status === "active";
  if (!liveConnection || history.length === 0) {
    return {
      scope: input.scope,
      sourceId: "sutra_billing_workspace",
      configured: false,
      deliveryObserved: false,
      lastAttemptAt: null,
      lastAttemptOutcome: null,
      lastSuccessAt: null,
      dataThroughAt: null,
      coverage: {
        assessment: "unknown",
        acceptedRecords: null,
        expectedRecords: null,
        rejectedRecords: null,
      },
      lastError: null,
      evidenceBasis: liveConnection
        ? "No supported immutable active billing generation is persisted."
        : "Simulated fixture billing is excluded from production readiness.",
      limitations: [
        ...(!liveConnection
          ? ["Fixture data is not accepted as live FinOps source evidence."]
          : []),
      ],
    };
  }
  return activeBillingEvidence(
    input,
    "sutra_billing_workspace",
    history,
  );
}

export function buildPersistedFinopsSourceEvidence(
  input: PersistedFinopsEvidenceInput,
): readonly FinopsSourceEvidence[] {
  assertInput(input);
  const liveConnection =
    input.connection.sourceKind === "aws_trust_role"
    && input.connection.status === "active";
  const evidence: FinopsSourceEvidence[] = [inventoryEvidence(input)];
  if (liveConnection) {
    for (const sourceId of [
      "aws_cur2_data_export",
      "aws_focus_1_2_data_export",
    ] as const) {
      const history = canonicalHistory(
        input.activeBillingPartitions,
        sourceId,
      );
      if (history.length > 0) {
        evidence.push(activeBillingEvidence(input, sourceId, history));
      }
    }
  }
  evidence.push(billingWorkspaceEvidence(
    input,
    liveConnection
      ? canonicalHistory(input.activeBillingPartitions)
      : [],
  ));
  return evidence;
}
