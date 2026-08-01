import { KubecostAllocationRepository } from "../../../../../db/finops-kubecost-allocation-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildKubecostDashboard, type KubecostDashboardFilters } from "../../../../../lib/finops-kubecost-dashboard";
import type { KubecostAllocationKind } from "../../../../../lib/finops-kubecost-allocation";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u; const ACCOUNT = /^\d{12}$/u; const CURRENCY = /^[A-Z]{3}$/u;
const SAFE = /^[^\u0000-\u001f\u007f<>]{1,255}$/u; const CURSOR = /^v1:(?:0|[1-9]\d{0,7})$/u;
const KINDS = new Set(["WORKLOAD","IDLE","SHARED","EXTERNAL","UNALLOCATED","UNMOUNTED"]);
const ALLOWED = new Set(["connectionId","accountId","clusterId","namespace","controllerKind","controller","workload","allocationKind","currency","limit","cursor"]);
function invalid(): never { throw Object.assign(new Error("The Kubecost allocation dashboard request is invalid"), { code: "INVALID_INPUT", status: 400 }); }
function parse(request: Request): { readonly connectionId: string; readonly filters: KubecostDashboardFilters } {
  const values = new URL(request.url).searchParams; for (const key of values.keys()) if (!ALLOWED.has(key)) invalid(); for (const key of ALLOWED) if (values.getAll(key).length > 1) invalid();
  const connectionId = values.get("connectionId") ?? ""; const accountId = values.get("accountId") ?? undefined;
  const clusterId = values.get("clusterId") ?? undefined; const namespace = values.get("namespace") ?? undefined;
  const controllerKind = values.get("controllerKind") ?? undefined; const controller = values.get("controller") ?? undefined;
  const workload = values.get("workload") ?? undefined; const allocationKind = values.get("allocationKind") ?? undefined;
  const currency = values.get("currency") ?? undefined; const cursor = values.get("cursor") ?? undefined;
  const limit = values.get("limit") === null ? 100 : Number(values.get("limit"));
  if (!CONNECTION_ID.test(connectionId) || (accountId !== undefined && !ACCOUNT.test(accountId))
    || [clusterId, namespace, controllerKind, controller, workload].some((item) => item !== undefined && !SAFE.test(item))
    || (allocationKind !== undefined && !KINDS.has(allocationKind)) || (currency !== undefined && !CURRENCY.test(currency))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (cursor !== undefined && !CURSOR.test(cursor))) invalid();
  return { connectionId, filters: { accountId, clusterId, namespace, controllerKind, controller, workload,
    allocationKind: allocationKind as KubecostAllocationKind | undefined, currency, limit, cursor } };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const parsed = parse(request); const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, parsed.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new KubecostAllocationRepository();
    const [active, latest, history] = await Promise.all([repository.getActiveSnapshot(scope), repository.getLatestSnapshot(scope), repository.listHistory(scope, 31)]);
    const selected = active ?? latest;
    if (selected === null) return jsonResponse({ schema: "sutra.finops-kubecost-dashboard.v1", connectionId: connection.id, sourceState: "configuration_required", dashboard: null,
      collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "KUBECOST_EXPORTER_INGEST_ADAPTER_NOT_DEPLOYED" } });
    const dashboard = buildKubecostDashboard(selected.snapshot, parsed.filters);
    const ageHours = Math.round(Math.max(0, (Date.now() - Date.parse(selected.snapshot.dataThroughAtIso)) / 3_600_000) * 100) / 100;
    const newerIncomplete = active !== null && latest !== null && active.generationId !== latest.generationId;
    const sourceState = newerIncomplete ? "partial" : selected.snapshot.state === "ERROR" ? "failed"
      : ["CONFIGURATION_REQUIRED","WAITING_FIRST_DELIVERY","UNKNOWN"].includes(selected.snapshot.state) ? "configuration_required"
        : selected.snapshot.state === "PARTIAL" ? "partial" : ageHours > 24 ? "stale"
          : selected.snapshot.state === "EMPTY" || dashboard.resultCount === 0 ? "empty" : "complete";
    return jsonResponse({ ...dashboard, connectionId: connection.id, sourceState, history,
      freshness: { dataThroughAt: selected.snapshot.dataThroughAtIso, ageHours, staleAfterHours: 24 },
      evidence: { generationId: selected.generationId, activeGenerationId: active?.generationId ?? null, latestGenerationId: latest?.generationId ?? null,
        sourceCaptureId: selected.snapshot.captureId, contentSha256: selected.contentSha256, activeCur2GenerationId: selected.snapshot.scope.activeCur2GenerationId,
        billingPeriod: selected.snapshot.scope.billingPeriod, newerIncomplete },
      collection: { jobContractAvailable: true, providerAdapterAvailable: false, reason: "KUBECOST_EXPORTER_INGEST_ADAPTER_NOT_DEPLOYED" },
      disclosures: ["Kubecost is an allocation view only; do not add it to authoritative CUR2 spend.", "Currencies are never combined or converted.", "Showback is evidence attribution; chargeback posting is outside this read-only dashboard."],
    });
  } catch (error) { return errorResponse(error); }
}
