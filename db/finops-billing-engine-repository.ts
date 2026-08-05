/**
 * Canonical FinOps billing persistence.
 *
 * A billing-period partition has one visible generation and, at most, one
 * staging generation. Corrected AWS Data Export deliveries are written under
 * the staging generation; readers join through active_generation_id, so a
 * partial or failed refresh can never replace the last reconciled delivery.
 */
import { canonicalJson } from "../lib/canonical-json";
import type { CanonicalCurLine } from "../lib/finops-cur";
import type { ValidatedFinopsManifest } from "../lib/finops-data-export";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MONEY = /^-?\d{1,19}$/u;
const TOTAL = /^-?\d{1,128}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const MAX_TEXT = 4_096;
const MAX_CANONICAL_BYTES = 512 * 1_024;
const MAX_STAGE_CHUNK = 250;
const MAX_QUERY_ROWS = 1_000;
const MAX_MANIFEST_OBJECTS = 10_000;
const AGGREGATE_PAGE_SIZE = 1_000;
const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = (BigInt(2) ** BigInt(63)) - BigInt(1);
const CHARGE_KINDS = new Set([
  "usage", "purchase", "tax", "credit", "refund", "discount", "adjustment", "other",
]);

export interface FinopsBillingScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface FinopsBillingGeneration {
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly generationId: string;
}

export type BeginFinopsBillingGenerationResult =
  | {
      readonly action: "stage";
      readonly reason: "first_delivery" | "corrected_delivery" | "resume_delivery";
      readonly generation: FinopsBillingGeneration;
    }
  | {
      readonly action: "skip";
      readonly reason: "duplicate_manifest";
      readonly generation: FinopsBillingGeneration;
    };

export interface StageFinopsBillingLinesResult {
  readonly generation: FinopsBillingGeneration;
  readonly stagedRows: number;
}

export interface FinopsBillingReconciliation {
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  /** Objects actually exhausted by the trusted ingestion loop. */
  readonly processedObjectCount: number;
  /** Exact signed integer micro-unit totals, keyed by ISO currency. */
  readonly currencyTotals: Readonly<Record<string, string>>;
}

export interface CommitFinopsBillingGenerationResult {
  readonly generation: FinopsBillingGeneration;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
  readonly processedObjectCount: number;
  readonly currencyTotals: Readonly<Record<string, string>>;
  readonly alreadyCommitted: boolean;
  readonly committedAtIso: string;
}

export interface ActiveFinopsBillingLine {
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly generationId: string;
  readonly line: CanonicalCurLine;
}

export interface ActiveFinopsBillingLineQuery {
  readonly exportName?: string;
  readonly billingPeriod?: string;
  readonly service?: string;
  readonly usageAccountId?: string;
  readonly resourceId?: string;
  readonly limit?: number;
}

export interface ActiveFinopsCurrencyTotal {
  readonly currency: string;
  readonly amountMicros: string;
  readonly lineCount: number;
}

export class FinopsBillingEngineRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "IMMUTABLE_OBJECT_CHANGED"
    | "GENERATION_MISMATCH"
    | "LINE_CONFLICT"
    | "ROW_COUNT_MISMATCH"
    | "OBJECT_COUNT_MISMATCH"
    | "CURRENCY_TOTAL_MISMATCH"
    | "LIMIT_EXCEEDED";

  public constructor(code: FinopsBillingEngineRepositoryError["code"]) {
    super("FinOps billing operation rejected");
    this.name = "FinopsBillingEngineRepositoryError";
    this.code = code;
  }
}

interface PartitionRow {
  active_generation_id: string | null;
  active_manifest_sha256: string | null;
  active_manifest_version_id: string | null;
  active_source_table: string | null;
  active_source_format: CanonicalCurLine["sourceFormat"] | null;
  active_source_version: CanonicalCurLine["sourceVersion"] | null;
  active_source_updated_at: string | null;
  active_observed_at: string | null;
  active_accepted_rows: number | string | null;
  active_rejected_rows: number | string | null;
  active_file_count: number | string | null;
  active_currency_totals_json: string | null;
  active_committed_at: string | null;
  staging_generation_id: string | null;
  staging_manifest_sha256: string | null;
  manifest_version_id: string | null;
  status: "staging" | "ready" | "failed";
  accepted_rows: number | string;
  rejected_rows: number | string;
  file_count: number | string;
  currency_totals_json: string | null;
  committed_at: string | null;
}

interface StageAmountRow {
  id: string;
  currency: string;
  amount_micros: string | number;
}

interface ActiveLineRow {
  export_name: string;
  billing_period: string;
  generation_id: string;
  canonical_json: string;
}

function reject(code: FinopsBillingEngineRepositoryError["code"] = "INVALID_INPUT"): never {
  throw new FinopsBillingEngineRepositoryError(code);
}

function validShortText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

