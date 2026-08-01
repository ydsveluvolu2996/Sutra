/**
 * Evidence-honest Google Cloud billing-export contract and dashboard engine.
 *
 * Money is retained as signed integer nano-units (10^-9 currency units), the
 * scale of BigQuery NUMERIC. Provider credits remain invoice facts. Pricing
 * variance and recommendation savings are separate calculated opportunity
 * channels and are never subtracted from billed cost.
 */

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^gcpconn_[a-f0-9]{32}$/u;
const BILLING_ACCOUNT = /^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/u;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const DATASET_ID = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/u;
const TABLE_ID = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,1023}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CAPTURE_ID = /^gcpbilling_[a-f0-9]{64}$/u;
const JOB_ID = /^[A-Za-z0-9_-]{1,1024}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const NANOS = /^-?(?:0|[1-9]\d{0,38})$/u;
const DECIMAL = /^-?(?:0|[1-9]\d{0,38})(?:\.\d{1,9})?$/u;
const MONTH = /^\d{6}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LABEL_KEY = /^[A-Za-z0-9_.:/-]{1,128}$/u;

export const GCP_CLOUD_INTELLIGENCE_BOUNDS = Object.freeze({
  maximumRows: 1_000_000,
  maximumCreditsPerRow: 32,
  maximumLabelsPerRow: 64,
  maximumOpportunityRows: 100_000,
  maximumCaptureBytes: 256 * 1_024 * 1_024,
  staleAfterHours: 48,
} as const);

export const GCP_BILLING_EXPORT_READ_PERMISSIONS = Object.freeze([
  "bigquery.jobs.create",
  "bigquery.tables.get",
  "bigquery.tables.getData",
] as const);

export type GcpBillingSourceState =
  | "CONFIGURATION_REQUIRED"
  | "PERMISSION_REQUIRED"
  | "WAITING_FIRST_DELIVERY"
  | "PARTIAL_PIPELINE"
  | "EMPTY"
  | "READY";

export type GcpCreditType =
  | "COMMITTED_USAGE_DISCOUNT"
  | "SUSTAINED_USAGE_DISCOUNT"
  | "DISCOUNT"
  | "FREE_TIER"
  | "PROMOTION"
  | "RESELLER_MARGIN"
  | "OTHER";

export interface GcpBillingScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly provider: "GCP";
  readonly billingAccountId: string;
  readonly exportProjectId: string;
  readonly datasetId: string;
  readonly billingTableId: string;
  readonly pricingProjectId: string;
  readonly pricingDatasetId: string;
  readonly pricingTableId: string;
  readonly location: string;
}

export interface GcpBillingCredit {
  readonly id: string | null;
  readonly name: string;
  readonly type: GcpCreditType;
  /** Signed invoice credit/refund amount in 10^-9 currency units. */
  readonly amountNanos: string;
}

export interface GcpBillingLabel {
  readonly key: string;
  readonly value: string;
}

export interface GcpBillingExportRow {
  readonly sourceRowSha256: string;
  readonly invoiceMonth: string;
  readonly usageStartTime: string;
  readonly usageEndTime: string;
  readonly billingAccountId: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  /** Resource hierarchy frozen by Google at usage-record time. */
  readonly projectAncestors: readonly string[];
  readonly serviceId: string;
  readonly serviceDescription: string;
  readonly skuId: string;
  readonly skuDescription: string;
  readonly locationRegion: string | null;
  readonly locationZone: string | null;
  readonly locationCountry: string | null;
  readonly resourceGlobalName: string | null;
  readonly resourceName: string | null;
  readonly labels: readonly GcpBillingLabel[];
  readonly systemLabels: readonly GcpBillingLabel[];
  readonly usageAmount: string;
  readonly usageUnit: string;
  readonly pricingQuantity: string | null;
  readonly pricingUnit: string | null;
  readonly costType: "regular" | "tax" | "adjustment" | "rounding_error";
  readonly currency: string;
  /** Actual invoiced cost before credits, exact BigQuery NUMERIC scale. */
  readonly costBeforeCreditsNanos: string;
  readonly credits: readonly GcpBillingCredit[];
  /** Optional pricing-export list-cost calculation, not billed cost. */
  readonly calculatedListCostNanos: string | null;
  readonly pricingSourceSha256: string | null;
}

export interface GcpCalculatedOpportunity {
  readonly opportunityId: string;
  readonly source: "GCP_RECOMMENDER_EXPORT" | "GCP_PRICING_EXPORT_VARIANCE";
  readonly projectId: string | null;
  readonly serviceDescription: string;
  readonly resourceGlobalName: string | null;
  readonly locationRegion: string | null;
  readonly currency: string;
  readonly estimatedMonthlySavingsNanos: string;
  readonly observedAt: string;
  readonly sourceRecordSha256: string;
  readonly state: "ACTIVE" | "CLAIMED" | "SUCCEEDED" | "DISMISSED";
}

