import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { AllocationRuleRepository } from "../../../../../db/allocation-rules-repository";
import { applyAllocationRules } from "../../../../../lib/finops-allocation-rules";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;

/**
 * Apply the tenant's enabled allocation rules to a billing period's CUR lines
 * and return the per-target breakdown plus the explicit unallocated bucket. A
 * connection with no ingested billing file yields an honest empty result.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const period = url.searchParams.get("period");
    if (!CONNECTION_ID.test(connectionId) || (period !== null && !BILLING_PERIOD.test(period))) {
      throw Object.assign(new Error("The allocation request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const workspace = new FinopsWorkspaceRepository();
    const periods = await workspace.listPeriods(scope, connectionId);
    const selected = period ?? periods[0]?.period ?? null;
    const rules = await new AllocationRuleRepository().list(scope);
    if (selected === null) {
      return jsonResponse({
        connectionId,
        periods,
        period: null,
        ruleCount: rules.filter((rule) => rule.enabled).length,
        allocation: applyAllocationRules([], rules),
      });
    }
    const lines = await workspace.linesForPeriod(scope, connectionId, selected);
    return jsonResponse({
      connectionId,
      periods,
      period: selected,
      lineCount: lines.length,
      allocation: applyAllocationRules(lines, rules),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
