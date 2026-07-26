import { listConnectionsForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { FinopsExternalCostRepository } from "../../../../../db/finops-external-cost-repository";
import { CustomerMarginRepository } from "../../../../../db/customer-margin-repository";
import { buildShowback } from "../../../../../lib/finops-showback";
import { buildShowbackInput } from "../../../../../lib/finops-showback-inputs";
import { applyMargin, type CustomerCost, type MarginRate } from "../../../../../lib/finops-margin";
import type { NormalizedCurLine } from "../../../../../lib/finops-cur";
import { EXTERNAL_COST_DISCLAIMER } from "../../../../../lib/finops-external-cost";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { authorize } from "../../../../../lib/auth-policy";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MICROS = /^\d{1,24}$/u;

function badRequest(): never {
  throw Object.assign(new Error("The margin request is invalid"), { code: "INVALID_INPUT" });
}

/**
 * Org/MSP-level per-customer margin: underlying cloud cost (from the showback
 * engine, aggregated across every readable connection) turned into the
 * billed-to-customer amount and margin using the configured per-customer rates.
 * Tenant isolation matches the showback route: org-level `connection:read`
 * gate + a per-customer readability filter. Currencies are never summed.
 *
 * Operator-asserted EXTERNAL costs (licences, support, third-party SaaS, the
 * MSP's own fee) can be folded into the cost base with `?includeExternal=1`.
 * That is strictly OPT-IN and always broken out: every row reports
 * cloudCostMicros and externalCostMicros beside the combined costMicros, and
 * `includesExternalCosts` states which basis the margin was computed on — a
 * margin number that silently changed meaning would be worse than an incomplete
 * one. Without the flag the response is byte-for-byte the cloud-only answer.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period");
    if (period !== null && !BILLING_PERIOD.test(period)) badRequest();
    const includeExternalRaw = url.searchParams.get("includeExternal");
    if (includeExternalRaw !== null && includeExternalRaw !== "1" && includeExternalRaw !== "0") badRequest();
    const includeExternal = includeExternalRaw === "1";
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:read");
    const orgId = authenticated.subject.orgId;

    const connections = (await listConnectionsForOrg(orgId)).filter(
      (connection) =>
        CONNECTION_ID.test(connection.id) &&
        authorize(authenticated.subject, { orgId, capability: "connection:read", customerId: connection.customerId }).allowed,
    );
    const customerNameById = new Map<string, string>();
    for (const connection of connections) customerNameById.set(connection.customerId, connection.customerName);

    const repository = new FinopsWorkspaceRepository();
    const periodLineCounts = new Map<string, number>();
    await Promise.all(
      connections.map(async (connection) => {
        const scope = { orgId, customerId: connection.customerId };
        for (const entry of await repository.listPeriods(scope, connection.id)) {
          periodLineCounts.set(entry.period, (periodLineCounts.get(entry.period) ?? 0) + entry.lineCount);
        }
      }),
    );
    const periods = [...periodLineCounts.entries()]
      .map(([billingPeriod, lineCount]) => ({ period: billingPeriod, lineCount }))
      .sort((a, b) => b.period.localeCompare(a.period, "en-US"));
    const selected = period ?? periods[0]?.period ?? null;

    const curLines: NormalizedCurLine[] = selected === null
      ? []
      : (
          await Promise.all(
            connections.map((connection) => repository.linesForPeriod({ orgId, customerId: connection.customerId }, connection.id, selected)),
          )
        ).flat();
    const accountToCustomer: Record<string, string> = {};
    for (const connection of connections) accountToCustomer[connection.awsAccountId] = connection.customerId;

    const showback = buildShowback(buildShowbackInput({ curLines, accountToCustomer }));
    // Underlying cloud cost per (customer, currency): direct spend plus the
    // shared spend the engine distributed to them, before any chargeback uplift.
    const customerCosts: CustomerCost[] = [];
    for (const currencyResult of showback.results) {
      for (const bucket of currencyResult.customers) {
        const shared = bucket.distributedSharedMicros ?? "0";
        const cost = (BigInt(bucket.directMicros) + BigInt(shared)).toString();
        customerCosts.push({ customerId: bucket.customerId, currency: currencyResult.currency, costMicros: cost });
      }
    }

    // External cost is an ADDITIONAL, clearly-labelled component of the cost
    // base, read only when the caller opted in. Per-record customer attribution
    // wins inside the repository; otherwise the cost belongs to the customer the
    // connection belongs to. A customer we cannot read is dropped, not guessed.
    const readableCustomers = new Set(connections.map((connection) => connection.customerId));
    const externalCosts: CustomerCost[] = [];
    let externalRecordCount = 0;
    if (includeExternal && selected !== null) {
      const externalRepository = new FinopsExternalCostRepository();
      const perConnection = await Promise.all(
        connections.map((connection) => externalRepository.customerTotalsForPeriod(
          { orgId, customerId: connection.customerId },
          connection.id,
          selected,
        )),
      );
      for (const totals of perConnection) {
        for (const total of totals) {
          if (!readableCustomers.has(total.customerId)) continue;
          externalCosts.push({ customerId: total.customerId, currency: total.currency, costMicros: total.amountMicros });
          externalRecordCount += total.recordCount;
        }
      }
    }

    const rates: readonly MarginRate[] = (await new CustomerMarginRepository().list(orgId)).map((rate) => ({
      customerId: rate.customerId,
      markupPercent: rate.markupPercent,
      monthlyFeeMicros: rate.monthlyFeeMicros,
      currency: rate.currency,
    }));
    const margin = applyMargin(customerCosts, rates, externalCosts);
    return jsonResponse({
      period: selected,
      periods,
      connectionCount: connections.length,
      rows: margin.rows.map((row) => ({ ...row, customerName: customerNameById.get(row.customerId) ?? row.customerId })),
      totalsByCurrency: margin.totalsByCurrency,
      rateCount: rates.length,
      // The basis of this margin, stated explicitly rather than implied.
      externalCostsRequested: includeExternal,
      includesExternalCosts: margin.includesExternalCosts,
      externalRecordCount,
      costBasis: margin.includesExternalCosts ? "cloud+external" : "cloud-only",
      externalCostDisclaimer: margin.includesExternalCosts ? EXTERNAL_COST_DISCLAIMER : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) badRequest();
    const { customerId, markupPercent, monthlyFeeMicros, currency } = body as {
      customerId?: unknown; markupPercent?: unknown; monthlyFeeMicros?: unknown; currency?: unknown;
    };
    if (
      typeof customerId !== "string" || !IDENTIFIER.test(customerId) ||
      typeof markupPercent !== "number" ||
      typeof monthlyFeeMicros !== "string" || !MICROS.test(monthlyFeeMicros) ||
      typeof currency !== "string" || !CURRENCY.test(currency)
    ) badRequest();
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:manage", customerId);
    const saved = await new CustomerMarginRepository().upsert(
      { orgId: authenticated.subject.orgId, customerId },
      { customerId, markupPercent, monthlyFeeMicros, currency },
    );
    return jsonResponse({ saved, rates: await new CustomerMarginRepository().list(authenticated.subject.orgId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId") ?? "";
    if (!IDENTIFIER.test(customerId)) badRequest();
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:manage", customerId);
    const deleted = await new CustomerMarginRepository().delete({ orgId: authenticated.subject.orgId, customerId });
    return jsonResponse({ deleted, rates: await new CustomerMarginRepository().list(authenticated.subject.orgId) });
  } catch (error) {
    return errorResponse(error);
  }
}
