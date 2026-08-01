import { AzureCidRepository, type AzureCidSource } from "../../../../../db/finops-azure-cid-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildAzureCidDashboard, type AzureCidFilters } from "../../../../../lib/finops-azure-cid";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const SOURCE = /^azsrc_[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9-]{36}$/u;
const SAFE = /^[^\0\r\n<>]{1,512}$/u;
const ALLOWED = new Set(["sourceId", "subscriptionId", "serviceName", "regionName", "resourceGroupName", "pricingCategory", "chargeCategory", "tagKey", "tagValue"]);

function invalid(): never { throw Object.assign(new Error("The Azure CID request is invalid"), { code: "INVALID_INPUT", status: 400 }); }
function parse(request: Request): { sourceId: string | null; filters: AzureCidFilters } {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (params.getAll(key).length > 1) invalid();
  const sourceId = params.get("sourceId");
  const subscriptionId = params.get("subscriptionId"), serviceName = params.get("serviceName"), regionName = params.get("regionName"), resourceGroupName = params.get("resourceGroupName"), pricingCategory = params.get("pricingCategory"), chargeCategory = params.get("chargeCategory"), tagKey = params.get("tagKey"), tagValue = params.get("tagValue");
  if ((sourceId !== null && !SOURCE.test(sourceId)) || (subscriptionId !== null && !UUID.test(subscriptionId)) || [serviceName, regionName, resourceGroupName, tagKey, tagValue].some((value) => value !== null && !SAFE.test(value)) || (pricingCategory !== null && !["ON_DEMAND", "COMMITMENT_DISCOUNT", "SPOT", "OTHER"].includes(pricingCategory)) || (chargeCategory !== null && !["USAGE", "PURCHASE", "TAX", "CREDIT", "REFUND", "ADJUSTMENT", "OTHER"].includes(chargeCategory)) || (tagValue !== null && tagKey === null)) invalid();
  return { sourceId, filters: { subscriptionId, serviceName, regionName, resourceGroupName, pricingCategory, chargeCategory, tagKey, tagValue } };
}

function sourceOption(source: AzureCidSource) { return { sourceId: source.scope.sourceId, azureTenantId: source.scope.azureTenantId, billingScopeKind: source.scope.billingScopeKind, status: source.status, activationReason: source.activationReason }; }

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request), authenticated = await requireApiSession(request), repository = new AzureCidRepository();
    const organizationSources = await repository.listSourcesForOrganization(authenticated.subject.orgId);
    const authorizedSources = organizationSources.filter((source) => { try { assertSessionCapability(authenticated, "connection:read", source.scope.customerId); return true; } catch { return false; } });
    const availableSources = authorizedSources.map(sourceOption);
    if (query.sourceId === null) return jsonResponse({ schema: "sutra.finops-azure-cid-dashboard.v1", sourceId: null, sourceState: "configuration_required", dashboard: null, availableSources, activation: { ready: false, reason: availableSources.length === 0 ? "AZURE_SOURCE_NOT_REGISTERED" : "AZURE_SOURCE_NOT_SELECTED" } });
    const source = authorizedSources.find((candidate) => candidate.scope.sourceId === query.sourceId);
    if (source === undefined) return jsonResponse({ schema: "sutra.finops-azure-cid-dashboard.v1", sourceId: query.sourceId, sourceState: "configuration_required", dashboard: null, availableSources, activation: { ready: false, reason: "AZURE_SOURCE_NOT_REGISTERED" } });
    if (source.status !== "active" || source.activationReason !== "READY") return jsonResponse({ schema: "sutra.finops-azure-cid-dashboard.v1", sourceId: query.sourceId, sourceState: "configuration_required", dashboard: null, availableSources, activation: { ready: false, reason: source.activationReason } });
    const scope = { organizationId: authenticated.subject.orgId, customerId: source.scope.customerId, sourceId: source.scope.sourceId };
    const [active, latest, history] = await Promise.all([repository.getActiveSnapshot(scope), repository.getLatestSnapshot(scope), repository.listHistory(scope, 30)]), selected = active ?? latest;
    if (selected === null) return jsonResponse({ schema: "sutra.finops-azure-cid-dashboard.v1", sourceId: query.sourceId, sourceState: "configuration_required", dashboard: null, availableSources, activation: { ready: false, reason: "AZURE_EXPORT_DELIVERY_NOT_OBSERVED" } });
    const dashboard = buildAzureCidDashboard(selected.snapshot, query.filters), ageHours = Math.round(Math.max(0, (Date.now() - Date.parse(selected.snapshot.dataThroughAt)) / 3_600_000) * 100) / 100, newerIncomplete = active !== null && latest !== null && active.generationId !== latest.generationId;
    const sourceState = newerIncomplete ? "partial" : active === null ? selected.snapshot.state.toLowerCase() : ageHours > 48 ? "stale" : dashboard.resultCount === 0 ? "empty" : "complete";
    return jsonResponse({ schema: "sutra.finops-azure-cid-dashboard.v1", sourceId: query.sourceId, sourceState, dashboard, availableSources, history, activation: { ready: true, reason: "READY" }, freshness: { dataThroughAt: selected.snapshot.dataThroughAt, ageHours, staleAfterHours: 48 }, evidence: { generationId: selected.generationId, activeGenerationId: active?.generationId ?? null, latestGenerationId: latest?.generationId ?? null, newerIncomplete, sourceGenerationId: selected.snapshot.generationId, manifestSha256: selected.snapshot.manifestSha256, exportName: selected.snapshot.exportName, exportRunId: selected.snapshot.exportRunId, datasetKind: selected.snapshot.datasetKind, reconciliationState: selected.snapshot.reconciliationState, rowsExhausted: selected.snapshot.rowsExhausted, coverage: selected.snapshot.coverage, contentSha256: selected.contentSha256, billingScopeKind: source.scope.billingScopeKind, billingScopeHash: source.scope.billingScopeHash }, semantics: { realizedCostField: "billedCostMicros", effectiveCostField: "effectiveCostMicros_when_exported", calculatedOpportunityFields: ["calculatedListDeltaMicros", "calculatedContractedDeltaMicros"], calculatedOpportunityIsRealizedSavings: false, currenciesCombined: false, exactMoney: "SIGNED_INTEGER_MICROS" }, collector: { contractAvailable: true, providerAdapterAvailable: false, reason: "AZURE_EXPORT_ADAPTER_NOT_DEPLOYED" } });
  } catch (error) { return errorResponse(error); }
}