function assertScope(scope: FinopsBillingScope): void {
  if (
    scope === null
    || typeof scope !== "object"
    || !IDENTIFIER.test(scope.orgId)
    || !IDENTIFIER.test(scope.customerId)
    || !IDENTIFIER.test(scope.connectionId)
  ) reject();
}

function assertGeneration(generation: FinopsBillingGeneration): void {
  if (
    generation === null
    || typeof generation !== "object"
    || !validShortText(generation.exportName, 256)
    || !PERIOD.test(generation.billingPeriod)
    || !GENERATION_ID.test(generation.generationId)
  ) reject();
}

function sourceFromManifest(manifest: ValidatedFinopsManifest): {
  readonly table: string;
  readonly format: CanonicalCurLine["sourceFormat"];
  readonly version: CanonicalCurLine["sourceVersion"];
} {
  if (manifest.sourceTableName !== null && !validShortText(manifest.sourceTableName, 1_024)) reject();
  switch (manifest.table) {
    case "cur-2.0":
      return { table: manifest.sourceTableName ?? manifest.table, format: "aws-cur", version: "2.0" };
    case "focus-1.0-aws":
      return { table: manifest.sourceTableName ?? manifest.table, format: "focus", version: "1.0" };
    case "focus-1.2-aws":
      return { table: manifest.sourceTableName ?? manifest.table, format: "focus", version: "1.2" };
    default:
      return reject();
  }
}

