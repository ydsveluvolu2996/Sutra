/**
 * Pure, deterministic RI / Savings-Plan COMMITMENT accounting over ingested
 * CUR/FOCUS billing lines. It answers, honestly and only from what the billing
 * file carries:
 *   1. Coverage %: committed effective spend ÷ eligible compute effective spend
 *      (committed + on-demand). Spot and unclassifiable lines are excluded from
 *      the denominator and disclosed separately — never redistributed.
 *   2. The on-demand vs committed split, broken down by commitment type.
 *   3. Effective Savings Rate (ESR): (on-demand-equivalent − actual) ÷
 *      on-demand-equivalent, derived ONLY from committed lines that carry BOTH a
 *      billed (on-demand-equivalent) figure and a separate amortized/effective
 *      figure. When no such line exists ESR is null and the reason disclosed —
 *      it is never fabricated from data that cannot support it.
 *   4. An expiry list: each distinct commitment id + expiry with days-to-expiry
 *      measured from a caller-supplied clock, sorted soonest-first.
 *
 * Evidence-honesty rules (never relaxed):
 * - Money is integer micro-units summed with BigInt; amounts are returned as
 *   both `*Micros` (string, exact) and `*Units` (number, display convenience).
 * - "Spend" per line is its amortized/effective cost when present, else its
 *   billed cost (an on-demand line's effective cost IS its unblended cost).
 * - Commitment type comes straight from the parser: FOCUS CommitmentDiscountType
 *   ("Reserved"/"SavingsPlan", case-normalized) or the CUR-inferred token
 *   ("reserved"/"savings_plan"/"spot"/"on_demand"). A null type is unclassified
 *   and is never guessed into a bucket.
 * - A SINGLE currency is analysed. When lines carry more than one currency the
 *   dominant currency (greatest billed spend, ties broken by code) is picked
 *   deterministically and ONLY its lines are aggregated.
 * - `available` is false when the file carries no commitment data at all (no
 *   committed line and no commitment id); coverage/ESR are then null.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";

export type CommitmentClass = "committed" | "on_demand" | "spot" | "unclassified";

export interface CommitmentTypeSplit {
  /** Normalized commitment type token as classified from the line. */
  readonly commitmentType: string;
  readonly class: CommitmentClass;
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
}

export interface CommitmentExpiryEntry {
  readonly commitmentId: string;
  readonly commitmentType: string | null;
  readonly expiry: string;
  /** Whole days from `nowIso` to expiry; negative when already expired; null when expiry is unparseable. */
  readonly daysToExpiry: number | null;
  readonly expired: boolean;
}

export interface EffectiveSavingsRate {
  /** Percent (0–100) savings versus on-demand-equivalent; null when not derivable. */
  readonly percent: number | null;
  readonly derivable: boolean;
  readonly onDemandEquivalentMicros: string;
  readonly onDemandEquivalentUnits: number;
  readonly actualMicros: string;
  readonly actualUnits: number;
  /** Why ESR could not be derived, when percent is null. */
  readonly note: string | null;
}

