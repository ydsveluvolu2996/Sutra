import { listConnectionsForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { buildShowback, type ShowbackReport } from "../../../../../lib/finops-showback";
import { buildShowbackInput } from "../../../../../lib/finops-showback-inputs";
import type { NormalizedCurLine } from "../../../../../lib/finops-cur";
import type { PilotConnection } from "../../../../../lib/pilot-types";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { authorize } from "../../../../../lib/auth-policy";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

interface PeriodEntry {
  readonly period: string;
  readonly lineCount: number;
}

/**
 * Org/MSP-level per-customer showback (and, when enabled upstream, chargeback).
 * Unlike the per-connection FinOps insights route, this aggregates ALREADY
 * persisted billing lines ACROSS every connection in the organization, grouped
 * by the customer that owns the connection.
 *
 * Tenant isolation is enforced twice: an org-level `connection:read` gate, and
 * a per-customer `connection:read` filter so a session with an
 * `assigned_customers` scope only ever sees — and only ever aggregates — the
 * customers it is entitled to read. A customer the session cannot read is never
 * included in the accountToCustomer map, the CUR reads, or the response.
 *
 * Evidence honesty is inherited from the pure engine: currencies are never
 * summed, and spend matching no readable customer is disclosed as unattributed,
 * never force-assigned.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period");
    if (period !== null && !BILLING_PERIOD.test(period)) {
      throw Object.assign(new Error("The showback request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    // Org-level gate: this role must be able to read connections at all. The
    // per-customer filter below then narrows to only the readable customers.
    assertSessionCapability(authenticated, "connection:read");
    const orgId = authenticated.subject.orgId;

    // Tenant identity is derived from the authenticated session, never the
    // caller: the org comes from the session and each customer is authorized
    // individually. Only well-formed connection ids are queried (the workspace
    // repository requires the canonical id shape).
    const connections = (await listConnectionsForOrg(orgId)).filter(
      (connection) =>
        CONNECTION_ID.test(connection.id) &&
        authorize(authenticated.subject, {
          orgId,
          capability: "connection:read",
          customerId: connection.customerId,
        }).allowed,
    );

    const repository = new FinopsWorkspaceRepository();
    const customerNameById = new Map<string, string>();
    for (const connection of connections) {
      customerNameById.set(connection.customerId, connection.customerName);
    }

    // Union the billing periods present across every readable connection. Line
    // COUNTS (not money) may be summed across connections for a period.
    const periodLineCounts = new Map<string, number>();
    await Promise.all(
      connections.map(async (connection) => {
        const scope = { orgId, customerId: connection.customerId };
        for (const entry of await repository.listPeriods(scope, connection.id)) {
          periodLineCounts.set(entry.period, (periodLineCounts.get(entry.period) ?? 0) + entry.lineCount);
        }
      }),
    );
    const periods: readonly PeriodEntry[] = [...periodLineCounts.entries()]
      .map(([billingPeriod, lineCount]) => ({ period: billingPeriod, lineCount }))
      .sort((a, b) => b.period.localeCompare(a.period, "en-US"));

    const selected = period ?? periods[0]?.period ?? null;

    // Read each readable connection's CUR lines for the selected period and
    // concatenate. Attribution maps each connection's AWS account id to its
    // owning customer; lines whose usage account is not mapped stay unattributed.
    const curLines: NormalizedCurLine[] = selected === null
      ? []
      : (
          await Promise.all(
            connections.map((connection) =>
              repository.linesForPeriod({ orgId, customerId: connection.customerId }, connection.id, selected),
            ),
          )
        ).flat();
    const accountToCustomer: Record<string, string> = {};
    for (const connection of connections) {
      accountToCustomer[connection.awsAccountId] = connection.customerId;
    }

    const report = buildShowback(buildShowbackInput({ curLines, accountToCustomer }));
    return jsonResponse(shapeShowbackResponse(report, periods, selected, connections, customerNameById));
  } catch (error) {
    return errorResponse(error);
  }
}

function shapeShowbackResponse(
  report: ShowbackReport,
  periods: readonly PeriodEntry[],
  selected: string | null,
  connections: readonly PilotConnection[],
  customerNameById: ReadonlyMap<string, string>,
): unknown {
  const distinctCustomers = new Set<string>();
  for (const currencyResult of report.results) {
    for (const bucket of currencyResult.customers) distinctCustomers.add(bucket.customerId);
  }
  const results = report.results.map((currencyResult) => ({
    currency: currencyResult.currency,
    customers: currencyResult.customers.map((bucket) => ({
      customerId: bucket.customerId,
      // Join the human-readable name resolved from the org's connections.
      customerName: customerNameById.get(bucket.customerId) ?? bucket.customerId,
      directMicros: bucket.directMicros,
      attributionBases: bucket.attributionBases,
      lineCount: bucket.lineCount,
      distributedSharedMicros: bucket.distributedSharedMicros,
      upliftMicros: bucket.upliftMicros,
      chargebackTotalMicros: bucket.chargebackTotalMicros,
    })),
    unattributedMicros: currencyResult.unattributedMicros,
    unattributedLineCount: currencyResult.unattributedLineCount,
    totalMicros: currencyResult.totalMicros,
    chargeback: currencyResult.chargeback,
  }));
  return {
    schema: report.schema,
    period: selected,
    periods,
    connectionCount: connections.length,
    customerCount: distinctCustomers.size,
    results,
    chargebackEnabled: report.chargebackEnabled,
    options: report.options,
    limitations: report.limitations,
    disclaimer: report.disclaimer,
  };
}
