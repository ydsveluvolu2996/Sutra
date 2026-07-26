/**
 * MSP margin: turn a customer's underlying cloud COST into the amount billed to
 * that customer, and expose the margin. Sutra is sold to MSPs who resell AWS —
 * "what did it cost me vs what do I charge them" is the number they live on, and
 * no mainstream FinOps tool answers it directly.
 *
 * Model (deliberately simple and auditable):
 *   billed = cost + markup(cost, markupPercent) + fixed monthly fee
 *   margin = billed − cost
 * Honesty rules mirror the rest of FinOps:
 *   - Money is bigint micro-units; the only float is the percentage markup,
 *     which is rounded to whole micro-units immediately.
 *   - Currencies are NEVER summed. Cost is grouped per (customer, currency); a
 *     fixed fee is only added when the rate's currency matches the cost's.
 *   - A customer with no configured rate is still listed (markup 0, fee 0,
 *     margin 0) — never hidden.
 */

export interface CustomerCost {
  readonly customerId: string;
  readonly currency: string;
  readonly costMicros: string; // bigint-safe decimal string
}

export interface MarginRate {
  readonly customerId: string;
  readonly markupPercent: number; // e.g. 20 == +20%
  readonly monthlyFeeMicros: string; // bigint-safe decimal string, in `currency`
  readonly currency: string;
}

export interface MarginRow {
  readonly customerId: string;
  readonly currency: string;
  readonly costMicros: string;
  readonly costUnits: number;
  readonly markupPercent: number;
  readonly monthlyFeeMicros: string; // fee actually applied (0 when the rate currency differs)
  readonly billedMicros: string;
  readonly billedUnits: number;
  readonly marginMicros: string;
  readonly marginUnits: number;
  readonly marginPercent: number | null; // null when billed is 0
  readonly hasRate: boolean;
}

export interface MarginCurrencyTotal {
  readonly currency: string;
  readonly totalCostMicros: string;
  readonly totalCostUnits: number;
  readonly totalBilledMicros: string;
  readonly totalBilledUnits: number;
  readonly totalMarginMicros: string;
  readonly totalMarginUnits: number;
  readonly blendedMarginPercent: number | null;
}

export interface MarginResult {
  readonly rows: readonly MarginRow[];
  readonly totalsByCurrency: readonly MarginCurrencyTotal[];
}

function toUnits(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return BigInt(0);
  }
}

/** Whole-micro markup for a cost. The percentage is the only fractional input. */
function markupMicros(costMicros: bigint, markupPercent: number): bigint {
  if (!Number.isFinite(markupPercent) || markupPercent === 0) return BigInt(0);
  // Number() is exact for costs below 2^53 micro-units (~$9e9); MSP monthly
  // per-customer bills sit far below that. Round to the nearest whole micro.
  return BigInt(Math.round(Number(costMicros) * (markupPercent / 100)));
}

/**
 * Apply configured margin rates to per-(customer, currency) cloud costs.
 * Deterministic: rows are emitted sorted by (currency, customerId), totals by
 * currency. Every cost row appears exactly once whether or not a rate exists.
 */
export function applyMargin(
  customerCosts: readonly CustomerCost[],
  rates: readonly MarginRate[],
): MarginResult {
  const rateByCustomer = new Map<string, MarginRate>();
  for (const rate of rates) rateByCustomer.set(rate.customerId, rate);

  const rows: MarginRow[] = customerCosts
    .map((cost): MarginRow => {
      const costMicros = safeBigInt(cost.costMicros);
      const rate = rateByCustomer.get(cost.customerId);
      const markupPercent = rate?.markupPercent ?? 0;
      // A fixed fee is currency-specific: only add it when the rate is quoted in
      // the same currency as this cost, so currencies are never conflated.
      const feeApplied = rate !== undefined && rate.currency === cost.currency
        ? safeBigInt(rate.monthlyFeeMicros)
        : BigInt(0);
      const billed = costMicros + markupMicros(costMicros, markupPercent) + feeApplied;
      const margin = billed - costMicros;
      return {
        customerId: cost.customerId,
        currency: cost.currency,
        costMicros: costMicros.toString(),
        costUnits: toUnits(costMicros),
        markupPercent,
        monthlyFeeMicros: feeApplied.toString(),
        billedMicros: billed.toString(),
        billedUnits: toUnits(billed),
        marginMicros: margin.toString(),
        marginUnits: toUnits(margin),
        marginPercent: billed > BigInt(0) ? (Number(margin) / Number(billed)) * 100 : null,
        hasRate: rate !== undefined,
      };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency, "en-US") || a.customerId.localeCompare(b.customerId, "en-US"));

  const totalsMap = new Map<string, { cost: bigint; billed: bigint; margin: bigint }>();
  for (const row of rows) {
    const entry = totalsMap.get(row.currency) ?? { cost: BigInt(0), billed: BigInt(0), margin: BigInt(0) };
    entry.cost += BigInt(row.costMicros);
    entry.billed += BigInt(row.billedMicros);
    entry.margin += BigInt(row.marginMicros);
    totalsMap.set(row.currency, entry);
  }
  const totalsByCurrency: MarginCurrencyTotal[] = [...totalsMap.entries()]
    .map(([currency, entry]) => ({
      currency,
      totalCostMicros: entry.cost.toString(),
      totalCostUnits: toUnits(entry.cost),
      totalBilledMicros: entry.billed.toString(),
      totalBilledUnits: toUnits(entry.billed),
      totalMarginMicros: entry.margin.toString(),
      totalMarginUnits: toUnits(entry.margin),
      blendedMarginPercent: entry.billed > BigInt(0) ? (Number(entry.margin) / Number(entry.billed)) * 100 : null,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency, "en-US"));

  return { rows, totalsByCurrency };
}