export interface CommitmentCoverage {
  readonly schema: "sutra.finops-commitments.v1";
  /** True when the file carries any commitment data (a committed line or a commitment id). */
  readonly available: boolean;
  readonly currency: string | null;
  readonly currenciesPresent: readonly string[];
  /** committed ÷ (committed + on-demand), as a percent 0–100; null when the eligible base is zero. */
  readonly coveragePercent: number | null;
  readonly committedMicros: string;
  readonly committedUnits: number;
  readonly onDemandMicros: string;
  readonly onDemandUnits: number;
  readonly eligibleMicros: string;
  readonly eligibleUnits: number;
  readonly spotMicros: string;
  readonly spotUnits: number;
  readonly unclassifiedMicros: string;
  readonly unclassifiedUnits: number;
  readonly byCommitmentType: readonly CommitmentTypeSplit[];
  readonly effectiveSavingsRate: EffectiveSavingsRate;
  readonly expirations: readonly CommitmentExpiryEntry[];
  readonly lineCount: number;
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const COMMITMENT_COVERAGE_DISCLAIMER =
  "Commitment coverage is committed effective spend divided by eligible compute " +
  "effective spend (committed + on-demand); spot and unclassifiable lines are " +
  "excluded from the base and disclosed separately, never redistributed. Spend " +
  "per line is its amortized/effective cost when present, else its billed cost. " +
  "Effective Savings Rate is derived only from committed lines that carry both a " +
  "billed on-demand-equivalent and a separate amortized figure; when none do, it " +
  "is null and the reason is disclosed — it is never fabricated. A single " +
  "currency is analysed; when several are present the dominant one (greatest " +
  "billed spend, ties broken by code) is chosen and only its lines are summed.";

const LIMITATIONS: readonly string[] = [
  "COVERAGE_IS_COMMITTED_EFFECTIVE_SPEND_OVER_COMMITTED_PLUS_ON_DEMAND_EFFECTIVE_SPEND",
  "SPEND_PER_LINE_IS_AMORTIZED_WHEN_PRESENT_ELSE_BILLED",
  "SPOT_AND_UNCLASSIFIED_LINES_ARE_EXCLUDED_FROM_THE_ELIGIBLE_BASE",
  "ESR_REQUIRES_A_BILLED_ON_DEMAND_EQUIVALENT_AND_A_SEPARATE_AMORTIZED_FIGURE_ON_COMMITTED_LINES",
  "A_SINGLE_CURRENCY_IS_ANALYSED_AND_CURRENCIES_ARE_NEVER_SUMMED_TOGETHER",
  "COMMITMENT_TYPE_IS_TAKEN_FROM_THE_BILLING_FILE_AND_A_NULL_TYPE_IS_NEVER_GUESSED",
];

const MS_PER_DAY = 86_400_000;

function unitsFromMicros(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/** Classify a parser commitment-type token into a coarse coverage class. */
export function classifyCommitmentType(commitmentType: string | null): CommitmentClass {
  if (commitmentType === null) return "unclassified";
  const normalized = commitmentType.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized === "reserved" || normalized === "reservation" || normalized === "savings_plan" || normalized === "savingsplan") {
    return "committed";
  }
  if (normalized === "on_demand" || normalized === "ondemand") return "on_demand";
  if (normalized === "spot") return "spot";
  return "unclassified";
}

/** Effective (amortized) micros for a line: its amortized figure when present, else its billed cost. */
function effectiveMicros(line: NormalizedCurLine): bigint {
  return line.amortizedMicros !== null ? BigInt(line.amortizedMicros) : BigInt(line.amountMicros);
}

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

function percentBig(part: bigint, whole: bigint): number | null {
  if (whole <= BigInt(0)) return null;
  return Number((part * BigInt(10000)) / whole) / 100;
}

interface TypeAccumulator {
  class: CommitmentClass;
  spend: bigint;
  lineCount: number;
}

/**
 * Build the commitment coverage / utilization / ESR / expiry report.
 *
 * @param lines ingested & normalized CUR/FOCUS lines for a period.
 * @param nowIso the reference clock (ISO) used for days-to-expiry — supplied by
 *               the caller (the route computes it) so this stays pure.
 */
export function buildCommitmentCoverage(lines: readonly NormalizedCurLine[], nowIso: string): CommitmentCoverage {
  const currenciesPresent = [...new Set(
    lines.map((line) => line.currency).filter((code) => /^[A-Z]{3}$/u.test(code)),
  )].sort((a, b) => a.localeCompare(b, "en-US"));
  const currency = pickCurrency(lines);
  const nowMs = Date.parse(nowIso);

  const emptyEsr: EffectiveSavingsRate = {
    percent: null,
    derivable: false,
    onDemandEquivalentMicros: "0",
    onDemandEquivalentUnits: 0,
    actualMicros: "0",
    actualUnits: 0,
    note: "No committed line carries both a billed on-demand-equivalent and a separate amortized figure.",
  };

  if (currency === null) {
    return {
      schema: "sutra.finops-commitments.v1",
      available: false,
      currency: null,
      currenciesPresent,
      coveragePercent: null,
      committedMicros: "0",
      committedUnits: 0,
      onDemandMicros: "0",
      onDemandUnits: 0,
      eligibleMicros: "0",
      eligibleUnits: 0,
      spotMicros: "0",
      spotUnits: 0,
      unclassifiedMicros: "0",
      unclassifiedUnits: 0,
      byCommitmentType: [],
      effectiveSavingsRate: emptyEsr,
      expirations: [],
      lineCount: 0,
      limitations: LIMITATIONS,
      disclaimer: COMMITMENT_COVERAGE_DISCLAIMER,
    };
  }

  let committed = BigInt(0);
  let onDemand = BigInt(0);
  let spot = BigInt(0);
  let unclassified = BigInt(0);
  let lineCount = 0;
  let hasCommitmentData = false;
  // ESR accumulators over committed lines that carry a separate amortized figure.
  let esrOnDemandEquivalent = BigInt(0);
  let esrActual = BigInt(0);
  let esrLineCount = 0;
  const byType = new Map<string, TypeAccumulator>();
  // Distinct commitment id + expiry pairs, keeping the first-seen type.
  const expiries = new Map<string, { commitmentId: string; commitmentType: string | null; expiry: string }>();

  for (const line of lines) {
    if (line.currency !== currency) continue;
    lineCount += 1;
    const spend = effectiveMicros(line);
    const klass = classifyCommitmentType(line.commitmentType);
    if (klass === "committed") committed += spend;
    else if (klass === "on_demand") onDemand += spend;
    else if (klass === "spot") spot += spend;
    else unclassified += spend;

    if (line.commitmentType !== null) {
      const key = line.commitmentType;
      const accumulator = byType.get(key) ?? { class: klass, spend: BigInt(0), lineCount: 0 };
      accumulator.spend += spend;
      accumulator.lineCount += 1;
      byType.set(key, accumulator);
    }

    if (klass === "committed" || line.commitmentId !== null) hasCommitmentData = true;

    // ESR: SP-covered/committed lines report the on-demand-equivalent as their
    // billed cost and the discounted cost as their amortized figure.
    if (klass === "committed" && line.amortizedMicros !== null) {
      esrOnDemandEquivalent += BigInt(line.amountMicros);
      esrActual += BigInt(line.amortizedMicros);
      esrLineCount += 1;
    }

    if (line.commitmentId !== null && line.commitmentExpiry !== null) {
      const key = `${line.commitmentId} ${line.commitmentExpiry}`;
      if (!expiries.has(key)) {
        expiries.set(key, { commitmentId: line.commitmentId, commitmentType: line.commitmentType, expiry: line.commitmentExpiry });
      }
    }
  }

  const eligible = committed + onDemand;
  const byCommitmentType = [...byType.entries()]
    .map(([commitmentType, accumulator]) => ({
      commitmentType,
      class: accumulator.class,
      spendMicros: accumulator.spend.toString(),
      spendUnits: unitsFromMicros(accumulator.spend),
      lineCount: accumulator.lineCount,
    }))
    .sort((a, b) => {
      const spendA = BigInt(a.spendMicros);
      const spendB = BigInt(b.spendMicros);
      if (spendA !== spendB) return spendA > spendB ? -1 : 1;
      return a.commitmentType.localeCompare(b.commitmentType, "en-US");
    });

  const esrDerivable = esrLineCount > 0 && esrOnDemandEquivalent > BigInt(0);
  const effectiveSavingsRate: EffectiveSavingsRate = {
    percent: esrDerivable ? percentBig(esrOnDemandEquivalent - esrActual, esrOnDemandEquivalent) : null,
    derivable: esrDerivable,
    onDemandEquivalentMicros: esrOnDemandEquivalent.toString(),
    onDemandEquivalentUnits: unitsFromMicros(esrOnDemandEquivalent),
    actualMicros: esrActual.toString(),
    actualUnits: unitsFromMicros(esrActual),
    note: esrDerivable
      ? null
      : "No committed line carries both a billed on-demand-equivalent and a separate amortized figure.",
  };

  const expirations = [...expiries.values()]
    .map((entry) => {
      const expiryMs = Date.parse(entry.expiry);
      const parseable = Number.isFinite(expiryMs) && Number.isFinite(nowMs);
      const daysToExpiry = parseable ? Math.floor((expiryMs - nowMs) / MS_PER_DAY) : null;
      return {
        commitmentId: entry.commitmentId,
        commitmentType: entry.commitmentType,
        expiry: entry.expiry,
        daysToExpiry,
        expired: daysToExpiry !== null && daysToExpiry < 0,
      };
    })
    .sort((a, b) => {
      const aMs = Date.parse(a.expiry);
      const bMs = Date.parse(b.expiry);
      const aValid = Number.isFinite(aMs);
      const bValid = Number.isFinite(bMs);
      // Unparseable expiries sort last, deterministically by id then expiry.
      if (aValid && bValid && aMs !== bMs) return aMs - bMs;
      if (aValid !== bValid) return aValid ? -1 : 1;
      const byId = a.commitmentId.localeCompare(b.commitmentId, "en-US");
      return byId !== 0 ? byId : a.expiry.localeCompare(b.expiry, "en-US");
    });

  return {
    schema: "sutra.finops-commitments.v1",
    available: hasCommitmentData,
    currency,
    currenciesPresent,
    coveragePercent: percentBig(committed, eligible),
    committedMicros: committed.toString(),
    committedUnits: unitsFromMicros(committed),
    onDemandMicros: onDemand.toString(),
    onDemandUnits: unitsFromMicros(onDemand),
    eligibleMicros: eligible.toString(),
    eligibleUnits: unitsFromMicros(eligible),
    spotMicros: spot.toString(),
    spotUnits: unitsFromMicros(spot),
    unclassifiedMicros: unclassified.toString(),
    unclassifiedUnits: unitsFromMicros(unclassified),
    byCommitmentType,
    effectiveSavingsRate,
    expirations,
    lineCount,
    limitations: LIMITATIONS,
    disclaimer: COMMITMENT_COVERAGE_DISCLAIMER,
  };
}
