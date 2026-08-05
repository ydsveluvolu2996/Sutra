/**
 * Read-only access to reconciled canonical billing generations.
 *
 * Every query repeats the live tenant/connection ownership predicate. Readers
 * only see rows reached through a partition's active_generation_id; staging or
 * failed replacement generations are never substituted for the active data.
 */
import type { CanonicalCurLine } from "../lib/finops-cur";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PARTITION_ID = /^fbp_[a-f0-9]{32}$/u;
const ROW_ID = /^fbl_[a-f0-9]{32}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const MAX_PARTITIONS = 36;
const MAX_MANIFEST_OBJECTS = 10_000;
const MAX_PAGE_ROWS = 1_000;
const MAX_PARTITION_ROWS = 250_000;
const MAX_TOTAL_ROWS = 250_000;
const MAX_CANONICAL_BYTES = 512 * 1_024;
const MAX_TOTAL_CANONICAL_BYTES = 128 * 1_024 * 1_024;
const SOURCE_FORMATS = new Set<CanonicalCurLine["sourceFormat"]>([
  "aws-cur",
  "focus",
]);
const SOURCE_VERSIONS = new Set<CanonicalCurLine["sourceVersion"]>([
  "2.0",
  "1.0",
  "1.2",
]);

export interface FinopsActiveBillingScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface FinopsActiveBillingEvidence {
  readonly activeManifestSha256: string;
  readonly activeSourceTable: string;
  readonly activeSourceFormat: CanonicalCurLine["sourceFormat"];
  readonly activeSourceVersion: CanonicalCurLine["sourceVersion"];
  readonly activeSourceUpdatedAtIso: string | null;
  readonly activeObservedAtIso: string;
  readonly activeCommittedAtIso: string;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  /** Null only when legacy active-manifest coverage cannot be proven. */
  readonly activeFileCount: number | null;
}

export interface FinopsActiveBillingPartition {
  readonly partitionId: string;
  readonly scope: FinopsReconciliationScope;
  readonly evidence: FinopsActiveBillingEvidence;
}

export interface FinopsActiveBillingRowPage {
  readonly scope: FinopsReconciliationScope;
  readonly evidence: FinopsActiveBillingEvidence;
  readonly rows: readonly ScopedCanonicalBillingRow[];
  readonly nextAfterId: string | null;
  readonly hasMore: boolean;
}

export interface FinopsActiveBillingDataset {
  readonly scope: FinopsReconciliationScope;
  readonly evidence: FinopsActiveBillingEvidence;
  readonly rows: readonly ScopedCanonicalBillingRow[];
}

export class FinopsActiveBillingQueryRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "GENERATION_MISMATCH"
    | "MALFORMED_CANONICAL_JSON"
    | "LIMIT_EXCEEDED";

  public constructor(
    code: FinopsActiveBillingQueryRepositoryError["code"],
  ) {
    super("Active FinOps billing query rejected");
    this.name = "FinopsActiveBillingQueryRepositoryError";
    this.code = code;
  }
}

interface ActivePartitionRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  export_name: string;
  billing_period: string;
  active_generation_id: string;
  active_manifest_sha256: string;
  active_source_table: string | null;
  active_source_format: CanonicalCurLine["sourceFormat"] | null;
  active_source_version: CanonicalCurLine["sourceVersion"] | null;
  active_source_updated_at: string | null;
  active_observed_at: string | null;
  active_committed_at: string | null;
  active_accepted_rows: number | string | null;
  active_rejected_rows: number | string | null;
  active_file_count: number | string | null;
}

interface ActiveCanonicalRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  export_name: string;
  billing_period: string;
  generation_id: string;
  line_item_id: string;
  source_format: CanonicalCurLine["sourceFormat"];
  source_version: CanonicalCurLine["sourceVersion"];
  canonical_json: string;
}

function reject(
  code: FinopsActiveBillingQueryRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new FinopsActiveBillingQueryRepositoryError(code);
}

function validText(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactCount(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return reject("GENERATION_MISMATCH");
  }
  return parsed;
}