export interface GcpBillingExportCapture {
  readonly schemaVersion: "sutra.gcp-cloud-billing-export.v1";
  readonly scope: GcpBillingScope;
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly dataThroughAt: string | null;
  readonly activation: {
    readonly workloadIdentityBindingPresent: boolean;
    readonly permissionsValidated: boolean;
    readonly billingExportConfigured: boolean;
    readonly detailedUsageExport: boolean;
    readonly pricingExportConfigured: boolean;
    readonly gkeCostAllocationEnabled: boolean;
    readonly activationReasons: readonly string[];
  };
  readonly lineage: {
    readonly source: "GCP_CLOUD_BILLING_DETAILED_USAGE_EXPORT";
    readonly bigQueryJobId: string | null;
    readonly querySha256: string | null;
    readonly billingTableSchemaSha256: string | null;
    readonly pricingTableSchemaSha256: string | null;
    readonly rowsExhausted: boolean;
    readonly expectedRowCount: number | null;
  };
  readonly rows: readonly GcpBillingExportRow[];
  readonly opportunities: {
    readonly state: "NOT_CONFIGURED" | "PARTIAL" | "COMPLETE";
    readonly rowsExhausted: boolean;
    readonly rows: readonly GcpCalculatedOpportunity[];
  };
}

export interface GcpBillingSnapshot extends Omit<GcpBillingExportCapture, "schemaVersion"> {
  readonly schemaVersion: "sutra.gcp-cloud-billing-snapshot.v1";
  readonly sourceState: GcpBillingSourceState;
  readonly complete: boolean;
  readonly limitations: readonly string[];
}

export interface GcpDashboardFilters {
  readonly invoiceMonth?: string | null;
  readonly projectId?: string | null;
  readonly service?: string | null;
  readonly sku?: string | null;
  readonly region?: string | null;
  readonly currency?: string | null;
  readonly labelKey?: string | null;
  readonly labelValue?: string | null;
}

export interface GcpMoneyTotal {
  readonly currency: string;
  readonly costBeforeCreditsNanos: string;
  readonly creditsNanos: string;
  readonly netBilledCostNanos: string;
  readonly calculatedListCostNanos: string | null;
  readonly calculatedPricingVarianceNanos: string | null;
}

export class GcpCloudIntelligenceError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_MISMATCH" | "DUPLICATE_CONFLICT";
  public constructor(code: GcpCloudIntelligenceError["code"]) {
    super("The GCP billing-export evidence is invalid");
    this.name = "GcpCloudIntelligenceError";
    this.code = code;
  }
}

