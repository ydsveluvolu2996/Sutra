import { AwsMarketplaceSpgRepository } from "../../../../../db/finops-marketplace-spg-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import type { AwsMarketplaceCur2SpendRow, AwsMarketplaceSpgSnapshot } from "../../../../../lib/finops-marketplace-spg";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u; const ACCOUNT_ID = /^\d{12}$/u;
const SAFE = /^[^\0\r\n<>]{1,255}$/u; const CURRENCY = /^[A-Z]{3}$/u; const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const ALLOWED = new Set(["connectionId", "accountId", "product", "seller", "currency", "billingPeriod", "agreementStatus", "expirationState", "licenseStatus"]);
function invalid(): never { throw Object.assign(new Error("The Marketplace SPG request is invalid"), { code: "INVALID_INPUT", status: 400 }); }
interface Filters { accountId: string | null; product: string | null; seller: string | null; currency: string | null; billingPeriod: string | null; agreementStatus: string | null; expirationState: string | null; licenseStatus: string | null }
function parse(request: Request): { connectionId: string; filters: Filters } {
  const values = new URL(request.url).searchParams; for (const key of values.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (values.getAll(key).length > 1) invalid();
  const connectionId = values.get("connectionId") ?? ""; const accountId = values.get("accountId");
  const product = values.get("product"); const seller = values.get("seller"); const currency = values.get("currency");
  const billingPeriod = values.get("billingPeriod"); const agreementStatus = values.get("agreementStatus");
  const expirationState = values.get("expirationState"); const licenseStatus = values.get("licenseStatus");
  if (!CONNECTION_ID.test(connectionId) || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || [product, seller].some((value) => value !== null && !SAFE.test(value)) || (currency !== null && !CURRENCY.test(currency))
    || (billingPeriod !== null && !PERIOD.test(billingPeriod))
    || (agreementStatus !== null && !["ACTIVE","ARCHIVED","CANCELLED","EXPIRED","RENEWED","REPLACED","TERMINATED"].includes(agreementStatus))
    || (expirationState !== null && !["NO_END_DATE","EXPIRED","EXPIRING_30_DAYS","EXPIRING_60_DAYS","EXPIRING_90_DAYS","ACTIVE_BEYOND_90_DAYS"].includes(expirationState))
    || (licenseStatus !== null && !["AVAILABLE","PENDING_AVAILABLE","DEACTIVATED","SUSPENDED","EXPIRED","PENDING_DELETE","DELETED"].includes(licenseStatus))) invalid();
  return { connectionId, filters: { accountId, product, seller, currency, billingPeriod, agreementStatus, expirationState, licenseStatus } };
}
function contains(value: string | null, expected: string | null): boolean { return expected === null || (value ?? "").toLocaleLowerCase().includes(expected.toLocaleLowerCase()); }
function sumSpend(rows: readonly AwsMarketplaceCur2SpendRow[]) {
  const totals = new Map<string, { billed: bigint; amortized: bigint; hasAmortized: boolean; rowCount: number }>();
  for (const row of rows) { const value = totals.get(row.currency) ?? { billed: BigInt(0), amortized: BigInt(0), hasAmortized: false, rowCount: 0 };
    value.billed += BigInt(row.billedAmountMicros); if (row.amortizedAmountMicros !== null) { value.amortized += BigInt(row.amortizedAmountMicros); value.hasAmortized = true; }
    value.rowCount += 1; totals.set(row.currency, value); }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, billedAmountMicros: value.billed.toString(), amortizedAmountMicros: value.hasAmortized ? value.amortized.toString() : null, rowCount: value.rowCount }));
}
function dashboard(snapshot: AwsMarketplaceSpgSnapshot, filters: Filters) {
  const agreements = snapshot.agreements.filter((row) => (filters.accountId === null || row.sourceAccountId === filters.accountId)
    && (filters.agreementStatus === null || row.status === filters.agreementStatus) && (filters.expirationState === null || row.expirationState === filters.expirationState)
    && contains(row.product?.productName ?? row.productId, filters.product) && contains(row.product?.sellerDisplayName ?? null, filters.seller));
  const licenses = snapshot.licenses.filter((row) => (filters.accountId === null || row.beneficiaryAccountId === filters.accountId)
    && (filters.licenseStatus === null || row.status === filters.licenseStatus) && contains(row.productName, filters.product));
  const licenseIds = new Set(licenses.map((row) => row.licenseArn)); const grants = snapshot.grants.filter((row) => licenseIds.has(row.licenseArn));
  const spendRows = snapshot.spend.rows.filter((row) => (filters.accountId === null || row.linkedAccountId === filters.accountId)
    && contains(row.productName, filters.product) && contains(row.sellerName, filters.seller)
    && (filters.currency === null || row.currency === filters.currency) && (filters.billingPeriod === null || row.billingPeriod === filters.billingPeriod));
  const trends = new Map<string, AwsMarketplaceCur2SpendRow[]>(); for (const row of spendRows) { const key = `${row.billingPeriod}:${row.currency}`; trends.set(key, [...(trends.get(key) ?? []), row]); }
  return { filters, filterOptions: {
    accounts: [...new Set([...snapshot.agreements.map((row) => row.sourceAccountId), ...snapshot.licenses.map((row) => row.beneficiaryAccountId), ...snapshot.spend.rows.map((row) => row.linkedAccountId)])].sort(),
    products: [...new Set([...snapshot.agreements.map((row) => row.product?.productName ?? row.productId).filter((value): value is string => value !== null), ...snapshot.licenses.map((row) => row.productName), ...snapshot.spend.rows.map((row) => row.productName)])].sort(),
    sellers: [...new Set([...snapshot.agreements.map((row) => row.product?.sellerDisplayName).filter((value): value is string => value !== undefined), ...snapshot.spend.rows.map((row) => row.sellerName)])].sort(),
    currencies: [...new Set(snapshot.spend.rows.map((row) => row.currency))].sort(), periods: [...new Set(snapshot.spend.rows.map((row) => row.billingPeriod))].sort().reverse(),
  }, summaries: sumSpend(spendRows), trends: [...trends].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, rows]) => sumSpend(rows).map((sum) => ({ billingPeriod: key.slice(0, 7), ...sum }))),
  agreements: agreements.slice(0, 500), agreementsTruncated: agreements.length > 500,
  licenses: licenses.slice(0, 500), licensesTruncated: licenses.length > 500,
  grants: grants.slice(0, 500), grantsTruncated: grants.length > 500,
  spendRows: spendRows.slice(0, 500), spendRowsTruncated: spendRows.length > 500,
  counts: { agreements: agreements.length, expiringWithin90Days: agreements.filter((row) => row.expirationState.startsWith("EXPIRING_")).length,
    licenses: licenses.length, grants: grants.length, activeGrants: grants.filter((row) => row.status === "ACTIVE").length, spendRows: spendRows.length } };
}
export async function GET(request: Request): Promise<Response> {
  try { const query = parse(request); const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, query.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active" || connection.partition !== "aws")
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new AwsMarketplaceSpgRepository(); const [active, latest, history] = await Promise.all([
      repository.getActiveSnapshot(scope), repository.getLatestSnapshot(scope), repository.listHistory(scope, 30)]);
    const selected = active ?? latest; if (selected === null) return jsonResponse({ schema: "sutra.finops-marketplace-spg-dashboard.v1", connectionId: connection.id,
      sourceState: "configuration_required", dashboard: null, collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "MARKETPLACE_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED" } });
    const ageHours = Math.round(Math.max(0, (Date.now() - Date.parse(selected.snapshot.freshness.dataThroughAt)) / 3_600_000) * 100) / 100;
    const newerIncomplete = active !== null && latest !== null && active.generationId !== latest.generationId;
    const projected = dashboard(selected.snapshot, query.filters); const sourceState = newerIncomplete ? "partial" : active === null ? selected.snapshot.state.toLowerCase()
      : ageHours > 48 ? "stale" : projected.counts.agreements + projected.counts.licenses + projected.counts.spendRows === 0 ? "empty" : "complete";
    return jsonResponse({ schema: "sutra.finops-marketplace-spg-dashboard.v1", connectionId: connection.id, sourceState, dashboard: projected, history,
      source: { organizationCoverage: selected.snapshot.organizationCoverage, channelStates: selected.snapshot.channelStates, limitations: selected.snapshot.limitations },
      freshness: { dataThroughAt: selected.snapshot.freshness.dataThroughAt, ageHours, staleAfterHours: 48 },
      provenance: { generationId: selected.generationId, activeGenerationId: active?.generationId ?? null, latestGenerationId: latest?.generationId ?? null,
        newerIncomplete, captureId: selected.snapshot.captureId, contentSha256: selected.contentSha256,
        cur2GenerationId: selected.snapshot.spend.generationId, cur2SourceEvidenceId: selected.snapshot.spend.sourceEvidenceId, cur2Predicate: selected.snapshot.spend.predicate },
      separation: { realizedSpendSource: "ACTIVE_RECONCILED_CUR2_ONLY", agreementsLicensesAndGrantsSource: "AWS_MARKETPLACE_CONTROL_PLANE", crossSourceEntitlementInference: false,
        agreementEstimatedChargesMeaning: "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL" },
      collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "MARKETPLACE_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED" },
      unsupportedOfficialViews: ["Offer classification as public self-service versus private offer is not supplied by the current buyer evidence contract.",
        "Software, data, and professional-services product-type classification is not supplied by the current minimized product metadata contract.",
        "Deployment telemetry is limited to Marketplace product deployedOnAws metadata; resource-level deployment inventory is not inferred."] });
  } catch (error) { return errorResponse(error); }
}
