import { MediaServicesRepository } from "../../../../../db/finops-media-services-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  buildMediaServicesPortfolio,
  type MediaServicesDashboardFilters,
} from "../../../../../lib/finops-media-services-dashboard";
import type { MediaCostService, MediaProvider, MediaResourceType } from "../../../../../lib/finops-media-services-insights";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const SAFE_SEARCH = /^[^\u0000-\u001f\u007f<>]{1,100}$/u;
const SERVICES: readonly MediaCostService[] = ["MEDIACONNECT","MEDIACONVERT","MEDIALIVE","MEDIAPACKAGE","MEDIATAILOR"];
const PROVIDERS: readonly MediaProvider[] = ["MEDIACONNECT","MEDIACONVERT","MEDIALIVE","MEDIAPACKAGE_V1","MEDIAPACKAGE_V2","MEDIATAILOR"];
const RESOURCE_TYPES: readonly MediaResourceType[] = ["FLOW","QUEUE","JOB","CHANNEL","MULTIPLEX","OFFERING","RESERVATION","CHANNEL_GROUP","ORIGIN_ENDPOINT","HARVEST_JOB","PLAYBACK_CONFIGURATION","SOURCE_LOCATION","LIVE_SOURCE","VOD_SOURCE"];
const ALLOWED = new Set(["connectionId","accountId","region","service","provider","resourceType","search"]);
const FRESH_HOURS = 48;

function bad(): never { throw Object.assign(new Error("The Media Services Insights request is invalid"), { code: "INVALID_INPUT", status: 400 }); }
function missing(): never { throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 }); }
function member<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  if (value === null) return null; if (!allowed.includes(value as T)) bad(); return value as T;
}
function parse(request: Request): { readonly connectionId: string; readonly filters: MediaServicesDashboardFilters } {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!ALLOWED.has(key)) bad();
  for (const key of ALLOWED) if (values.getAll(key).length > 1) bad();
  const connectionId = values.get("connectionId") ?? ""; const accountId = values.get("accountId");
  const region = values.get("region"); const search = values.get("search");
  if (!CONNECTION_ID.test(connectionId) || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (region !== null && !REGION.test(region)) || (search !== null && !SAFE_SEARCH.test(search))) bad();
  return { connectionId, filters: { accountId, region, service: member(values.get("service"), SERVICES),
    provider: member(values.get("provider"), PROVIDERS), resourceType: member(values.get("resourceType"), RESOURCE_TYPES), search } };
}
function ageHours(value: string): number | null {
  const parsed = Date.parse(value); if (!Number.isFinite(parsed) || parsed > Date.now() + 300_000) return null;
  return Math.round(Math.max(0,(Date.now()-parsed)/3_600_000)*100)/100;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request); const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId,query.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") missing();
    assertSessionCapability(authenticated,"connection:read",connection.customerId);
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new MediaServicesRepository();
    const [activeAll,historyAll] = await Promise.all([repository.listActiveSnapshots(scope),repository.listHistory(scope)]);
    const relevantHistory = historyAll.filter((item) => (query.filters.accountId === null || item.accountId === query.filters.accountId)
      && (query.filters.region === null || item.region === query.filters.region));
    const relevantHeads = activeAll.filter((item) => (query.filters.accountId === null || item.snapshot.scope.accountId === query.filters.accountId)
      && (query.filters.region === null || item.snapshot.scope.region === query.filters.region));
    if (relevantHeads.length === 0) {
      return jsonResponse({ schema: "sutra.finops-media-services-insights.v1", connectionId: connection.id,
        sourceState: relevantHistory[0]?.state ?? "configuration_required", dashboard: null,
        latestAttempt: relevantHistory[0] ?? null,
        collection: { available: false, reason: "MEDIA_SERVICES_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED" },
        limitations: ["No complete accepted Media Services/CUR2 generation is available for this account and Region selection."] });
    }
    const portfolio = buildMediaServicesPortfolio(relevantHeads,query.filters);
    const oldestDataThrough = relevantHeads.map((item) => item.snapshot.costEvidence.dataThroughAtIso).sort().at(0) ?? null;
    const currentAge = oldestDataThrough === null ? null : ageHours(oldestDataThrough);
    const newestActive = relevantHeads.map((item) => item.snapshot.completedAtIso).sort().at(-1) ?? "";
    const newerIncomplete = relevantHistory.some((item) => !item.complete && item.completedAtIso >= newestActive);
    const sourceState = newerIncomplete ? "partial" : currentAge === null || currentAge > FRESH_HOURS ? "stale"
      : portfolio.executiveSummary.resourceCount === 0 && portfolio.executiveSummary.costRowCount === 0 ? "empty" : "complete";
    return jsonResponse({
      schema: "sutra.finops-media-services-insights.v1", connectionId: connection.id,
      source: "AWS_MEDIA_SERVICES_INVENTORY_AND_CUR2_ACTIVE_GENERATION", sourceState,
      freshness: { dataThroughAt: oldestDataThrough, ageHours: currentAge, staleAfterHours: FRESH_HOURS },
      ...portfolio, history: relevantHistory.slice(0,180),
      evidence: { acceptedHeads: relevantHeads.map((item) => ({ generationId: item.generationId,
        contentSha256: item.contentSha256, captureId: item.snapshot.captureId,
        billingGenerationId: item.snapshot.costEvidence.generationId,
        billingManifestSha256: item.snapshot.costEvidence.manifestSha256 })) },
      latestAttempt: relevantHistory[0] ?? null,
      collection: { available: false, reason: "MEDIA_SERVICES_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED" },
      limitations: [...portfolio.limitations,
        "The permanent credential-broker adapter and durable job handler remain provider-validation gates.",
        ...(newerIncomplete ? ["A newer incomplete target generation did not replace the last accepted complete head."] : [])],
    });
  } catch (error) { return errorResponse(error); }
}