function reject(code: GcpCloudIntelligenceError["code"] = "INVALID_INPUT"): never {
  throw new GcpCloudIntelligenceError(code);
}
function text(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
function iso(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
}
function nanos(value: unknown): value is string { return typeof value === "string" && NANOS.test(value); }
function decimal(value: unknown): value is string { return typeof value === "string" && DECIMAL.test(value); }
function safeCount(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function sameScope(left: GcpBillingScope, right: GcpBillingScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId && left.connectionId === right.connectionId &&
    left.provider === right.provider && left.billingAccountId === right.billingAccountId && left.exportProjectId === right.exportProjectId &&
    left.datasetId === right.datasetId && left.billingTableId === right.billingTableId && left.pricingProjectId === right.pricingProjectId &&
    left.pricingDatasetId === right.pricingDatasetId && left.pricingTableId === right.pricingTableId && left.location === right.location;
}

export function validateGcpBillingScope(scope: GcpBillingScope): void {
  if (!SAFE_ID.test(scope.orgId) || !SAFE_ID.test(scope.customerId) || !CONNECTION_ID.test(scope.connectionId) || scope.provider !== "GCP" ||
    !BILLING_ACCOUNT.test(scope.billingAccountId) || !PROJECT_ID.test(scope.exportProjectId) || !DATASET_ID.test(scope.datasetId) ||
    !TABLE_ID.test(scope.billingTableId) || !PROJECT_ID.test(scope.pricingProjectId) || !DATASET_ID.test(scope.pricingDatasetId) ||
    !TABLE_ID.test(scope.pricingTableId) || !SAFE_ID.test(scope.location)) reject();
}

function validateLabels(labels: readonly GcpBillingLabel[]): void {
  if (!Array.isArray(labels) || labels.length > GCP_CLOUD_INTELLIGENCE_BOUNDS.maximumLabelsPerRow) reject();
  let previous = "";
  for (const label of labels) {
    if (!LABEL_KEY.test(label.key) || !text(label.value, 256) || label.key <= previous) reject();
    previous = label.key;
  }
}

function validateRow(row: GcpBillingExportRow, scope: GcpBillingScope): void {
  if (!SHA256.test(row.sourceRowSha256) || !MONTH.test(row.invoiceMonth) || !iso(row.usageStartTime) || !iso(row.usageEndTime) ||
    Date.parse(row.usageEndTime) < Date.parse(row.usageStartTime) || row.billingAccountId !== scope.billingAccountId ||
    (row.projectId !== null && !PROJECT_ID.test(row.projectId)) || (row.projectName !== null && !text(row.projectName)) ||
    !Array.isArray(row.projectAncestors) || row.projectAncestors.length > 32 || row.projectAncestors.some((item) => !text(item)) ||
    !text(row.serviceId) || !text(row.serviceDescription) || !text(row.skuId) || !text(row.skuDescription) ||
    (row.locationRegion !== null && !text(row.locationRegion)) || (row.locationZone !== null && !text(row.locationZone)) ||
    (row.locationCountry !== null && !/^[A-Z]{2}$/u.test(row.locationCountry)) ||
    (row.resourceGlobalName !== null && !text(row.resourceGlobalName, 2_048)) || (row.resourceName !== null && !text(row.resourceName)) ||
    !decimal(row.usageAmount) || !text(row.usageUnit) || (row.pricingQuantity !== null && !decimal(row.pricingQuantity)) ||
    (row.pricingUnit !== null && !text(row.pricingUnit)) || !["regular", "tax", "adjustment", "rounding_error"].includes(row.costType) ||
    !CURRENCY.test(row.currency) || !nanos(row.costBeforeCreditsNanos) ||
    (row.calculatedListCostNanos !== null && !nanos(row.calculatedListCostNanos)) ||
    (row.pricingSourceSha256 !== null && !SHA256.test(row.pricingSourceSha256)) ||
    (row.calculatedListCostNanos === null) !== (row.pricingSourceSha256 === null)) reject();
  validateLabels(row.labels); validateLabels(row.systemLabels);
  if (!Array.isArray(row.credits) || row.credits.length > GCP_CLOUD_INTELLIGENCE_BOUNDS.maximumCreditsPerRow) reject();
  for (const credit of row.credits) if ((credit.id !== null && !text(credit.id)) || !text(credit.name) ||
    !["COMMITTED_USAGE_DISCOUNT", "SUSTAINED_USAGE_DISCOUNT", "DISCOUNT", "FREE_TIER", "PROMOTION", "RESELLER_MARGIN", "OTHER"].includes(credit.type) || !nanos(credit.amountNanos)) reject();
}

function validateOpportunity(row: GcpCalculatedOpportunity): void {
  if (!SAFE_ID.test(row.opportunityId) || !["GCP_RECOMMENDER_EXPORT", "GCP_PRICING_EXPORT_VARIANCE"].includes(row.source) ||
    (row.projectId !== null && !PROJECT_ID.test(row.projectId)) || !text(row.serviceDescription) ||
    (row.resourceGlobalName !== null && !text(row.resourceGlobalName, 2_048)) || (row.locationRegion !== null && !text(row.locationRegion)) ||
    !CURRENCY.test(row.currency) || !nanos(row.estimatedMonthlySavingsNanos) || BigInt(row.estimatedMonthlySavingsNanos) < BigInt(0) ||
    !iso(row.observedAt) || !SHA256.test(row.sourceRecordSha256) || !["ACTIVE", "CLAIMED", "SUCCEEDED", "DISMISSED"].includes(row.state)) reject();
}

export function normalizeGcpBillingExportCapture(capture: GcpBillingExportCapture, expectedScope: GcpBillingScope, nowMs = Date.now()): GcpBillingSnapshot {
  validateGcpBillingScope(expectedScope); validateGcpBillingScope(capture.scope);
  if (!sameScope(capture.scope, expectedScope)) reject("SCOPE_MISMATCH");
  if (capture.schemaVersion !== "sutra.gcp-cloud-billing-export.v1" || !CAPTURE_ID.test(capture.captureId) || !iso(capture.startedAt) || !iso(capture.completedAt) ||
    Date.parse(capture.completedAt) < Date.parse(capture.startedAt) || Date.parse(capture.completedAt) > nowMs + 300_000 ||
    (capture.dataThroughAt !== null && (!iso(capture.dataThroughAt) || Date.parse(capture.dataThroughAt) > Date.parse(capture.completedAt))) ||
    !Array.isArray(capture.activation.activationReasons) || capture.activation.activationReasons.length > 32 || capture.activation.activationReasons.some((item) => !text(item)) ||
    capture.lineage.source !== "GCP_CLOUD_BILLING_DETAILED_USAGE_EXPORT" ||
    (capture.lineage.bigQueryJobId !== null && !JOB_ID.test(capture.lineage.bigQueryJobId)) ||
    (capture.lineage.querySha256 !== null && !SHA256.test(capture.lineage.querySha256)) ||
    (capture.lineage.billingTableSchemaSha256 !== null && !SHA256.test(capture.lineage.billingTableSchemaSha256)) ||
    (capture.lineage.pricingTableSchemaSha256 !== null && !SHA256.test(capture.lineage.pricingTableSchemaSha256)) ||
    (capture.lineage.expectedRowCount !== null && !safeCount(capture.lineage.expectedRowCount, GCP_CLOUD_INTELLIGENCE_BOUNDS.maximumRows)) ||
    !Array.isArray(capture.rows) || capture.rows.length > GCP_CLOUD_INTELLIGENCE_BOUNDS.maximumRows ||
    !Array.isArray(capture.opportunities.rows) || capture.opportunities.rows.length > GCP_CLOUD_INTELLIGENCE_BOUNDS.maximumOpportunityRows) reject();
  const seen = new Set<string>();
  for (const row of capture.rows) { validateRow(row, expectedScope); if (seen.has(row.sourceRowSha256)) reject("DUPLICATE_CONFLICT"); seen.add(row.sourceRowSha256); }
  for (const row of capture.opportunities.rows) validateOpportunity(row);
  const activation = capture.activation;
  let sourceState: GcpBillingSourceState;
  if (!activation.billingExportConfigured || !activation.pricingExportConfigured) sourceState = "CONFIGURATION_REQUIRED";
  else if (!activation.workloadIdentityBindingPresent || !activation.permissionsValidated) sourceState = "PERMISSION_REQUIRED";
  else if (capture.dataThroughAt === null && capture.rows.length === 0) sourceState = "WAITING_FIRST_DELIVERY";
  else if (!activation.detailedUsageExport || !capture.lineage.rowsExhausted || capture.lineage.bigQueryJobId === null || capture.lineage.querySha256 === null ||
    capture.lineage.billingTableSchemaSha256 === null || capture.lineage.pricingTableSchemaSha256 === null ||
    (capture.lineage.expectedRowCount !== null && capture.lineage.expectedRowCount !== capture.rows.length)) sourceState = "PARTIAL_PIPELINE";
  else sourceState = capture.rows.length === 0 ? "EMPTY" : "READY";
  const complete = sourceState === "READY" || sourceState === "EMPTY";
  const limitations = [
    "Billed cost and credits are provider export facts; pricing variance and recommendation savings are separate calculated channels.",
    "Cloud Billing export delivery is asynchronous and has no provider delivery or latency guarantee.",
    "Project hierarchy and labels reflect the resource state when Google recorded usage, not later edits.",
    ...(activation.detailedUsageExport ? [] : ["Resource-level and detailed service views require the detailed usage export."]),
    ...(activation.gkeCostAllocationEnabled ? [] : ["Kubernetes cluster allocation is unavailable until GKE cost allocation is enabled in the export."]),
    ...(capture.opportunities.state === "NOT_CONFIGURED" ? ["GCP recommendation savings are not configured; no opportunity values are inferred from spend."] : []),
  ];
  return { ...capture, schemaVersion: "sutra.gcp-cloud-billing-snapshot.v1", sourceState, complete, limitations };
}

function add(map: Map<string, bigint>, key: string, amount: string | bigint): void { map.set(key, (map.get(key) ?? BigInt(0)) + BigInt(amount)); }
function net(row: GcpBillingExportRow): bigint { return BigInt(row.costBeforeCreditsNanos) + row.credits.reduce((sum, credit) => sum + BigInt(credit.amountNanos), BigInt(0)); }
function value(value: string | null): string { return value ?? "Unallocated"; }
function series(map: Map<string, bigint>) { return [...map].map(([name, amountNanos]) => ({ name, amountNanos: amountNanos.toString() })).sort((a, b) => a.name.localeCompare(b.name)); }

export function buildGcpCloudIntelligenceDashboard(snapshot: GcpBillingSnapshot, filters: GcpDashboardFilters = {}) {
  const selected = snapshot.rows.filter((row) =>
    (!filters.invoiceMonth || row.invoiceMonth === filters.invoiceMonth.replace("-", "")) &&
    (!filters.projectId || row.projectId === filters.projectId) && (!filters.service || row.serviceDescription === filters.service) &&
    (!filters.sku || row.skuDescription === filters.sku) && (!filters.region || value(row.locationRegion) === filters.region) &&
    (!filters.currency || row.currency === filters.currency) &&
    (!filters.labelKey || row.labels.some((label) => label.key === filters.labelKey && (!filters.labelValue || label.value === filters.labelValue)))
  );
  const totals = new Map<string, { cost: bigint; credits: bigint; list: bigint; listCovered: number }>();
  const months = new Map<string, bigint>(), projects = new Map<string, bigint>(), services = new Map<string, bigint>(), skus = new Map<string, bigint>(), regions = new Map<string, bigint>(), resources = new Map<string, bigint>(), costs = new Map<string, bigint>(), credits = new Map<string, bigint>(), kubernetes = new Map<string, bigint>();
  for (const row of selected) {
    const total = totals.get(row.currency) ?? { cost: BigInt(0), credits: BigInt(0), list: BigInt(0), listCovered: 0 };
    total.cost += BigInt(row.costBeforeCreditsNanos); total.credits += row.credits.reduce((sum, credit) => sum + BigInt(credit.amountNanos), BigInt(0));
    if (row.calculatedListCostNanos !== null) { total.list += BigInt(row.calculatedListCostNanos); total.listCovered += 1; } totals.set(row.currency, total);
    const key = `${row.currency}|`; add(months, `${key}${row.invoiceMonth}`, net(row)); add(projects, `${key}${value(row.projectName ?? row.projectId)}`, net(row));
    add(services, `${key}${row.serviceDescription}`, net(row)); add(skus, `${key}${row.skuDescription}`, net(row)); add(regions, `${key}${value(row.locationRegion)}`, net(row));
    add(resources, `${key}${value(row.resourceName ?? row.resourceGlobalName)}`, net(row)); add(costs, `${key}${row.costType}`, net(row));
    for (const credit of row.credits) add(credits, `${key}${credit.type}`, credit.amountNanos);
    const cluster = [...row.labels, ...row.systemLabels].find((label) => label.key === "goog-k8s-cluster-name")?.value;
    if (cluster) add(kubernetes, `${key}${cluster}`, net(row));
  }
  const actualBilled: GcpMoneyTotal[] = [...totals].map(([currency, total]) => ({ currency, costBeforeCreditsNanos: total.cost.toString(), creditsNanos: total.credits.toString(), netBilledCostNanos: (total.cost + total.credits).toString(), calculatedListCostNanos: total.listCovered === 0 ? null : total.list.toString(), calculatedPricingVarianceNanos: total.listCovered === 0 ? null : (total.list - total.cost).toString() })).sort((a, b) => a.currency.localeCompare(b.currency));
  const opportunities = snapshot.opportunities.rows.filter((row) => (!filters.projectId || row.projectId === filters.projectId) && (!filters.service || row.serviceDescription === filters.service) && (!filters.region || value(row.locationRegion) === filters.region) && (!filters.currency || row.currency === filters.currency));
  return {
    schema: "sutra.finops-gcp-cloud-intelligence-dashboard.v1" as const,
    views: ["Summary", "Compute Engine", "Cloud SQL", "BigQuery", "Network", "Kubernetes", "Credits & discounts", "Resources & labels", "Opportunities", "Evidence"] as const,
    scope: snapshot.scope,
    sourceState: snapshot.sourceState,
    actualBilled,
    rowCount: selected.length,
    costTrendByInvoiceMonth: series(months), costByProject: series(projects), costByService: series(services), costBySku: series(skus), costByRegion: series(regions), costByResource: series(resources), costByType: series(costs), creditsByType: series(credits), kubernetesCostByCluster: series(kubernetes),
    calculatedOpportunities: { state: snapshot.opportunities.state, rows: opportunities, totalByCurrency: series(opportunities.reduce((map, row) => { add(map, row.currency, row.estimatedMonthlySavingsNanos); return map; }, new Map<string, bigint>())) },
    coverage: { detailedUsageExport: snapshot.activation.detailedUsageExport, pricingExport: snapshot.activation.pricingExportConfigured, gkeCostAllocation: snapshot.activation.gkeCostAllocationEnabled, dataThroughAt: snapshot.dataThroughAt },
    lineage: snapshot.lineage,
    limitations: snapshot.limitations,
  };
}

export function gcpFormulaSafeCsvCell(value: unknown): string {
  let rendered = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/u.test(rendered)) rendered = `'${rendered}`;
  return `"${rendered.replaceAll('"', '""')}"`;
}
