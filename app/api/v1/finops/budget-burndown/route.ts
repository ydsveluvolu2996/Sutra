import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { buildBudgetBurndown, BUDGET_BURNDOWN_NOTE } from "../../../../../lib/finops-budget-burndown";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;

/** Days in the calendar month named by a `YYYY-MM` period (deterministic, no wall clock). */
function daysInBillingMonth(period: string): number {
  const [year, month] = period.split("-").map(Number);
  // Date.UTC(year, month, 0) rolls to day 0 of the *next* 1-based month, i.e.
  // the last day of the target month — month here is already 1-based.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const period = url.searchParams.get("period");
    if (!CONNECTION_ID.test(connectionId) || (period !== null && !BILLING_PERIOD.test(period))) {
      throw Object.assign(new Error("The FinOps budget burn-down request is invalid"), { code: "INVALID_INPUT" });
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
        asOfDayIndex: 0,
        daysInMonth: 0,
        budgets: [],
        note: BUDGET_BURNDOWN_NOTE,
      });
    }

    const lines = await repository.linesForPeriod(scope, connectionId, selected);
    const budgets = await repository.listBudgets(scope);

    // Calendar facts are derived from the DATA and the period string, never the
    // wall clock: days-in-month from the period, and "as of" from the latest
    // usage day present in the ingested lines — so the burn-down matches the
    // billing file exactly (AWS finalizes cost with a delay).
    const daysInMonth = daysInBillingMonth(selected);
    let asOfDayIndex = 0;
    for (const line of lines) {
      if (line.usageStartIso.slice(0, 7) !== selected) continue;
      const day = Number(line.usageStartIso.slice(8, 10));
      if (Number.isInteger(day) && day > asOfDayIndex) asOfDayIndex = day;
    }

    const burndown = buildBudgetBurndown({ budgets, dailyLines: lines, period: selected, asOfDayIndex, daysInMonth });
    return jsonResponse({
      connectionId,
      periods,
      period: selected,
      asOfDayIndex,
      daysInMonth,
      budgets: burndown.budgets,
      note: burndown.note,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
