/**
 * Pure, deterministic AMORTIZED-vs-UNBLENDED cost accounting over ingested
 * CUR/FOCUS billing lines. It answers one honest question: what did this period
 * cost on a billed (unblended) basis versus an amortized (effective) basis, and
 * where the two diverge by service.
 *
 * Unblended cost front-loads commitment purchases (an upfront RI/Savings Plan
 * fee lands as a spike in its purchase month, covered usage bills $0); amortized
 * cost spreads that commitment across the term. Reconciling the two is the whole
 * point of this view.
 *
 * Evidence-honesty rules (never relaxed):
 * - Money is integer micro-units summed with BigInt; amounts are returned as
 *   both `*Micros` (string, exact) and `*Units` (number, display convenience).
 * - The billed total is the sum of every analyzed line's amountMicros. The
 *   amortized (effective) total sums each line's amortizedMicros WHEN PRESENT
 *   and falls back to its billed amountMicros otherwise (an on-demand line's
 *   effective cost IS its unblended cost). This fallback is disclosed.
 * - `available` is false when NO analyzed line carries a separate amortized
 *   figure — the effective total then merely equals billed, and the UI should
 *   say amortized cost was not in the uploaded billing file. It is never
 *   fabricated.
 * - A SINGLE currency is analysed. When lines carry more than one currency the
 *   dominant currency (greatest billed spend, ties broken by code ascending) is
 *   picked deterministically and ONLY its lines are aggregated — currencies are
 *   never summed together. The chosen code and every code present are disclosed.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";

export interface AmortizedServiceBreakdown {
  readonly service: string;
  readonly billedMicros: string;
  readonly billedUnits: number;
  readonly amortizedMicros: string;
  readonly amortizedUnits: number;
  /** amortized − billed (negative = amortized is cheaper than the billed spike). */
  readonly deltaMicros: string;
  readonly deltaUnits: number;
}

export interface AmortizedView {
  readonly schema: "sutra.finops-amortized.v1";
  /** True when at least one analyzed line carries a separate amortized figure. */
  readonly available: boolean;
  /** The single currency analysed; null when there are no aggregable lines. */
  readonly currency: string | null;
  /** Every currency present in the input, sorted; discloses what was excluded. */
  readonly currenciesPresent: readonly string[];
  readonly billedMicros: string;
  readonly billedUnits: number;
  readonly amortizedMicros: string;
  readonly amortizedUnits: number;
  readonly deltaMicros: string;
  readonly deltaUnits: number;
  readonly byService: readonly AmortizedServiceBreakdown[];
  readonly lineCount: number;
  /** Count of analyzed lines that carried a separate amortized figure. */
  readonly amortizedLineCount: number;
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const AMORTIZED_VIEW_DISCLAIMER =
  "Amortized cost spreads commitment (RI/Savings Plan) purchases across their " +
  "term; unblended (billed) cost front-loads them. The billed total sums each " +
  "line's billed cost; the amortized total uses each line's amortized/effective " +
  "cost when the billing file carries one and falls back to its billed cost " +
  "otherwise. When no line carries a separate amortized figure this view is " +
  "reported unavailable — amortized cost was not in the uploaded file and is " +
  "never fabricated. A single currency is analysed; when several are present the " +
  "dominant one (greatest billed spend, ties broken by code) is chosen and only " +
  "its lines are summed.";

const LIMITATIONS: readonly string[] = [
  "BILLED_IS_THE_SUM_OF_EACH_LINE_UNBLENDED_COST",
  "AMORTIZED_USES_THE_LINE_EFFECTIVE_COST_WHEN_PRESENT_ELSE_FALLS_BACK_TO_BILLED",
  "AVAILABLE_IS_FALSE_WHEN_NO_LINE_CARRIES_A_SEPARATE_AMORTIZED_FIGURE",
  "A_SINGLE_CURRENCY_IS_ANALYSED_AND_CURRENCIES_ARE_NEVER_SUMMED_TOGETHER",
];

function unitsFromMicros(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/**
 * Pick the currency to analyse: the one with the greatest billed spend, ties
 * broken by currency code ascending. Deterministic and never mixes currencies.
 */
function pickCurrency(lines: readonly NormalizedCurLine[]): string | null {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    if (!/^[A-Z]{3}$/u.test(line.currency)) continue;
    totals.set(line.currency, (totals.get(line.currency) ?? BigInt(0)) + BigInt(line.amountMicros));
  }
  let chosen: string | null = null;
  let best = BigInt(0);
  for (const [currency, total] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b, "en-US"))) {
    if (chosen === null || total > best) {
      chosen = currency;
      best = total;
    }
  }
  return chosen;
}