function assertManifest(manifest: ValidatedFinopsManifest): void {
  if (
    manifest === null
    || typeof manifest !== "object"
    || manifest.scope === null
    || typeof manifest.scope !== "object"
    || !IDENTIFIER.test(manifest.scope.organizationId)
    || !IDENTIFIER.test(manifest.scope.customerId)
    || !IDENTIFIER.test(manifest.scope.connectionId)
    || !validShortText(manifest.exportName, 256)
    || !PERIOD.test(manifest.billingPeriod)
    || !SHA256.test(manifest.manifestSha256)
    || !SHA256.test(manifest.schemaSha256)
    || manifest.manifest === null
    || typeof manifest.manifest !== "object"
    || !validShortText(manifest.manifest.bucket, 255)
    || !validShortText(manifest.manifest.key, 1_024)
    || !Array.isArray(manifest.columns)
    || manifest.columns.length === 0
    || manifest.columns.length > 2_000
    || !Array.isArray(manifest.dataFiles)
    || manifest.dataFiles.length === 0
    || manifest.dataFiles.length > 10_000
    || (manifest.eTag !== null && !validShortText(manifest.eTag, 1_024))
    || (manifest.versionId !== null && !validShortText(manifest.versionId, 1_024))
    || !validIso(manifest.periodStartIso)
    || manifest.periodStartIso.slice(0, 7) !== manifest.billingPeriod
    || !validIso(manifest.periodEndIso)
    || Date.parse(manifest.periodEndIso) <= Date.parse(manifest.periodStartIso)
    || !validIso(manifest.observedAtIso)
    || (manifest.sourceUpdatedAtIso !== null && !validIso(manifest.sourceUpdatedAtIso))
  ) reject();
  if (
    manifest.columns.some((column) => !validShortText(column, 1_024))
    || manifest.dataFiles.some((file) => (
      file === null
      || typeof file !== "object"
      || file.bucket !== manifest.manifest.bucket
      || !validShortText(file.key, 1_024)
    ))
  ) reject();
  sourceFromManifest(manifest);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactInt64(value: unknown, nullable = false): value is string | null {
  if (value === null) return nullable;
  if (typeof value !== "string" || !MONEY.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed >= INT64_MIN && parsed <= INT64_MAX;
  } catch {
    return false;
  }
}

function assertCanonicalLine(
  line: CanonicalCurLine,
  source: { readonly format: CanonicalCurLine["sourceFormat"]; readonly version: CanonicalCurLine["sourceVersion"] },
  billingPeriod: string,
): string {
  if (
    line === null
    || typeof line !== "object"
    || line.sourceFormat !== source.format
    || line.sourceVersion !== source.version
    || !validShortText(line.lineItemId)
    || !validShortText(line.usageAccountId, 256)
    || !validShortText(line.service, 1_024)
    || !validShortText(line.chargeCategory, 512)
    || !CHARGE_KINDS.has(line.chargeKind)
    || !validIso(line.usageStartIso)
    || (line.usageEndIso !== null && !validIso(line.usageEndIso))
    || (line.billingPeriodStartIso !== null && (
      !validIso(line.billingPeriodStartIso) || line.billingPeriodStartIso.slice(0, 7) !== billingPeriod
    ))
    || !exactInt64(line.amountMicros)
    || !exactInt64(line.netUnblendedCostMicros, true)
    || !exactInt64(line.amortizedMicros, true)
    || !exactInt64(line.listCostMicros, true)
    || !exactInt64(line.contractedCostMicros, true)
    || !exactInt64(line.publicOnDemandCostMicros, true)
    || !CURRENCY.test(line.currency)
  ) reject();
  let serialized: string;
  try {
    serialized = canonicalJson(line);
  } catch {
    return reject();
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CANONICAL_BYTES) reject("LIMIT_EXCEEDED");
  return serialized;
}

function generationFor(manifestSha256: string): string {
  return `fbg_${manifestSha256}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseCurrencyTotals(value: string | null): Readonly<Record<string, string>> {
  if (value === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return reject("GENERATION_MISMATCH");
  }
  return normalizedCurrencyTotals(parsed);
}

function normalizedCurrencyTotals(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject();
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  if (entries.length > 128) reject("LIMIT_EXCEEDED");
  for (const [currency, amount] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!CURRENCY.test(currency) || typeof amount !== "string" || !TOTAL.test(amount)) reject();
    try {
      result[currency] = BigInt(amount).toString();
    } catch {
      reject();
    }
  }
  return result;
}

function sameCurrencyTotals(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((currency) => right[currency] === left[currency]);
}

function assertReconciliation(input: FinopsBillingReconciliation): Readonly<Record<string, string>> {
  if (
    input === null
    || typeof input !== "object"
    || !Number.isSafeInteger(input.acceptedRows)
    || input.acceptedRows < 0
    || !Number.isSafeInteger(input.rejectedRows)
    || input.rejectedRows < 0
    || !Number.isSafeInteger(input.processedObjectCount)
    || input.processedObjectCount < 1
    || input.processedObjectCount > MAX_MANIFEST_OBJECTS
  ) reject();
  return normalizedCurrencyTotals(input.currencyTotals);
}

function partitionWhere(): string {
  return "org_id = ? AND customer_id = ? AND connection_id = ? AND export_name = ? AND billing_period = ?";
}

export class FinopsBillingEngineRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /**
   * Begin (or resume) ingestion of a validated AWS Data Export manifest.
   * The manifest scope is the authorization scope; only an active, real
   * aws_trust_role connection owned by that tenant can create a generation.
   */
  public async beginValidatedManifest(
    manifest: ValidatedFinopsManifest,
    now = Date.now(),
  ): Promise<BeginFinopsBillingGenerationResult> {
    assertManifest(manifest);
    if (!Number.isFinite(now)) reject();
    const expectedSchemaSha256 = await sha256Hex(canonicalJson(manifest.columns));
    const expectedManifestSha256 = await sha256Hex(canonicalJson({
      exportName: manifest.exportName,
      sourceTableName: manifest.sourceTableName,
      billingPeriod: manifest.billingPeriod,
      periodStartIso: manifest.periodStartIso,
      periodEndIso: manifest.periodEndIso,
      columns: manifest.columns,
      dataFiles: manifest.dataFiles.map((file) => file.key),
    }));
    if (
      manifest.schemaSha256 !== expectedSchemaSha256
      || manifest.manifestSha256 !== expectedManifestSha256
    ) reject();
    const scope: FinopsBillingScope = {
      orgId: manifest.scope.organizationId,
      customerId: manifest.scope.customerId,
      connectionId: manifest.scope.connectionId,
    };
    assertScope(scope);
    const db = await this.ready();
    await this.assertLiveScope(db, scope);
    const source = sourceFromManifest(manifest);
    const generation: FinopsBillingGeneration = {
      exportName: manifest.exportName,
      billingPeriod: manifest.billingPeriod,
      generationId: generationFor(manifest.manifestSha256),
    };
    const timestamp = new Date(now).toISOString();

    // A retry may race the first insert. INSERT OR IGNORE plus one re-read makes
    // both contenders converge on the same content-derived generation.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.partition(db, scope, generation);
      if (existing !== null) {
        if (existing.active_manifest_sha256 === manifest.manifestSha256) {
          if (existing.active_generation_id === null) reject("GENERATION_MISMATCH");
          return {
            action: "skip",
            reason: "duplicate_manifest",
            generation: { ...generation, generationId: existing.active_generation_id },
          };
        }
        if (
          manifest.versionId !== null
          && existing.active_manifest_version_id === manifest.versionId
          && existing.active_manifest_sha256 !== null
        ) reject("IMMUTABLE_OBJECT_CHANGED");
        if (
          existing.status === "staging"
          && existing.staging_manifest_sha256 === manifest.manifestSha256
          && existing.staging_generation_id === generation.generationId
        ) {
          return { action: "stage", reason: "resume_delivery", generation };
        }
        if (
          manifest.versionId !== null
          && existing.manifest_version_id === manifest.versionId
          && existing.staging_manifest_sha256 !== null
          && existing.staging_manifest_sha256 !== manifest.manifestSha256
        ) reject("IMMUTABLE_OBJECT_CHANGED");

        const updated = await db.prepare(
          `UPDATE finops_export_partitions
              SET source_table = ?, source_format = ?, source_version = ?,
                  status = 'staging', manifest_bucket = ?, manifest_key = ?,
                  manifest_sha256 = ?, schema_sha256 = ?, manifest_etag = ?,
                  manifest_version_id = ?, source_updated_at = ?, observed_at = ?,
                  staging_generation_id = ?, staging_manifest_sha256 = ?,
                  accepted_rows = 0, rejected_rows = 0, file_count = ?,
                  columns_json = ?, data_files_json = ?, currency_totals_json = NULL,
                  last_error_code = NULL, last_error_at = NULL, updated_at = ?
            WHERE ${partitionWhere()}
              AND EXISTS (
                SELECT 1 FROM aws_connections c
                 JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
                WHERE c.id = finops_export_partitions.connection_id
                  AND c.org_id = finops_export_partitions.org_id
                  AND c.customer_id = finops_export_partitions.customer_id
                  AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
                  AND cu.status IN ('active', 'trial')
              )`,
        ).bind(
          source.table, source.format, source.version,
          manifest.manifest.bucket, manifest.manifest.key,
          manifest.manifestSha256, manifest.schemaSha256, manifest.eTag,
          manifest.versionId, manifest.sourceUpdatedAtIso, manifest.observedAtIso,
          generation.generationId, manifest.manifestSha256,
          manifest.dataFiles.length, canonicalJson(manifest.columns),
          canonicalJson(manifest.dataFiles), timestamp,
          scope.orgId, scope.customerId, scope.connectionId,
          generation.exportName, generation.billingPeriod,
        ).run();
        if (count(updated.meta?.changes) === 0) {
          await this.assertLiveScope(db, scope);
          reject("GENERATION_MISMATCH");
        }
        return { action: "stage", reason: "corrected_delivery", generation };
      }

      const inserted = await db.prepare(
        `INSERT OR IGNORE INTO finops_export_partitions
          (id, org_id, customer_id, connection_id, export_name, billing_period,
           source_table, source_format, source_version, status, manifest_bucket,
           manifest_key, manifest_sha256, schema_sha256, manifest_etag,
           manifest_version_id, source_updated_at, observed_at,
           staging_generation_id, staging_manifest_sha256, accepted_rows,
           rejected_rows, file_count, columns_json, data_files_json, created_at,
           updated_at)
         SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, 'staging', ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?
           FROM aws_connections c
           JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
          WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?
            AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
            AND cu.status IN ('active', 'trial')`,
      ).bind(
        `fbp_${crypto.randomUUID().replaceAll("-", "")}`,
        generation.exportName, generation.billingPeriod,
        source.table, source.format, source.version,
        manifest.manifest.bucket, manifest.manifest.key,
        manifest.manifestSha256, manifest.schemaSha256, manifest.eTag,
        manifest.versionId, manifest.sourceUpdatedAtIso, manifest.observedAtIso,
        generation.generationId, manifest.manifestSha256,
        manifest.dataFiles.length, canonicalJson(manifest.columns),
        canonicalJson(manifest.dataFiles), timestamp, timestamp,
        scope.connectionId, scope.orgId, scope.customerId,
      ).run();
      if (count(inserted.meta?.changes) > 0) {
        return { action: "stage", reason: "first_delivery", generation };
      }
    }
    return reject("GENERATION_MISMATCH");
  }

  /**
   * Stage one bounded parser chunk. The first no-op UPDATE is intentional: it
   * locks the partition row for the transaction used by D1/Postgres batch.
   * Promotion uses the same row, preventing a late chunk from committing after
   * reconciliation has switched the active pointer.
   */
  public async stageCanonicalLines(
    scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    lines: readonly CanonicalCurLine[],
    now = Date.now(),
  ): Promise<StageFinopsBillingLinesResult> {
    assertScope(scope);
    assertGeneration(generation);
    if (!Array.isArray(lines) || lines.length === 0) reject();
    if (lines.length > MAX_STAGE_CHUNK) reject("LIMIT_EXCEEDED");
    if (!Number.isFinite(now)) reject();
    const db = await this.ready();
    const partition = await this.partition(db, scope, generation);
    if (partition === null) {
      await this.assertLiveScope(db, scope);
      return reject("GENERATION_MISMATCH");
    }
    if (
      partition.status !== "staging"
      || partition.staging_generation_id !== generation.generationId
    ) reject("GENERATION_MISMATCH");

    const sourceRow = await db.prepare(
      `SELECT source_format, source_version
         FROM finops_export_partitions
        WHERE ${partitionWhere()} AND status = 'staging'
          AND staging_generation_id = ? LIMIT 1`,
    ).bind(
      scope.orgId, scope.customerId, scope.connectionId,
      generation.exportName, generation.billingPeriod, generation.generationId,
    ).first<{ source_format: CanonicalCurLine["sourceFormat"]; source_version: CanonicalCurLine["sourceVersion"] }>();
    if (sourceRow === null) reject("GENERATION_MISMATCH");

    const seen = new Set<string>();
    const serialized = lines.map((line) => {
      if (seen.has(line.lineItemId)) reject("LINE_CONFLICT");
      seen.add(line.lineItemId);
      return {
        line,
        json: assertCanonicalLine(
          line,
          { format: sourceRow.source_format, version: sourceRow.source_version },
          generation.billingPeriod,
        ),
      };
    });
    const timestamp = new Date(now).toISOString();
    const guard = db.prepare(
      `UPDATE finops_export_partitions SET updated_at = updated_at
        WHERE ${partitionWhere()} AND status = 'staging'
          AND staging_generation_id = ?
          AND EXISTS (
            SELECT 1 FROM aws_connections c
             JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
            WHERE c.id = finops_export_partitions.connection_id
              AND c.org_id = finops_export_partitions.org_id
              AND c.customer_id = finops_export_partitions.customer_id
              AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
              AND cu.status IN ('active', 'trial')
          )`,
    ).bind(
      scope.orgId, scope.customerId, scope.connectionId,
      generation.exportName, generation.billingPeriod, generation.generationId,
    );
    const statements: D1PreparedStatement[] = [guard];
    for (const entry of serialized) {
      const line = entry.line;
      statements.push(db.prepare(
        `INSERT INTO finops_billing_lines_v2
          (id, org_id, customer_id, connection_id, export_name, billing_period,
           generation_id, source_format, source_version, line_item_id,
           payer_account_id, usage_account_id, service, product_code,
           product_name, product_family, resource_id, resource_type, region,
           availability_zone, operation, usage_type, charge_kind,
           charge_category, usage_start, usage_end, amount_micros,
           net_unblended_cost_micros, amortized_micros, list_cost_micros,
           contracted_cost_micros, public_on_demand_cost_micros, currency,
           commitment_type, commitment_id, commitment_expiry, invoice_id,
           billing_entity, legal_entity, tags_json, cost_categories_json,
           canonical_json, created_at)
         SELECT ?, p.org_id, p.customer_id, p.connection_id, p.export_name,
                p.billing_period, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM finops_export_partitions p
           JOIN aws_connections c ON c.id = p.connection_id AND c.org_id = p.org_id
             AND c.customer_id = p.customer_id
          WHERE p.org_id = ? AND p.customer_id = ? AND p.connection_id = ?
            AND p.export_name = ? AND p.billing_period = ?
            AND p.status = 'staging' AND p.staging_generation_id = ?
            AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
         ON CONFLICT (org_id, customer_id, connection_id, export_name,
                      billing_period, generation_id, line_item_id)
         DO UPDATE SET canonical_json =
           CASE WHEN finops_billing_lines_v2.canonical_json = excluded.canonical_json
                THEN finops_billing_lines_v2.canonical_json ELSE NULL END`,
      ).bind(
        `fbl_${crypto.randomUUID().replaceAll("-", "")}`,
        generation.generationId, line.sourceFormat, line.sourceVersion,
        line.lineItemId, line.payerAccountId, line.usageAccountId, line.service,
        line.productCode, line.productName, line.productFamily, line.resourceId,
        line.resourceType, line.region, line.availabilityZone, line.operation,
        line.usageType, line.chargeKind, line.chargeCategory, line.usageStartIso,
        line.usageEndIso, line.amountMicros, line.netUnblendedCostMicros,
        line.amortizedMicros, line.listCostMicros, line.contractedCostMicros,
        line.publicOnDemandCostMicros, line.currency, line.commitmentType,
        line.commitmentId, line.commitmentExpiry, line.invoiceId,
        line.billingEntity, line.legalEntity, canonicalJson(line.tags),
        canonicalJson(line.costCategories), entry.json, timestamp,
        scope.orgId, scope.customerId, scope.connectionId,
        generation.exportName, generation.billingPeriod, generation.generationId,
      ));
    }
    try {
      const results = await db.batch(statements);
      if (count(results[0]?.meta?.changes) === 0) reject("GENERATION_MISMATCH");
    } catch (error) {
      if (error instanceof FinopsBillingEngineRepositoryError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/canonical_json|not null|constraint/iu.test(message)) reject("LINE_CONFLICT");
      throw error;
    }
    return { generation, stagedRows: lines.length };
  }

  /**
   * Reconcile and atomically publish a complete generation. Currency totals are
   * summed as JavaScript BigInt from text projections, never database numbers.
   * The final conditional UPDATE rechecks row count while locking the partition.
   */
  public async commitGeneration(
    scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    reconciliation: FinopsBillingReconciliation,
    now = Date.now(),
  ): Promise<CommitFinopsBillingGenerationResult> {
    assertScope(scope);
    assertGeneration(generation);
    const expectedTotals = assertReconciliation(reconciliation);
    if (!Number.isFinite(now)) reject();
    const db = await this.ready();
    const initial = await this.partition(db, scope, generation);
    if (initial === null) {
      await this.assertLiveScope(db, scope);
      return reject("GENERATION_MISMATCH");
    }
    if (initial.active_generation_id === generation.generationId && initial.status === "ready") {
      const storedTotals = parseCurrencyTotals(initial.active_currency_totals_json);
      if (
        initial.active_accepted_rows === null
        || initial.active_rejected_rows === null
        || count(initial.active_accepted_rows) !== reconciliation.acceptedRows
        || count(initial.active_rejected_rows) !== reconciliation.rejectedRows
        || initial.active_file_count === null
        || count(initial.active_file_count) !== reconciliation.processedObjectCount
        || !sameCurrencyTotals(storedTotals, expectedTotals)
        || initial.active_committed_at === null
      ) reject("GENERATION_MISMATCH");
      return {
        generation,
        acceptedRows: reconciliation.acceptedRows,
        rejectedRows: reconciliation.rejectedRows,
        processedObjectCount: reconciliation.processedObjectCount,
        currencyTotals: storedTotals,
        alreadyCommitted: true,
        committedAtIso: initial.active_committed_at,
      };
    }
    if (
      initial.status !== "staging"
      || initial.staging_generation_id !== generation.generationId
    ) reject("GENERATION_MISMATCH");

    if (count(initial.file_count) !== reconciliation.processedObjectCount) {
      await this.failGeneration(scope, generation, "OBJECT_COUNT_MISMATCH", now);
      return reject("OBJECT_COUNT_MISMATCH");
    }

    const actual = await this.generationTotals(db, scope, generation, false);
    if (actual.rowCount !== reconciliation.acceptedRows) {
      await this.failGeneration(scope, generation, "ROW_COUNT_MISMATCH", now);
      return reject("ROW_COUNT_MISMATCH");
    }
    if (!sameCurrencyTotals(actual.currencyTotals, expectedTotals)) {
      await this.failGeneration(scope, generation, "CURRENCY_TOTAL_MISMATCH", now);
      return reject("CURRENCY_TOTAL_MISMATCH");
    }

    const timestamp = new Date(now).toISOString();
    const totalsJson = canonicalJson(expectedTotals);
    const promoted = await db.prepare(
      `UPDATE finops_export_partitions
          SET status = 'ready',
              active_generation_id = staging_generation_id,
              active_manifest_sha256 = staging_manifest_sha256,
              active_manifest_version_id = manifest_version_id,
              active_source_table = source_table,
              active_source_format = source_format,
              active_source_version = source_version,
              active_source_updated_at = source_updated_at,
              active_observed_at = observed_at,
              active_accepted_rows = ?,
              active_rejected_rows = ?,
              active_file_count = file_count,
              active_currency_totals_json = ?,
              active_committed_at = ?,
              staging_generation_id = NULL,
              staging_manifest_sha256 = NULL,
              accepted_rows = ?, rejected_rows = ?, currency_totals_json = ?,
              last_error_code = NULL, last_error_at = NULL,
              committed_at = ?, updated_at = ?
        WHERE ${partitionWhere()}
          AND status = 'staging' AND staging_generation_id = ?
          AND file_count = ?
          AND (SELECT COUNT(*) FROM finops_billing_lines_v2 l
                WHERE l.org_id = finops_export_partitions.org_id
                  AND l.customer_id = finops_export_partitions.customer_id
                  AND l.connection_id = finops_export_partitions.connection_id
                  AND l.export_name = finops_export_partitions.export_name
                  AND l.billing_period = finops_export_partitions.billing_period
                  AND l.generation_id = finops_export_partitions.staging_generation_id) = ?
          AND EXISTS (
            SELECT 1 FROM aws_connections c
             JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
            WHERE c.id = finops_export_partitions.connection_id
              AND c.org_id = finops_export_partitions.org_id
              AND c.customer_id = finops_export_partitions.customer_id
              AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
              AND cu.status IN ('active', 'trial')
          )`,
    ).bind(
      reconciliation.acceptedRows, reconciliation.rejectedRows, totalsJson,
      timestamp,
      reconciliation.acceptedRows, reconciliation.rejectedRows, totalsJson,
      timestamp, timestamp,
      scope.orgId, scope.customerId, scope.connectionId,
      generation.exportName, generation.billingPeriod, generation.generationId,
      reconciliation.processedObjectCount,
      reconciliation.acceptedRows,
    ).run();
    if (count(promoted.meta?.changes) === 0) {
      const current = await this.partition(db, scope, generation);
      if (
        current !== null
        && current.status === "staging"
        && current.staging_generation_id === generation.generationId
      ) {
        if (count(current.file_count) !== reconciliation.processedObjectCount) {
          await this.failGeneration(scope, generation, "OBJECT_COUNT_MISMATCH", now);
          return reject("OBJECT_COUNT_MISMATCH");
        }
        await this.failGeneration(scope, generation, "ROW_COUNT_MISMATCH", now);
        return reject("ROW_COUNT_MISMATCH");
      }
      return reject("GENERATION_MISMATCH");
    }
    return {
      generation,
      acceptedRows: reconciliation.acceptedRows,
      rejectedRows: reconciliation.rejectedRows,
      processedObjectCount: reconciliation.processedObjectCount,
      currencyTotals: expectedTotals,
      alreadyCommitted: false,
      committedAtIso: timestamp,
    };
  }

  /** Mark only the exact staging generation failed; the active pointer is kept. */
  public async failGeneration(
    scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    errorCode: string,
    now = Date.now(),
  ): Promise<void> {
    assertScope(scope);
    assertGeneration(generation);
    if (!ERROR_CODE.test(errorCode) || !Number.isFinite(now)) reject();
    const db = await this.ready();
    const timestamp = new Date(now).toISOString();
    const failed = await db.prepare(
      `UPDATE finops_export_partitions
          SET status = 'failed', last_error_code = ?, last_error_at = ?,
              updated_at = ?
        WHERE ${partitionWhere()} AND status = 'staging'
          AND staging_generation_id = ?
          AND EXISTS (
            SELECT 1 FROM aws_connections c
             WHERE c.id = finops_export_partitions.connection_id
               AND c.org_id = finops_export_partitions.org_id
               AND c.customer_id = finops_export_partitions.customer_id
               AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          )`,
    ).bind(
      errorCode, timestamp, timestamp,
      scope.orgId, scope.customerId, scope.connectionId,
      generation.exportName, generation.billingPeriod, generation.generationId,
    ).run();
    if (count(failed.meta?.changes) === 0) {
      await this.assertLiveScope(db, scope);
      reject("GENERATION_MISMATCH");
    }
  }

  /** Bounded canonical line query. Every result joins the active generation. */
  public async listActiveLines(
    scope: FinopsBillingScope,
    query: ActiveFinopsBillingLineQuery = {},
  ): Promise<readonly ActiveFinopsBillingLine[]> {
    assertScope(scope);
    if (
      (query.exportName !== undefined && !validShortText(query.exportName, 256))
      || (query.billingPeriod !== undefined && !PERIOD.test(query.billingPeriod))
      || (query.service !== undefined && !validShortText(query.service, 1_024))
      || (query.usageAccountId !== undefined && !validShortText(query.usageAccountId, 256))
      || (query.resourceId !== undefined && !validShortText(query.resourceId))
      || (query.limit !== undefined && (
        !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_QUERY_ROWS
      ))
    ) reject();
    const db = await this.ready();
    const filters: string[] = [];
    const values: unknown[] = [scope.orgId, scope.customerId, scope.connectionId];
    const add = (sql: string, value: unknown): void => {
      filters.push(sql);
      values.push(value);
    };
    if (query.exportName !== undefined) add("l.export_name = ?", query.exportName);
    if (query.billingPeriod !== undefined) add("l.billing_period = ?", query.billingPeriod);
    if (query.service !== undefined) add("l.service = ?", query.service);
    if (query.usageAccountId !== undefined) add("l.usage_account_id = ?", query.usageAccountId);
    if (query.resourceId !== undefined) add("l.resource_id = ?", query.resourceId);
    values.push(query.limit ?? MAX_QUERY_ROWS);
    const rows = await db.prepare(
      `SELECT l.export_name, l.billing_period, l.generation_id, l.canonical_json
         FROM finops_billing_lines_v2 l
         JOIN finops_export_partitions p
           ON p.org_id = l.org_id AND p.customer_id = l.customer_id
          AND p.connection_id = l.connection_id AND p.export_name = l.export_name
          AND p.billing_period = l.billing_period
          AND p.active_generation_id = l.generation_id
         JOIN aws_connections c
           ON c.id = l.connection_id AND c.org_id = l.org_id
          AND c.customer_id = l.customer_id
        WHERE l.org_id = ? AND l.customer_id = ? AND l.connection_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          ${filters.length === 0 ? "" : `AND ${filters.join(" AND ")}`}
        ORDER BY l.billing_period DESC, l.export_name ASC, l.line_item_id ASC
        LIMIT ?`,
    ).bind(...values).all<ActiveLineRow>();
    return (rows.results ?? []).map((row) => ({
      exportName: row.export_name,
      billingPeriod: row.billing_period,
      generationId: row.generation_id,
      line: JSON.parse(row.canonical_json) as CanonicalCurLine,
    }));
  }

  /** Exact active billed-cost totals without SQL SUM or Number conversion. */
  public async activeCurrencyTotals(
    scope: FinopsBillingScope,
    options: { readonly exportName?: string; readonly billingPeriod?: string } = {},
  ): Promise<readonly ActiveFinopsCurrencyTotal[]> {
    assertScope(scope);
    if (
      (options.exportName !== undefined && !validShortText(options.exportName, 256))
      || (options.billingPeriod !== undefined && !PERIOD.test(options.billingPeriod))
    ) reject();
    const db = await this.ready();
    const actual = await this.generationTotals(db, scope, null, true, options);
    return Object.entries(actual.currencyTotals).map(([currency, amountMicros]) => ({
      currency,
      amountMicros,
      lineCount: actual.currencyCounts[currency] ?? 0,
    }));
  }

  private async assertLiveScope(db: D1Database, scope: FinopsBillingScope): Promise<void> {
    const live = await db.prepare(
      `SELECT c.id
         FROM aws_connections c
         JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
        WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          AND cu.status IN ('active', 'trial') LIMIT 1`,
    ).bind(scope.connectionId, scope.orgId, scope.customerId).first<{ id: string }>();
    if (live === null) reject("SCOPE_NOT_FOUND");
  }

  private async partition(
    db: D1Database,
    scope: FinopsBillingScope,
    generation: Pick<FinopsBillingGeneration, "exportName" | "billingPeriod">,
  ): Promise<PartitionRow | null> {
    return db.prepare(
      `SELECT active_generation_id, active_manifest_sha256,
              active_manifest_version_id, active_source_table,
              active_source_format, active_source_version,
              active_source_updated_at, active_observed_at,
              active_accepted_rows, active_rejected_rows,
              active_file_count, active_currency_totals_json, active_committed_at,
              staging_generation_id,
              staging_manifest_sha256, manifest_version_id, status,
              accepted_rows, rejected_rows, file_count, currency_totals_json,
              committed_at
         FROM finops_export_partitions
        WHERE ${partitionWhere()} LIMIT 1`,
    ).bind(
      scope.orgId, scope.customerId, scope.connectionId,
      generation.exportName, generation.billingPeriod,
    ).first<PartitionRow>();
  }

  private async generationTotals(
    db: D1Database,
    scope: FinopsBillingScope,
    generation: FinopsBillingGeneration | null,
    active: boolean,
    filters: { readonly exportName?: string; readonly billingPeriod?: string } = {},
  ): Promise<{
    readonly rowCount: number;
    readonly currencyTotals: Readonly<Record<string, string>>;
    readonly currencyCounts: Readonly<Record<string, number>>;
  }> {
    let cursor = "";
    let rowCount = 0;
    const totals: Record<string, bigint> = Object.create(null) as Record<string, bigint>;
    const currencyCounts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (;;) {
      const clauses: string[] = ["l.org_id = ?", "l.customer_id = ?", "l.connection_id = ?", "l.id > ?"];
      const values: unknown[] = [scope.orgId, scope.customerId, scope.connectionId, cursor];
      if (generation !== null) {
        clauses.push("l.export_name = ?", "l.billing_period = ?", "l.generation_id = ?");
        values.push(generation.exportName, generation.billingPeriod, generation.generationId);
      }
      if (filters.exportName !== undefined) {
        clauses.push("l.export_name = ?");
        values.push(filters.exportName);
      }
      if (filters.billingPeriod !== undefined) {
        clauses.push("l.billing_period = ?");
        values.push(filters.billingPeriod);
      }
      values.push(AGGREGATE_PAGE_SIZE);
      const rows = await db.prepare(
        `SELECT l.id, l.currency, CAST(l.amount_micros AS TEXT) AS amount_micros
           FROM finops_billing_lines_v2 l
           JOIN finops_export_partitions p
             ON p.org_id = l.org_id AND p.customer_id = l.customer_id
            AND p.connection_id = l.connection_id AND p.export_name = l.export_name
            AND p.billing_period = l.billing_period
            AND ${active
              ? "p.active_generation_id = l.generation_id"
              : "p.staging_generation_id = l.generation_id AND p.status = 'staging'"}
           JOIN aws_connections c
             ON c.id = l.connection_id AND c.org_id = l.org_id
            AND c.customer_id = l.customer_id
          WHERE ${clauses.join(" AND ")}
            AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
          ORDER BY l.id ASC LIMIT ?`,
      ).bind(...values).all<StageAmountRow>();
      const page = rows.results ?? [];
      for (const row of page) {
        const amount = String(row.amount_micros);
        if (!CURRENCY.test(row.currency) || !MONEY.test(amount)) reject("GENERATION_MISMATCH");
        totals[row.currency] = (totals[row.currency] ?? BigInt(0)) + BigInt(amount);
        currencyCounts[row.currency] = (currencyCounts[row.currency] ?? 0) + 1;
        rowCount += 1;
      }
      if (page.length < AGGREGATE_PAGE_SIZE) break;
      cursor = page[page.length - 1]?.id ?? "";
    }
    const currencyTotals: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const currency of Object.keys(totals).sort()) {
      currencyTotals[currency] = totals[currency]?.toString() ?? "0";
    }
    return { rowCount, currencyTotals, currencyCounts };
  }
}
