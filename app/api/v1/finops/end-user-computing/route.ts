import { EndUserComputingRepository } from "../../../../../db/finops-end-user-computing-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  buildEndUserComputingDashboard,
  type EndUserComputingDashboardQuery,
  type EndUserComputingService,
} from "../../../../../lib/finops-end-user-computing";
import { END_USER_COMPUTING_OFFICIAL_DEFINITION } from "../../../../../lib/finops-end-user-computing-official-definition";
import { END_USER_COMPUTING_RUNTIME_BINDING } from "../../../../../lib/finops-end-user-computing-runtime-binding";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const CURSOR = /^v1:(?:0|[1-9]\d{0,7})$/u;
const ALLOWED = new Set(["connectionId", "service", "accountId", "region", "limit", "cursor"]);

function invalid(): never {
  throw Object.assign(new Error("The End User Computing dashboard request is invalid"), { code: "INVALID_INPUT", status: 400 });
}

function parse(request: Request): { readonly connectionId: string; readonly query: EndUserComputingDashboardQuery } {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!ALLOWED.has(key)) invalid();
  if (values.getAll("connectionId").length !== 1 || values.getAll("limit").length > 1 || values.getAll("cursor").length > 1) invalid();
  const connectionId = values.get("connectionId") ?? "";
  const services = values.getAll("service");
  const accountIds = values.getAll("accountId");
  const regions = values.getAll("region");
  const limitText = values.get("limit");
  const limit = limitText === null ? 100 : Number(limitText);
  const cursor = values.get("cursor");
  if (!CONNECTION_ID.test(connectionId) || services.length > 2 || accountIds.length > 200 || regions.length > 50
    || services.some((item) => !["WORKSPACES", "APPSTREAM"].includes(item))
    || accountIds.some((item) => !ACCOUNT_ID.test(item)) || regions.some((item) => !REGION.test(item))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || (cursor !== null && !CURSOR.test(cursor))) invalid();
  return { connectionId, query: {
    ...(services.length === 0 ? {} : { services: services as EndUserComputingService[] }),
    ...(accountIds.length === 0 ? {} : { accountIds }),
    ...(regions.length === 0 ? {} : { regions }), limit,
    ...(cursor === null ? {} : { cursor }),
  } };
}

function dataThrough(snapshot: { readonly coverage: readonly { readonly inventoryObservedAt: string | null; readonly activityObservedAt: string | null; readonly metricDataThroughAt: string | null; readonly costDataThroughAt: string | null }[] }) {
  const values = snapshot.coverage.flatMap((row) => [row.inventoryObservedAt, row.activityObservedAt, row.metricDataThroughAt, row.costDataThroughAt])
    .filter((value): value is string => value !== null).map(Date.parse).filter(Number.isFinite);
  return values.length === 0 ? null : new Date(Math.min(...values)).toISOString();
}

export async function GET(request: Request): Promise<Response> {
  try {
    const parsed = parse(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, parsed.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new EndUserComputingRepository();
    const [active, latest, history] = await Promise.all([
      repository.getActiveSnapshot(scope), repository.getLatestSnapshot(scope), repository.listHistory(scope, 30),
    ]);
    const selected = active ?? latest;
    if (selected === null) return jsonResponse({
      schema: "sutra.finops-end-user-computing-dashboard.v1", connectionId: connection.id,
      sourceState: "configuration_required", dashboard: null,
      collection: END_USER_COMPUTING_RUNTIME_BINDING,
      officialDefinition: END_USER_COMPUTING_OFFICIAL_DEFINITION,
      filterOptions: { services: ["WORKSPACES", "APPSTREAM"], accountIds: [], regions: [] },
    });
    const dashboard = buildEndUserComputingDashboard(selected.snapshot, parsed.query);
    const through = dataThrough(selected.snapshot);
    const ageHours = through === null ? null : Math.round(Math.max(0, (Date.now() - Date.parse(through)) / 3_600_000) * 100) / 100;
    const newerIncomplete = active !== null && latest !== null && active.generationId !== latest.generationId;
    const sourceState = newerIncomplete ? "partial" : selected.snapshot.state === "UNAVAILABLE" ? "failed"
      : selected.snapshot.state === "PARTIAL" ? "partial" : ageHours === null || ageHours > 48 ? "stale"
        : dashboard.inventory.workspaceCount + dashboard.inventory.fleetCount === 0 ? "empty" : "complete";
    return jsonResponse({
      schema: "sutra.finops-end-user-computing-dashboard.v1", connectionId: connection.id, sourceState,
      filters: parsed.query, dashboard, history,
      freshness: { dataThroughAt: through, ageHours, staleAfterHours: 48 },
      evidence: { generationId: selected.generationId, activeGenerationId: active?.generationId ?? null,
        latestGenerationId: latest?.generationId ?? null, contentSha256: selected.contentSha256,
        sourceCaptureId: selected.snapshot.captureId, newerIncomplete },
      collection: END_USER_COMPUTING_RUNTIME_BINDING,
      officialDefinition: END_USER_COMPUTING_OFFICIAL_DEFINITION,
      filterOptions: { services: ["WORKSPACES", "APPSTREAM"], accountIds: selected.snapshot.accountIds, regions: selected.snapshot.regions },
      privacy: { userIdentifiersStored: false, sessionIdentifiersStored: false, instanceIdentifiersStored: false, networkAddressesStored: false },
      unsupportedOfficialViews: [
        "WorkSpaces protocol and operating-system dimensions are not present in the current privacy-minimized collector contract.",
        "Per-user last logon, low usage, and never-used classifications require an approved privacy-preserving aggregate contract.",
        "The current immutable snapshot is point-in-time plus canonical CUR2 evidence; three-month daily/monthly series are not yet materialized.",
      ],
    });
  } catch (error) { return errorResponse(error); }
}