function exactOptionalFileCount(value: unknown): number | null {
  if (value === null) return null;
  const parsed = exactCount(value);
  if (parsed < 1 || parsed > MAX_MANIFEST_OBJECTS) {
    return reject("GENERATION_MISMATCH");
  }
  return parsed;
}

function assertScope(scope: FinopsActiveBillingScope): void {
  if (
    scope === null
    || typeof scope !== "object"
    || !IDENTIFIER.test(scope.orgId)
    || !IDENTIFIER.test(scope.customerId)
    || !IDENTIFIER.test(scope.connectionId)
  ) reject();
}

function sameScope(
  left: FinopsReconciliationScope,
  right: FinopsReconciliationScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.exportName === right.exportName
    && left.billingPeriod === right.billingPeriod
    && left.generationId === right.generationId;
}

function samePartition(
  left: FinopsActiveBillingPartition,
  right: FinopsActiveBillingPartition,
): boolean {
  return left.partitionId === right.partitionId
    && sameScope(left.scope, right.scope)
    && left.evidence.activeManifestSha256
      === right.evidence.activeManifestSha256
    && left.evidence.activeSourceTable === right.evidence.activeSourceTable
    && left.evidence.activeSourceFormat === right.evidence.activeSourceFormat
    && left.evidence.activeSourceVersion === right.evidence.activeSourceVersion
    && left.evidence.activeSourceUpdatedAtIso
      === right.evidence.activeSourceUpdatedAtIso
    && left.evidence.activeObservedAtIso
      === right.evidence.activeObservedAtIso
    && left.evidence.activeCommittedAtIso
      === right.evidence.activeCommittedAtIso
    && left.evidence.acceptedRows === right.evidence.acceptedRows
    && left.evidence.rejectedRows === right.evidence.rejectedRows
    && left.evidence.activeFileCount === right.evidence.activeFileCount;
}

function assertPartition(
  owner: FinopsActiveBillingScope,
  partition: FinopsActiveBillingPartition,
): void {
  if (
    partition === null
    || typeof partition !== "object"
    || !PARTITION_ID.test(partition.partitionId)
    || partition.scope === null
    || typeof partition.scope !== "object"
    || partition.scope.organizationId !== owner.orgId
    || partition.scope.customerId !== owner.customerId
    || partition.scope.connectionId !== owner.connectionId
    || !validText(partition.scope.exportName, 256)
    || !PERIOD.test(partition.scope.billingPeriod)
    || !GENERATION_ID.test(partition.scope.generationId)
    || partition.evidence === null
    || typeof partition.evidence !== "object"
    || !SHA256.test(partition.evidence.activeManifestSha256)
    || !validText(partition.evidence.activeSourceTable, 1_024)
    || !SOURCE_FORMATS.has(partition.evidence.activeSourceFormat)
    || !SOURCE_VERSIONS.has(partition.evidence.activeSourceVersion)
    || (
      partition.evidence.activeSourceUpdatedAtIso !== null
      && !validIso(partition.evidence.activeSourceUpdatedAtIso)
    )
    || !validIso(partition.evidence.activeObservedAtIso)
    || !validIso(partition.evidence.activeCommittedAtIso)
    || !Number.isSafeInteger(partition.evidence.acceptedRows)
    || partition.evidence.acceptedRows < 0
    || !Number.isSafeInteger(partition.evidence.rejectedRows)
    || partition.evidence.rejectedRows < 0
    || (
      partition.evidence.activeFileCount !== null
      && (
        !Number.isSafeInteger(partition.evidence.activeFileCount)
        || partition.evidence.activeFileCount < 1
        || partition.evidence.activeFileCount > MAX_MANIFEST_OBJECTS
      )
    )
  ) reject();
  if (
    partition.evidence.acceptedRows > MAX_PARTITION_ROWS
    || partition.evidence.acceptedRows > MAX_TOTAL_ROWS
  ) reject("LIMIT_EXCEEDED");
}

