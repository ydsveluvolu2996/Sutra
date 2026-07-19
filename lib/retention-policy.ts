export type RetentionTable =
  | "api_token_usage"
  | "security_events"
  | "api_idempotency_keys"
  | "cmdb_snapshots"
  | "cmdb_change_events"
  | "compliance_signoffs";

export interface RetentionRowMetadata {
  readonly id: string;
  readonly occurredAtMs: number;
}

const IMMUTABLE_TABLES = new Set<RetentionTable>([
  "cmdb_snapshots", "cmdb_change_events", "compliance_signoffs",
]);

export function retentionCutoff(keepDays: number, nowMs: number): number {
  if (!Number.isSafeInteger(keepDays) || keepDays < 1 || keepDays > 3_650 || !Number.isFinite(nowMs)) {
    throw Object.assign(new Error("The retention policy is invalid"), { code: "INVALID_INPUT" });
  }
  return nowMs - keepDays * 24 * 60 * 60 * 1_000;
}

/** Pure evidence-honest pruning decision. Audit/CMDB immutable tables never prune. */
export function selectRowsForPrune(input: {
  readonly table: RetentionTable;
  readonly keepDays: number;
  readonly nowMs: number;
  readonly rows: readonly RetentionRowMetadata[];
}): readonly string[] {
  if (IMMUTABLE_TABLES.has(input.table)) return [];
  const cutoff = retentionCutoff(input.keepDays, input.nowMs);
  return input.rows
    .filter((row) => typeof row.id === "string" && row.id.length > 0 && Number.isFinite(row.occurredAtMs) && row.occurredAtMs < cutoff)
    .map((row) => row.id);
}

export const LOCAL_RETENTION = Object.freeze({
  apiTokenUsageDays: 2,
  securityEventsDays: 30,
  idempotencyKeysDays: 30,
});