interface ServiceAccumulator {
  billed: bigint;
  amortized: bigint;
}

/** Effective (amortized) micros for a line: its amortized figure when present, else its billed cost. */
function effectiveMicros(line: NormalizedCurLine): bigint {
  return line.amortizedMicros !== null ? BigInt(line.amortizedMicros) : BigInt(line.amountMicros);
}

/**
 * Build the amortized-vs-unblended view over the given lines.
 *
 * @param lines ingested & normalized CUR/FOCUS lines for a period.
 */
export function buildAmortizedView(lines: readonly NormalizedCurLine[]): AmortizedView {
  const currenciesPresent = [...new Set(
    lines.map((line) => line.currency).filter((code) => /^[A-Z]{3}$/u.test(code)),
  )].sort((a, b) => a.localeCompare(b, "en-US"));
  const currency = pickCurrency(lines);

  if (currency === null) {
    return {
      schema: "sutra.finops-amortized.v1",
      available: false,
      currency: null,
      currenciesPresent,
      billedMicros: "0",
      billedUnits: 0,
      amortizedMicros: "0",
      amortizedUnits: 0,
      deltaMicros: "0",
      deltaUnits: 0,
      byService: [],
      lineCount: 0,
      amortizedLineCount: 0,
      limitations: LIMITATIONS,
      disclaimer: AMORTIZED_VIEW_DISCLAIMER,
    };
  }

  let billed = BigInt(0);
  let amortized = BigInt(0);
  let lineCount = 0;
  let amortizedLineCount = 0;
  const byService = new Map<string, ServiceAccumulator>();

  for (const line of lines) {
    if (line.currency !== currency) continue;
    const billedAmount = BigInt(line.amountMicros);
    const amortizedAmount = effectiveMicros(line);
    billed += billedAmount;
    amortized += amortizedAmount;
    lineCount += 1;
    if (line.amortizedMicros !== null) amortizedLineCount += 1;
    const accumulator = byService.get(line.service) ?? { billed: BigInt(0), amortized: BigInt(0) };
    accumulator.billed += billedAmount;
    accumulator.amortized += amortizedAmount;
    byService.set(line.service, accumulator);
  }

  const services = [...byService.entries()]
    .map(([service, accumulator]) => ({
      service,
      billedMicros: accumulator.billed.toString(),
      billedUnits: unitsFromMicros(accumulator.billed),
      amortizedMicros: accumulator.amortized.toString(),
      amortizedUnits: unitsFromMicros(accumulator.amortized),
      deltaMicros: (accumulator.amortized - accumulator.billed).toString(),
      deltaUnits: unitsFromMicros(accumulator.amortized - accumulator.billed),
    }))
    .sort((a, b) => {
      const billedA = BigInt(a.billedMicros);
      const billedB = BigInt(b.billedMicros);
      if (billedA !== billedB) return billedA > billedB ? -1 : 1;
      return a.service.localeCompare(b.service, "en-US");
    });

  return {
    schema: "sutra.finops-amortized.v1",
    available: amortizedLineCount > 0,
    currency,
    currenciesPresent,
    billedMicros: billed.toString(),
    billedUnits: unitsFromMicros(billed),
    amortizedMicros: amortized.toString(),
    amortizedUnits: unitsFromMicros(amortized),
    deltaMicros: (amortized - billed).toString(),
    deltaUnits: unitsFromMicros(amortized - billed),
    byService: services,
    lineCount,
    amortizedLineCount,
    limitations: LIMITATIONS,
    disclaimer: AMORTIZED_VIEW_DISCLAIMER,
  };
}
