import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
import { AwsMarketplaceSpgRepository } from "../../../../../db/finops-marketplace-spg-repository";
import { MarketplaceSpgRuntimeRepository } from "../../../../../db/finops-marketplace-spg-runtime-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { projectMarketplaceSpgDashboard, type MarketplaceSpgDashboardFilters } from "../../../../../lib/finops-marketplace-spg-dashboard";
import { MARKETPLACE_SPG_OFFICIAL_DEFINITION } from "../../../../../lib/finops-marketplace-spg-official-definition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u; const ACCOUNT_ID = /^\d{12}$/u;
const SAFE = /^[^\0\r\n<>]{1,255}$/u; const CURRENCY = /^[A-Z]{3}$/u; const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const ALLOWED = new Set(["connectionId", "accountId", "product", "seller", "currency", "billingPeriod", "agreementStatus", "expirationState", "licenseStatus"]);
function invalid(): never { throw Object.assign(new Error("The Marketplace SPG request is invalid"), { code: "INVALID_INPUT", status: 400 }); }
function parse(request: Request): { connectionId: string; filters: MarketplaceSpgDashboardFilters } {
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
export async function GET(request: Request): Promise<Response> {
  try { const query = parse(request); const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, query.connectionId);
    if (connection === null || !isCollectableAwsSourceKind(connection.sourceKind) || connection.status !== "active" || connection.partition !== "aws")
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new AwsMarketplaceSpgRepository(); const runtimeRepository = new MarketplaceSpgRuntimeRepository(); const [active, latest, history, runtime] = await Promise.all([
      repository.getActiveSnapshot(scope), repository.getLatestSnapshot(scope), repository.listHistory(scope, 30), runtimeRepository.getRuntimeStatus(scope)]);
    const selected = active ?? latest; if (selected === null) return jsonResponse({ schema: "sutra.finops-marketplace-spg-dashboard.v1", connectionId: connection.id,
      sourceState: "configuration_required", dashboard: null, officialDefinition: MARKETPLACE_SPG_OFFICIAL_DEFINITION,
      collection: { jobContractAvailable: true, providerAdapterAvailable: true, state: runtime.state, reason: runtime.reason, lastAttemptAt: runtime.lastAttemptAt } });
    const ageHours = Math.round(Math.max(0, (Date.now() - Date.parse(selected.snapshot.freshness.dataThroughAt)) / 3_600_000) * 100) / 100;
    const newerIncomplete = active !== null && latest !== null && active.generationId !== latest.generationId;
    const projected = projectMarketplaceSpgDashboard(selected.snapshot, query.filters); const sourceState = newerIncomplete ? "partial" : active === null ? selected.snapshot.state.toLowerCase()
      : ageHours > 48 ? "stale" : projected.counts.agreements + projected.counts.licenses + projected.counts.spendRows === 0 ? "empty" : "complete";
    return jsonResponse({ schema: "sutra.finops-marketplace-spg-dashboard.v1", connectionId: connection.id, sourceState, dashboard: projected, history,
      officialDefinition: MARKETPLACE_SPG_OFFICIAL_DEFINITION,
      source: { organizationCoverage: selected.snapshot.organizationCoverage, channelStates: selected.snapshot.channelStates, limitations: selected.snapshot.limitations },
      freshness: { dataThroughAt: selected.snapshot.freshness.dataThroughAt, ageHours, staleAfterHours: 48 },
      provenance: { generationId: selected.generationId, activeGenerationId: active?.generationId ?? null, latestGenerationId: latest?.generationId ?? null,
        newerIncomplete, captureId: selected.snapshot.captureId, contentSha256: selected.contentSha256,
        cur2GenerationId: selected.snapshot.spend.generationId, cur2SourceEvidenceId: selected.snapshot.spend.sourceEvidenceId, cur2Predicate: selected.snapshot.spend.predicate },
      separation: { realizedSpendSource: "ACTIVE_RECONCILED_CUR2_ONLY", agreementsLicensesAndGrantsSource: "AWS_MARKETPLACE_CONTROL_PLANE", crossSourceEntitlementInference: false,
        agreementEstimatedChargesMeaning: "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL" },
      collection: { jobContractAvailable: true, providerAdapterAvailable: true, state: runtime.state, reason: runtime.reason, lastAttemptAt: runtime.lastAttemptAt },
      unsupportedOfficialViews: ["Offer classification as public self-service versus private offer is not supplied by the current buyer evidence contract.",
        "Product typing is shown only when bound to the approved product-taxonomy evidence ledger; unapproved products remain explicitly untyped.",
        "Deployment telemetry is limited to Marketplace product deployedOnAws metadata; resource-level deployment inventory is not inferred."] });
  } catch (error) { return errorResponse(error); }
}
