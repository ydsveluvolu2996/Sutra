/** Complete, tenant-scoped reader for one immutable active CUR 2.0 generation. */
import type { CanonicalCurLine } from "../lib/finops-cur.ts";
import type { PricingChangeActiveCur2Source, PricingChangeJobScope } from "../lib/finops-pricing-change-materialization-job.ts";
import { getRawDb } from "./index.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";

const PAGE_SIZE = 1_000;
const MAXIMUM_ROWS = 250_000;
const MAXIMUM_BYTES = 48 * 1_024 * 1_024;
const ACCOUNT = /^\d{12}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const GENERATION = /^fbg_[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const INTEGER = /^(?:0|[1-9]\d{0,30})$/u;

export interface PricingChangeCur2ProviderRow {
  readonly usageId: string;
  readonly payerAccountId: string;
  readonly linkedAccountId: string;
  readonly serviceCode: string;
  readonly region: string;
  readonly usageStartAt: string;
  readonly usageEndAt: string;
  readonly lineItemType: "USAGE" | "DISCOUNTED_USAGE" | "SAVINGS_PLAN_COVERED_USAGE";
  readonly termType: "ON_DEMAND" | "RESERVED" | "SAVINGS_PLAN";
  readonly currency: string;
  readonly usageUnit: string;
  readonly usageQuantity: { readonly numerator: string; readonly denominator: string };
  readonly applicabilityAttributes: readonly { readonly name: string; readonly value: string }[];
}

export interface PricingChangeCur2Artifact {
  readonly schemaVersion: "sutra.pricing-change.cur2-artifact.v1";
  readonly scope: PricingChangeJobScope;
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly generationId: string;
  readonly manifestSha256: string;
  readonly generatedAtIso: string;
  readonly sourceFormat: "aws-cur";
  readonly sourceVersion: "2.0";
  readonly rowsExhausted: true;
  readonly sourceRowCount: number;
  readonly selectedUsageRowCount: number;
  readonly omittedRowCount: number;
  readonly rows: readonly PricingChangeCur2ProviderRow[];
}

interface PartitionRow {
  active_generation_id: string | null;
  active_manifest_sha256: string | null;
  active_source_format: string | null;
  active_source_version: string | null;
  active_source_updated_at: string | null;
  active_accepted_rows: number | string | null;
  active_rejected_rows: number | string | null;
  active_file_count: number | string | null;
  status: string;
}

interface LineRow { readonly line_item_id: string; readonly canonical_json: string }

export class PricingChangeCur2ReaderError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "GENERATION_MISMATCH" | "BOUND_REACHED" | "STORED_ROW_INVALID";
  public constructor(code: PricingChangeCur2ReaderError["code"]) {
    super("Pricing Change CUR2 generation could not be read");
    this.name = "PricingChangeCur2ReaderError";
    this.code = code;
  }
}

function reject(code: PricingChangeCur2ReaderError["code"]): never { throw new PricingChangeCur2ReaderError(code); }
function count(value: number | string | null): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("GENERATION_MISMATCH");
  return parsed;
}
function iso(value: string | null): string {
  if (value === null || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) reject("GENERATION_MISMATCH");
  return value;
}
function rationalFromMicros(value: string): { readonly numerator: string; readonly denominator: string } {
  if (!INTEGER.test(value) || value === "0") reject("STORED_ROW_INVALID");
  let numerator = BigInt(value), denominator = BigInt(1_000_000);
  while (denominator % BigInt(2) === BigInt(0) && numerator % BigInt(2) === BigInt(0)) { denominator /= BigInt(2); numerator /= BigInt(2); }
  while (denominator % BigInt(5) === BigInt(0) && numerator % BigInt(5) === BigInt(0)) { denominator /= BigInt(5); numerator /= BigInt(5); }
  return { numerator: numerator.toString(), denominator: denominator.toString() };
}
function classification(line: CanonicalCurLine): Pick<PricingChangeCur2ProviderRow, "lineItemType" | "termType"> | null {
  if (line.chargeCategory === "Usage" && line.pricingTerm === "OnDemand") return { lineItemType: "USAGE", termType: "ON_DEMAND" };
  if (line.chargeCategory === "DiscountedUsage" && line.pricingTerm === "Reserved") return { lineItemType: "DISCOUNTED_USAGE", termType: "RESERVED" };
  if (line.chargeCategory === "SavingsPlanCoveredUsage" && line.pricingTerm === "SavingsPlan") return { lineItemType: "SAVINGS_PLAN_COVERED_USAGE", termType: "SAVINGS_PLAN" };
  return null;
}
function selected(line: CanonicalCurLine): PricingChangeCur2ProviderRow | null {
  const kind = classification(line);
  if (kind === null) return null;
  if (line.payerAccountId === null || !ACCOUNT.test(line.payerAccountId) || !ACCOUNT.test(line.usageAccountId)
    || line.productCode === null || line.productCode.length < 1 || line.productCode.length > 64
    || line.region === null || line.region.length < 1 || line.region.length > 128
    || line.usageEndIso === null || line.usageAmountMicros === null || line.usageUnit === null
    || line.usageUnit.length < 1 || line.usageUnit.length > 64) return null;
  const currency = line.pricingCurrency ?? line.currency;
  if (!CURRENCY.test(currency)) return null;
  const attributes = [
    { name: "servicecode", value: line.productCode },
    ...(line.operation === null ? [] : [{ name: "operation", value: line.operation }]),
    ...(line.productFamily === null ? [] : [{ name: "productFamily", value: line.productFamily }]),
    ...(line.usageType === null ? [] : [{ name: "usagetype", value: line.usageType }]),
  ].sort((left, right) => left.name.localeCompare(right.name));
  if (attributes.some((item) => item.value.length < 1 || item.value.length > 512)) return null;
  let quantity: PricingChangeCur2ProviderRow["usageQuantity"];
  try { quantity = rationalFromMicros(line.usageAmountMicros); } catch { return null; }
  return Object.freeze({ usageId: line.lineItemId, payerAccountId: line.payerAccountId,
    linkedAccountId: line.usageAccountId, serviceCode: line.productCode, region: line.region,
    usageStartAt: line.usageStartIso, usageEndAt: line.usageEndIso, ...kind, currency,
    usageUnit: line.usageUnit, usageQuantity: quantity, applicabilityAttributes: Object.freeze(attributes) });
}

