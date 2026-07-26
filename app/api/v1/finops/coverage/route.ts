import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { buildTagCoverage } from "../../../../../lib/finops-coverage";
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
      throw Object.assign(new Error("The FinOps coverage request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new FinopsWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const periods = await repository.listPeriods(scope, connectionId);
    const selected = period ?? periods[0]?.period ?? null;
    if (selected === null) {
      return jsonResponse({
        connectionId,
        periods,
        period: null,
        coverage: buildTagCoverage([]),
      });
    }
    const lines = await repository.linesForPeriod(scope, connectionId, selected);
    return jsonResponse({
      connectionId,
      periods,
      period: selected,
      lineCount: lines.length,
      coverage: buildTagCoverage(lines),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
