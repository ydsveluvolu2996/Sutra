import { getConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { groupCostByRegion } from "../../../../../lib/finops-region";
import type { PilotResource } from "../../../../../lib/pilot-types";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const period = url.searchParams.get("period");
    if (!CONNECTION_ID.test(connectionId) || (period !== null && !BILLING_PERIOD.test(period))) {
      throw Object.assign(new Error("The FinOps region request is invalid"), { code: "INVALID_INPUT" });
    }
    // AUTH + tenant scoping mirrors the insights route EXACTLY: resolve the
    // connection (and therefore its customer) from the session/actor's org,
    // never from a caller-supplied customer id.
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new FinopsWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    // Region COST comes from the selected period's ingested CUR lines; it only
    // populates once a CUR carrying region columns has been uploaded.
    const periods = await repository.listPeriods(scope, connectionId);
    const selected = period ?? periods[0]?.period ?? null;
    const lines = selected === null ? [] : await repository.linesForPeriod(scope, connectionId, selected);
    // Region RESOURCE counts come from the CMDB (tenant-scoped through the
    // resolved connection) and are available immediately — region is already on
    // every CMDB resource. Obtained the same way the insights route does.
    const resources: readonly PilotResource[] =
      (await getPilotStateForOrg(authenticated.subject.orgId, connectionId)).resources;
    const byRegion = new Map<string, number>();
    for (const resource of resources) {
      byRegion.set(resource.region, (byRegion.get(resource.region) ?? 0) + 1);
    }
    const resourceRegions = [...byRegion.entries()]
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => (b.count - a.count) || a.region.localeCompare(b.region));
    return jsonResponse({
      cost: groupCostByRegion(lines),
      resources: { total: resources.length, regions: resourceRegions },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
