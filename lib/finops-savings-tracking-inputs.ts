/**
 * Adapter: map ALREADY-persisted CUR/FOCUS line items into the pure
 * savings-tracking engine input. Each line is bucketed into its calendar-month
 * billing period (UTC), grouped per currency, classified by charge category
 * (commitment-covered usage / on-demand usage / commitment fee), and summed in
 * integer micro-units.
 *
 * The on-demand-equivalent (public) cost and the amortized/effective cost are
 * carried ONLY when the billing line provides them (optional fields). The
 * normalized CUR line shape does not carry these columns; when they are absent
 * the adapter leaves the on-demand-equivalent null, and the engine then reports
 * the period's saving as not-derivable rather than inventing one.
 *
 * Honesty is preserved end-to-end: a line whose period/currency/amount is not
 * usable is dropped AND disclosed in `skipped`, never repaired. No I/O, pure.
 */
import type { SavingsPeriodBucket, SavingsTrackingInput } from "./finops-savings-tracking.ts";

/**
 * Minimal amortized CUR line shape. A plain NormalizedCurLine is assignable
 * (it carries the required fields); the optional commitment columns are what a
 * true amortized CUR/FOCUS export additionally provides.
 */
export interface AmortizedCurLine {
  readonly usageStartIso: string;
  readonly service: string;
  readonly chargeCategory: string;
  /** Amortized/effective cost incurred (unblended for on-demand usage). */
  readonly amountMicros: string;
  readonly currency: string;
  /** Public on-demand-equivalent cost of covered usage; absent when not in the data. */
  readonly publicOnDemandCostMicros?: string | null;
  /**
   * Explicit amortized/effective cost of covered usage when the export separates
   * it from `amountMicros`; falls back to `amountMicros` when absent.
   */
  readonly amortizedCostMicros?: string | null;
}

export interface SavingsTrackingAdapterInput {
  readonly curLines: readonly AmortizedCurLine[];
}

const MICROS_INT = /^-?\d+$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;
const PERIOD_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

const COVERED_CATEGORIES = new Set(["discountedusage", "savingsplancoveredusage"]);
const FEE_CATEGORIES = new Set(["rifee", "savingsplanrecurringfee"]);

type LineClass = "covered" | "on-demand" | "commitment-fee" | "other";

function classify(chargeCategory: string): LineClass {
  const normalized = chargeCategory.trim().toLowerCase();
  if (COVERED_CATEGORIES.has(normalized)) return "covered";
  if (normalized === "usage") return "on-demand";
  if (FEE_CATEGORIES.has(normalized)) return "commitment-fee";
  return "other";
}

function periodOf(usageStartIso: string): string | null {
  if (usageStartIso.length < 7) return null;
  const candidate = usageStartIso.slice(0, 7);
  return PERIOD_RE.test(candidate) ? candidate : null;
}

interface Accumulator {
  period: string;
  currency: string;
  coveredAmortized: bigint;
  coveredOnDemandEquiv: bigint | null;
  onDemandUsage: bigint;
  commitmentFee: bigint;
  coveredLineCount: number;
  onDemandLineCount: number;
}

export function buildSavingsTrackingInput({ curLines }: SavingsTrackingAdapterInput): SavingsTrackingInput {
  const byKey = new Map<string, Accumulator>();
  const skipped: { reason: string }[] = [];

  for (const line of curLines) {
    const period = periodOf(line.usageStartIso);
    if (period === null) {
      skipped.push({ reason: "usage start date has no parseable calendar month" });
      continue;
    }
    if (!CURRENCY_RE.test(line.currency)) {
      skipped.push({ reason: "currency is missing or not a 3-letter code" });
      continue;
    }
    if (!MICROS_INT.test(line.amountMicros)) {
      skipped.push({ reason: "amount is not an integer micro-unit value" });
      continue;
    }

    const kind = classify(line.chargeCategory);
    if (kind === "other") {
      // Credits, tax, refunds, negations: not part of a realized commitment saving.
      skipped.push({ reason: `charge category '${line.chargeCategory.trim().slice(0, 32)}' is not usage or a commitment fee` });
      continue;
    }

    const key = `${line.currency} ${period}`;
    const acc = byKey.get(key) ?? {
      period,
      currency: line.currency,
      coveredAmortized: BigInt(0),
      coveredOnDemandEquiv: null,
      onDemandUsage: BigInt(0),
      commitmentFee: BigInt(0),
      coveredLineCount: 0,
      onDemandLineCount: 0,
    };

    const amount = BigInt(line.amountMicros);
    if (kind === "covered") {
      const amortized =
        typeof line.amortizedCostMicros === "string" && MICROS_INT.test(line.amortizedCostMicros)
          ? BigInt(line.amortizedCostMicros)
          : amount;
      acc.coveredAmortized += amortized;
      acc.coveredLineCount += 1;
      if (typeof line.publicOnDemandCostMicros === "string" && MICROS_INT.test(line.publicOnDemandCostMicros)) {
        acc.coveredOnDemandEquiv = (acc.coveredOnDemandEquiv ?? BigInt(0)) + BigInt(line.publicOnDemandCostMicros);
      }
    } else if (kind === "on-demand") {
      acc.onDemandUsage += amount;
      acc.onDemandLineCount += 1;
    } else {
      acc.commitmentFee += amount;
    }

    byKey.set(key, acc);
  }

  const buckets: SavingsPeriodBucket[] = [...byKey.values()]
    .sort(
      (a, b) =>
        a.currency.localeCompare(b.currency, "en-US") || a.period.localeCompare(b.period, "en-US"),
    )
    .map((acc) => ({
      period: acc.period,
      currency: acc.currency,
      coveredAmortizedMicros: acc.coveredAmortized.toString(),
      coveredOnDemandEquivalentMicros: acc.coveredOnDemandEquiv === null ? null : acc.coveredOnDemandEquiv.toString(),
      onDemandUsageMicros: acc.onDemandUsage.toString(),
      commitmentFeeMicros: acc.commitmentFee.toString(),
      coveredLineCount: acc.coveredLineCount,
      onDemandLineCount: acc.onDemandLineCount,
    }));

  return { buckets, skipped };
}