function materializePartition(row: ActivePartitionRow): FinopsActiveBillingPartition {
  const acceptedRows = exactCount(row.active_accepted_rows);
  const rejectedRows = exactCount(row.active_rejected_rows);
  const activeFileCount = exactOptionalFileCount(row.active_file_count);
  const activeSourceTable = row.active_source_table;
  const activeSourceFormat = row.active_source_format;
  const activeSourceVersion = row.active_source_version;
  const activeObservedAtIso = row.active_observed_at;
  const activeCommittedAtIso = row.active_committed_at;
  if (
    !PARTITION_ID.test(row.id)
    || !IDENTIFIER.test(row.org_id)
    || !IDENTIFIER.test(row.customer_id)
    || !IDENTIFIER.test(row.connection_id)
    || !validText(row.export_name, 256)
    || !PERIOD.test(row.billing_period)
    || !GENERATION_ID.test(row.active_generation_id)
    || !SHA256.test(row.active_manifest_sha256)
    || !validText(activeSourceTable, 1_024)
    || activeSourceFormat === null
    || !SOURCE_FORMATS.has(activeSourceFormat)
    || activeSourceVersion === null
    || !SOURCE_VERSIONS.has(activeSourceVersion)
    || (
      row.active_source_updated_at !== null
      && !validIso(row.active_source_updated_at)
    )
    || !validIso(activeObservedAtIso)
    || !validIso(activeCommittedAtIso)
  ) reject("GENERATION_MISMATCH");
  if (acceptedRows > MAX_PARTITION_ROWS || acceptedRows > MAX_TOTAL_ROWS) {
    reject("LIMIT_EXCEEDED");
  }
  return {
    partitionId: row.id,
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
      exportName: row.export_name,
      billingPeriod: row.billing_period,
      generationId: row.active_generation_id,
    },
    evidence: {
      activeManifestSha256: row.active_manifest_sha256,
      activeSourceTable,
      activeSourceFormat,
      activeSourceVersion,
      activeSourceUpdatedAtIso: row.active_source_updated_at,
      activeObservedAtIso,
      activeCommittedAtIso,
      acceptedRows,
      rejectedRows,
      activeFileCount,
    },
  };
}

function parseCanonicalRow(
  raw: ActiveCanonicalRow,
  expected: FinopsActiveBillingPartition,
): ScopedCanonicalBillingRow {
  const rawScope: FinopsReconciliationScope = {
    organizationId: raw.org_id,
    customerId: raw.customer_id,
    connectionId: raw.connection_id,
    exportName: raw.export_name,
    billingPeriod: raw.billing_period,
    generationId: raw.generation_id,
  };
  if (
    !ROW_ID.test(raw.id)
    || !sameScope(rawScope, expected.scope)
    || raw.source_format !== expected.evidence.activeSourceFormat
    || raw.source_version !== expected.evidence.activeSourceVersion
    || typeof raw.canonical_json !== "string"
  ) reject("GENERATION_MISMATCH");
  if (
    new TextEncoder().encode(raw.canonical_json).byteLength
      > MAX_CANONICAL_BYTES
  ) reject("LIMIT_EXCEEDED");

  let line: unknown;
  try {
    line = JSON.parse(raw.canonical_json) as unknown;
  } catch {
    return reject("MALFORMED_CANONICAL_JSON");
  }
  if (
    line === null
    || typeof line !== "object"
    || Array.isArray(line)
    || !validText((line as Partial<CanonicalCurLine>).lineItemId, 4_096)
    || (line as Partial<CanonicalCurLine>).lineItemId !== raw.line_item_id
    || (line as Partial<CanonicalCurLine>).sourceFormat
      !== expected.evidence.activeSourceFormat
    || (line as Partial<CanonicalCurLine>).sourceVersion
      !== expected.evidence.activeSourceVersion
  ) reject("MALFORMED_CANONICAL_JSON");

  return {
    ...expected.scope,
    line: line as CanonicalCurLine,
  };
}

export class FinopsActiveBillingQueryRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /**
   * List the newest visible active partitions. The fixed upper bound prevents
   * an unbounded export catalog from becoming a route-level memory sink.
   */
  public async listActivePartitions(
    scope: FinopsActiveBillingScope,
  ): Promise<readonly FinopsActiveBillingPartition[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT p.id, p.org_id, p.customer_id, p.connection_id, p.export_name,
              p.billing_period, p.active_generation_id,
              p.active_manifest_sha256, p.active_source_table,
              p.active_source_format, p.active_source_version,
              p.active_source_updated_at, p.active_observed_at,
              p.active_committed_at, p.active_accepted_rows,
              p.active_rejected_rows, p.active_file_count
         FROM finops_export_partitions p
         JOIN aws_connections c
           ON c.id = p.connection_id AND c.org_id = p.org_id
          AND c.customer_id = p.customer_id
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
        WHERE p.org_id = ? AND p.customer_id = ? AND p.connection_id = ?
          AND p.active_generation_id IS NOT NULL
          AND p.active_manifest_sha256 IS NOT NULL
          AND p.active_committed_at IS NOT NULL
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          AND cu.status IN ('active', 'trial')
        ORDER BY p.billing_period DESC, p.active_committed_at DESC,
                 p.export_name ASC, p.active_generation_id ASC
        LIMIT ?`,
    ).bind(
      scope.orgId,
      scope.customerId,
      scope.connectionId,
      MAX_PARTITIONS,
    ).all<ActivePartitionRow>();
    const partitions = (rows.results ?? []).map(materializePartition);
    if (partitions.length === 0) {
      await this.assertLiveScope(db, scope);
    }
    return partitions;
  }

  /**
   * Read one deterministic ID-keyset page from the exact active generation.
   */
  public async pageActiveRows(
    owner: FinopsActiveBillingScope,
    partition: FinopsActiveBillingPartition,
    options: {
      readonly afterId?: string;
      readonly limit?: number;
    } = {},
  ): Promise<FinopsActiveBillingRowPage> {
    assertScope(owner);
    assertPartition(owner, partition);
    const afterId = options.afterId ?? "";
    const limit = options.limit ?? MAX_PAGE_ROWS;
    if (
      (afterId !== "" && !ROW_ID.test(afterId))
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_PAGE_ROWS
    ) reject();

    const db = await this.ready();
    await this.assertCurrentPartition(db, owner, partition);
    const result = await db.prepare(
      `SELECT l.id, l.org_id, l.customer_id, l.connection_id, l.export_name,
              l.billing_period, l.generation_id, l.line_item_id, l.source_format,
              l.source_version, l.canonical_json
         FROM finops_billing_lines_v2 l
         JOIN finops_export_partitions p
           ON p.org_id = l.org_id AND p.customer_id = l.customer_id
          AND p.connection_id = l.connection_id
          AND p.export_name = l.export_name
          AND p.billing_period = l.billing_period
          AND p.active_generation_id = l.generation_id
         JOIN aws_connections c
           ON c.id = l.connection_id AND c.org_id = l.org_id
          AND c.customer_id = l.customer_id
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
        WHERE p.id = ?
          AND l.org_id = ? AND l.customer_id = ? AND l.connection_id = ?
          AND l.export_name = ? AND l.billing_period = ?
          AND l.generation_id = ? AND p.active_generation_id = ?
          AND p.active_manifest_sha256 = ?
          AND l.id > ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          AND cu.status IN ('active', 'trial')
        ORDER BY l.id ASC
        LIMIT ?`,
    ).bind(
      partition.partitionId,
      owner.orgId,
      owner.customerId,
      owner.connectionId,
      partition.scope.exportName,
      partition.scope.billingPeriod,
      partition.scope.generationId,
      partition.scope.generationId,
      partition.evidence.activeManifestSha256,
      afterId,
      limit,
    ).all<ActiveCanonicalRow>();
    const rawRows = result.results ?? [];
    if (rawRows.length === 0) {
      await this.assertLiveScope(db, owner);
    }
    let previousId = afterId;
    for (const row of rawRows) {
      if (!ROW_ID.test(row.id) || row.id <= previousId) {
        reject("GENERATION_MISMATCH");
      }
      previousId = row.id;
    }
    const rows = rawRows.map((row) => parseCanonicalRow(row, partition));
    return {
      scope: partition.scope,
      evidence: partition.evidence,
      rows,
      nextAfterId: rawRows.length === 0
        ? null
        : rawRows[rawRows.length - 1]?.id ?? null,
      hasMore: rawRows.length === limit,
    };
  }

  /**
   * Materialize exactly one active partition for a pure Foundational engine.
   * Count and byte ceilings are checked before and during pagination.
   */
  public async loadActivePartition(
    owner: FinopsActiveBillingScope,
    partition: FinopsActiveBillingPartition,
  ): Promise<FinopsActiveBillingDataset> {
    assertScope(owner);
    assertPartition(owner, partition);
    const rows: ScopedCanonicalBillingRow[] = [];
    let afterId = "";
    let totalBytes = 0;

    for (;;) {
      const page = await this.pageActiveRows(owner, partition, {
        ...(afterId === "" ? {} : { afterId }),
        limit: MAX_PAGE_ROWS,
      });
      for (const row of page.rows) {
        rows.push(row);
        totalBytes += new TextEncoder().encode(
          JSON.stringify(row.line),
        ).byteLength;
        if (
          rows.length > MAX_PARTITION_ROWS
          || rows.length > MAX_TOTAL_ROWS
          || totalBytes > MAX_TOTAL_CANONICAL_BYTES
        ) reject("LIMIT_EXCEEDED");
      }
      if (!page.hasMore) break;
      if (page.nextAfterId === null || page.nextAfterId === afterId) {
        reject("GENERATION_MISMATCH");
      }
      afterId = page.nextAfterId;
    }
    if (rows.length !== partition.evidence.acceptedRows) {
      reject("GENERATION_MISMATCH");
    }
    return {
      scope: partition.scope,
      evidence: partition.evidence,
      rows,
    };
  }

  private async assertLiveScope(
    db: D1Database,
    scope: FinopsActiveBillingScope,
  ): Promise<void> {
    const live = await db.prepare(
      `SELECT c.id
         FROM aws_connections c
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
        WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          AND cu.status IN ('active', 'trial')
        LIMIT 1`,
    ).bind(
      scope.connectionId,
      scope.orgId,
      scope.customerId,
    ).first<{ id: string }>();
    if (live === null) reject("SCOPE_NOT_FOUND");
  }

  private async assertCurrentPartition(
    db: D1Database,
    owner: FinopsActiveBillingScope,
    expected: FinopsActiveBillingPartition,
  ): Promise<void> {
    const row = await db.prepare(
      `SELECT p.id, p.org_id, p.customer_id, p.connection_id, p.export_name,
              p.billing_period, p.active_generation_id,
              p.active_manifest_sha256, p.active_source_table,
              p.active_source_format, p.active_source_version,
              p.active_source_updated_at, p.active_observed_at,
              p.active_committed_at, p.active_accepted_rows,
              p.active_rejected_rows, p.active_file_count
         FROM finops_export_partitions p
         JOIN aws_connections c
           ON c.id = p.connection_id AND c.org_id = p.org_id
          AND c.customer_id = p.customer_id
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
        WHERE p.id = ? AND p.org_id = ? AND p.customer_id = ?
          AND p.connection_id = ?
          AND p.active_generation_id IS NOT NULL
          AND p.active_manifest_sha256 IS NOT NULL
          AND p.active_committed_at IS NOT NULL
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          AND cu.status IN ('active', 'trial')
        LIMIT 1`,
    ).bind(
      expected.partitionId,
      owner.orgId,
      owner.customerId,
      owner.connectionId,
    ).first<ActivePartitionRow>();
    if (row === null) {
      await this.assertLiveScope(db, owner);
      reject("GENERATION_MISMATCH");
    }
    const current = materializePartition(row);
    if (!samePartition(current, expected)) reject("GENERATION_MISMATCH");
  }
}
