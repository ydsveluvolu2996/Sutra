import { getConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { detectResourceWaste } from "../../../../../lib/finops-waste";
import type { PilotResource } from "../../../../../lib/pilot-types";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
// Optional snapshot cleanup threshold (days); 1..3650. Defaults to 90 when absent.
const THRESHOLD_DAYS = /^([1-9]\d{0,3})$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const thresholdParam = url.searchParams.get("thresholdDays");
    if (
      !CONNECTION_ID.test(connectionId) ||
      (thresholdParam !== null && (!THRESHOLD_DAYS.test(thresholdParam) || Number(thresholdParam) > 3650))
    ) {
      throw Object.assign(new Error("The FinOps waste request is invalid"), { code: "INVALID_INPUT" });
    }
    // Auth + tenant scoping mirror app/api/v1/finops/insights/route.ts exactly:
    // authenticate the session, resolve the connection WITHIN the caller's org,
    // then assert connection:read for the connection's customer before reading
    // any resources. Resources come from the same tenant-scoped source.
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const resources: readonly PilotResource[] =
      (await getPilotStateForOrg(authenticated.subject.orgId, connectionId)).resources;

    // The snapshot age reference ("now") and the threshold are computed in the
    // ROUTE and passed into the pure engine, which never reads a clock.
    const thresholdDays = thresholdParam === null ? 90 : Number(thresholdParam);
    const report = detectResourceWaste(resources, { now: new Date(), thresholdDays });

    const summary = report.groups.map((group) => ({
      wasteKind: group.wasteKind,
      count: group.count,
      estimatedMonthlyUsd: group.estimatedMonthlyUsd,
    }));
    return jsonResponse({
      connectionId,
      thresholdDays: report.thresholdDays,
      summary,
      findings: report.findings,
      totalEstimatedMonthlyUsd: report.totalEstimatedMonthlyUsd,
      note:
        "Estimates are conservative USD list-price approximations applied to collected sizing/type " +
        "attributes, not billed cost; items without a collected sizing attribute report a null estimate. " +
        report.disclaimer,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
