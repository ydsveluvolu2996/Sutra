import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { buildDailyCost } from "../../../../../lib/finops-daily";
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
      throw Object.assign(new Error("The FinOps daily-cost request is invalid"), { code: "INVALID_INPUT" });
    }
    // Auth + tenant scoping mirror app/api/v1/finops/insights/route.ts exactly:
    // the connection (and therefore the customer) is resolved from the actor's
    // session, never taken from the caller, and gated by the same capability.
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new FinopsWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const periods = await repository.listPeriods(scope, connectionId);
    // Default to the latest ingested period, exactly like insights does.
    const selected = period ?? periods[0]?.period ?? null;
    if (selected === null) {
      return jsonResponse({
        connectionId,
        periods,
        period: null,
        ...buildDailyCost([], ""),
      });
    }
    const lines = await repository.linesForPeriod(scope, connectionId, selected);
    // Currency is carried, never assumed: report the sole currency present in
    // the period's lines, or empty when there is nothing to report.
    const currencies = [...new Set(lines.map((line) => line.currency))].filter((code) => /^[A-Z]{3}$/u.test(code));
    const currency = currencies.length === 1 ? currencies[0] : "";
    return jsonResponse({
      connectionId,
      periods,
      period: selected,
      lineCount: lines.length,
      ...buildDailyCost(lines, currency),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