export class PricingChangeCur2Reader {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) { this.database = database; }

  public async read(scope: PricingChangeJobScope, active: PricingChangeActiveCur2Source): Promise<PricingChangeCur2Artifact> {
    if (active.scope.organizationId !== scope.organizationId || active.scope.customerId !== scope.customerId
      || active.scope.connectionId !== scope.connectionId || !GENERATION.test(active.generationId)
      || !SHA.test(active.manifestSha256) || active.sourceFormat !== "aws-cur" || active.sourceVersion !== "2.0") reject("INVALID_INPUT");
    await ensureRuntimeSchema(this.database);
    const partition = await this.database.prepare(`SELECT p.active_generation_id,p.active_manifest_sha256,p.active_source_format,
      p.active_source_version,p.active_source_updated_at,p.active_accepted_rows,p.active_rejected_rows,p.active_file_count,p.status
      FROM finops_export_partitions p JOIN aws_connections c ON c.id=p.connection_id AND c.org_id=p.org_id AND c.customer_id=p.customer_id
      JOIN organizations o ON o.id=p.org_id AND o.status='active'
      JOIN customers cu ON cu.id=p.customer_id AND cu.org_id=p.org_id AND cu.status='active'
      WHERE p.org_id=? AND p.customer_id=? AND p.connection_id=? AND p.export_name=? AND p.billing_period=?
      AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId, active.exportName, active.billingPeriod).first<PartitionRow>();
    if (partition === null) reject("SCOPE_NOT_FOUND");
    const sourceRows = count(partition.active_accepted_rows), rejectedRows = count(partition.active_rejected_rows), files = count(partition.active_file_count);
    if (partition.status !== "ready" || partition.active_generation_id !== active.generationId
      || partition.active_manifest_sha256 !== active.manifestSha256 || partition.active_source_format !== "aws-cur"
      || partition.active_source_version !== "2.0" || sourceRows !== active.coverage.acceptedRowCount
      || rejectedRows !== active.coverage.rejectedRowCount || files !== active.coverage.processedObjectCount
      || iso(partition.active_source_updated_at) !== active.generatedAtIso
      || sourceRows > MAXIMUM_ROWS) reject("GENERATION_MISMATCH");
    const rows: PricingChangeCur2ProviderRow[] = []; let cursor = "", observed = 0, bytes = 0;
    for (;;) {
      const page = await this.database.prepare(`SELECT l.line_item_id,l.canonical_json FROM finops_billing_lines_v2 l
        JOIN finops_export_partitions p ON p.org_id=l.org_id AND p.customer_id=l.customer_id AND p.connection_id=l.connection_id
          AND p.export_name=l.export_name AND p.billing_period=l.billing_period AND p.active_generation_id=l.generation_id
        JOIN aws_connections c ON c.id=l.connection_id AND c.org_id=l.org_id AND c.customer_id=l.customer_id
        WHERE l.org_id=? AND l.customer_id=? AND l.connection_id=? AND l.export_name=? AND l.billing_period=?
          AND l.generation_id=? AND l.line_item_id>? AND c.source_kind='aws_trust_role' AND c.status='active'
        ORDER BY l.line_item_id ASC LIMIT ?`).bind(scope.organizationId, scope.customerId, scope.connectionId,
          active.exportName, active.billingPeriod, active.generationId, cursor, PAGE_SIZE).all<LineRow>();
      const items = page.results ?? [];
      for (const item of items) {
        if (typeof item.line_item_id !== "string" || item.line_item_id <= cursor || typeof item.canonical_json !== "string") reject("STORED_ROW_INVALID");
        bytes += new TextEncoder().encode(item.canonical_json).byteLength;
        if (bytes > MAXIMUM_BYTES || observed >= MAXIMUM_ROWS) reject("BOUND_REACHED");
        let line: CanonicalCurLine; try { line = JSON.parse(item.canonical_json) as CanonicalCurLine; } catch { reject("STORED_ROW_INVALID"); }
        if (line.lineItemId !== item.line_item_id || line.sourceFormat !== "aws-cur" || line.sourceVersion !== "2.0") reject("STORED_ROW_INVALID");
        const usage = selected(line); if (usage !== null) rows.push(usage); observed += 1; cursor = item.line_item_id;
      }
      if (items.length < PAGE_SIZE) break;
    }
    if (observed !== sourceRows || rows.length > MAXIMUM_ROWS) reject("GENERATION_MISMATCH");
    return Object.freeze({ schemaVersion: "sutra.pricing-change.cur2-artifact.v1", scope: Object.freeze({ ...scope }),
      exportName: active.exportName, billingPeriod: active.billingPeriod, generationId: active.generationId,
      manifestSha256: active.manifestSha256, generatedAtIso: active.generatedAtIso,
      sourceFormat: "aws-cur", sourceVersion: "2.0", rowsExhausted: true, sourceRowCount: observed,
      selectedUsageRowCount: rows.length, omittedRowCount: observed - rows.length, rows: Object.freeze(rows) });
  }
}
