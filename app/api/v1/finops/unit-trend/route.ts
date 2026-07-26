import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { FinopsUnitCountRepository } from "../../../../../db/finops-unit-count-repository";
import { buildUnitCostTrend } from "../../../../../lib/finops-unit-trend";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    if (!CONNECTION_ID.test(connectionId)) {
      throw Object.assign(new Error("The FinOps unit-trend request is invalid"), { code: "INVALID_INPUT" });
    }
    // AUTH + tenant scoping mirror app/api/v1/finops/insights/route.ts exactly:
    // authenticate the session, resolve the connection within the caller's org,
    // then assert the connection:read capability against the resolved customer.
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new FinopsWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };

    // Every persisted billing period's CUR lines for this connection, reused
    // exactly like the insights path (listPeriods + linesForPeriod). The trend
    // is inherently multi-period, so it reads them all.
    const periods = await repository.listPeriods(scope, connectionId);
    const perPeriodLines = await Promise.all(
      periods.map(async (entry) => ({
        period: entry.period,
        lines: await repository.linesForPeriod(scope, connectionId, entry.period),
      })),
    );

    // Unit counts are not currency-specific, so the trend is anchored to a
    // SINGLE currency: the one with the greatest total spend across all periods
    // (deterministic alphabetical tie-break). Cross-currency totals are never
    // summed together.
    const currencyTotals = new Map<string, bigint>();
    for (const { lines } of perPeriodLines) {
      for (const line of lines) {
        if (!CURRENCY_RE.test(line.currency)) continue;
        currencyTotals.set(line.currency, (currencyTotals.get(line.currency) ?? BigInt(0)) + BigInt(line.amountMicros));
      }
    }
    const currency =
      [...currencyTotals.entries()]
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0], "en-US")))
        .map(([code]) => code)[0] ?? null;

    // Total cost per period for the selected currency (integer micros, BigInt).
    const periodsCost =
      currency === null
        ? []
        : perPeriodLines.map(({ period, lines }) => {
            let sum = BigInt(0);
            for (const line of lines) if (line.currency === currency) sum += BigInt(line.amountMicros);
            return { period, amountMicros: sum.toString() };
          });

    // Operator-provided per-period unit counts across ALL periods for the tenant.
    const unitCounts = await new FinopsUnitCountRepository().list(scope);

    const report = buildUnitCostTrend({ periodsCost, unitCounts });
    const metrics = report.metrics.map((metric) => ({ ...metric, currency }));

    return jsonResponse({
      connectionId,
      currency,
      periods,
      metrics,
      note: report.disclaimer,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
