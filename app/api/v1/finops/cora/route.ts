import { CoraRepository } from "../../../../../db/finops-cora-repository";
import { CoraRuntimeStatusRepository } from "../../../../../db/finops-cora-runtime-status";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  buildCoraDashboardProjection,
  type CoraDashboardFilters,
} from "../../../../../lib/finops-cora-dashboard";
import { CORA_OFFICIAL_DEFINITION } from "../../../../../lib/finops-cora-official-definition";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+=,-]{0,511}$/u;
const REGION = /^(?:[a-z]{2}(?:-gov)?-[a-z]+-[0-9]|global)$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const ALLOWED = new Set([
  "connectionId", "accountId", "optimizationClass", "actionType", "region",
  "implementationEffort", "workflowStatus", "currencyCode", "tagKey", "tagValue",
  "resourceId", "restartNeeded", "rollbackPossible", "excludeFinopsExceptions",
]);
const FRESHNESS_HOURS = 48;

function invalid(): never {
  throw Object.assign(new Error("The CORA dashboard request is invalid"), {
    code: "INVALID_INPUT", status: 400,
  });
}

function parse(request: Request): { readonly connectionId: string; readonly filters: CoraDashboardFilters } {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (parameters.getAll(key).length > 1) invalid();
  const connectionId = parameters.get("connectionId") ?? "";
  const accountId = parameters.get("accountId");
  const optimizationClass = parameters.get("optimizationClass");
  const actionType = parameters.get("actionType");
  const region = parameters.get("region");
  const implementationEffort = parameters.get("implementationEffort");
  const workflowStatus = parameters.get("workflowStatus");
  const currencyCode = parameters.get("currencyCode");
  const tagKey = parameters.get("tagKey");
  const tagValue = parameters.get("tagValue");
  const resourceId = parameters.get("resourceId");
  const restartNeeded = parameters.get("restartNeeded");
  const rollbackPossible = parameters.get("rollbackPossible");
  const excludeFinopsExceptions = parameters.get("excludeFinopsExceptions");
  if (
    !CONNECTION_ID.test(connectionId)
    || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (optimizationClass !== null && !new Set([
      "RESOURCE_USAGE_OPTIMIZATION", "RATE_COMMITMENT_OPTIMIZATION",
    ]).has(optimizationClass))
    || (actionType !== null && !new Set([
      "Rightsize", "Stop", "Upgrade", "PurchaseSavingsPlans",
      "PurchaseReservedInstances", "MigrateToGraviton", "Delete", "ScaleIn",
    ]).has(actionType))
    || (region !== null && !REGION.test(region))
    || (implementationEffort !== null && !new Set([
      "VeryLow", "Low", "Medium", "High", "VeryHigh",
    ]).has(implementationEffort))
    || (workflowStatus !== null && !new Set([
      "NEW", "TRIAGED", "APPROVED", "IN_PROGRESS", "IMPLEMENTED", "DISMISSED",
    ]).has(workflowStatus))
    || (currencyCode !== null && !CURRENCY.test(currencyCode))
    || (tagKey !== null && !TOKEN.test(tagKey))
    || (tagValue !== null && (tagKey === null || !TOKEN.test(tagValue)))
    || (resourceId !== null && !RESOURCE_ID.test(resourceId))
    || (restartNeeded !== null && restartNeeded !== "true" && restartNeeded !== "false")
    || (rollbackPossible !== null && rollbackPossible !== "true" && rollbackPossible !== "false")
    || (excludeFinopsExceptions !== null
      && excludeFinopsExceptions !== "true" && excludeFinopsExceptions !== "false")
  ) invalid();
  return { connectionId, filters: {
    accountId,
    optimizationClass: optimizationClass as CoraDashboardFilters["optimizationClass"],
    actionType: actionType as CoraDashboardFilters["actionType"],
    region,
    implementationEffort: implementationEffort as CoraDashboardFilters["implementationEffort"],
    workflowStatus: workflowStatus as CoraDashboardFilters["workflowStatus"],
    currencyCode, tagKey, tagValue, resourceId,
    restartNeeded: restartNeeded === null ? null : restartNeeded === "true",
    rollbackPossible: rollbackPossible === null ? null : rollbackPossible === "true",
    excludeFinopsExceptions: excludeFinopsExceptions === "true",
  } };
}

function ageHours(value: string | null): number | null {
  if (value === null) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || epoch > Date.now() + 300_000) return null;
  return Math.round(Math.max(0, (Date.now() - epoch) / 3_600_000) * 100) / 100;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, query.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const repository = new CoraRepository();
    const [active, latest, persistedHistory, collection] = await Promise.all([
      repository.getActiveSnapshot(scope),
      repository.getLatestSnapshot(scope),
      repository.listHistory(scope, 30),
      new CoraRuntimeStatusRepository().getStatus(scope),
    ]);
    const selected = active ?? latest;
    if (selected === null) return jsonResponse({
      schema: "sutra.finops-cora-dashboard.v1",
      connectionId: connection.id,
      sourceState: "configuration_required",
      officialDefinition: CORA_OFFICIAL_DEFINITION,
      dashboard: null,
      collection,
    });
    const freshnessAgeHours = ageHours(selected.snapshot.sourceDataThroughAt);
    const projection = buildCoraDashboardProjection(
      selected.snapshot,
      persistedHistory.map((item) => ({
        generationId: item.generationId,
        collectedAtIso: item.collectedAtIso,
        dataThroughAtIso: item.dataThroughAtIso,
        sourceState: item.sourceState,
        recommendationCount: item.recommendationCount,
        summaries: item.summaries,
      })),
      query.filters,
    );
    const newerIncomplete = active !== null && latest !== null
      && latest.generationId !== active.generationId;
    const mapped = selected.snapshot.state === "READY" ? "complete"
      : selected.snapshot.state === "ERROR" ? "failed"
        : selected.snapshot.state.toLowerCase();
    const sourceState = newerIncomplete ? "partial"
      : mapped === "complete" && (freshnessAgeHours === null || freshnessAgeHours > FRESHNESS_HOURS)
        ? "stale"
        : projection.resultCount === 0 && mapped === "complete" ? "empty" : mapped;
    return jsonResponse({
      ...projection,
      connectionId: connection.id,
      source: "AWS_COST_OPTIMIZATION_HUB_DATA_EXPORT",
      sourceState,
      officialDefinition: CORA_OFFICIAL_DEFINITION,
      freshness: {
        dataThroughAt: selected.snapshot.sourceDataThroughAt,
        ageHours: freshnessAgeHours,
        staleAfterHours: FRESHNESS_HOURS,
      },
      evidence: {
        generationId: selected.generationId,
        activeGenerationId: active?.generationId ?? null,
        latestGenerationId: latest?.generationId ?? null,
        newerIncomplete,
        sourceCaptureId: selected.snapshot.sourceCaptureId,
        contentSha256: selected.contentSha256,
        organizationCoverage: selected.snapshot.organizationCoverage,
        coverage: selected.snapshot.coverage,
        channelStates: selected.snapshot.channelStates,
        limitations: selected.snapshot.limitations,
      },
      collection,
      disclosures: [
        "AWS estimates are not realized savings or invoices.",
        "Opportunity cards select the maximum recommendation per resource within Usage or Rate; rows without resource IDs remain non-deduplicated.",
        "Raw recommendation totals remain evidence only and are not portfolio savings claims.",
        "Rate optimization is not adjusted for implementing usage optimization recommendations.",
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
