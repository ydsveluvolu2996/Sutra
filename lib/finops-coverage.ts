/**
 * Pure, deterministic tag-coverage / unallocated-spend accounting over
 * ingested CUR/FOCUS billing lines. It answers one honest question: how much
 * of the ingested spend carries cost-allocation tags, and WHERE the untagged
 * spend lives.
 *
 * What it reports:
 *   1. Overall: total spend, tagged spend (lines carrying >=1 non-empty tag of
 *      ANY key), untagged spend (lines carrying NO non-empty tag), and the
 *      tagged share as `taggedPercent`.
 *   2. Per configured allocation tag key (e.g. env / team / owner / cost-center
 *      / customer): spend that HAS a non-empty value for that key vs spend that
 *      is MISSING it, as `coveragePercent` per key.
 *   3. "Biggest unallocated": the top-N services and top-N accounts by UNTAGGED
 *      spend, so an operator sees where the un-attributed cost concentrates.
 *
 * Evidence-honesty rules (never relaxed):
 * - Money is integer micro-units summed with BigInt; amounts are returned as
 *   both `*Micros` (string, exact) and `*Units` (number, display convenience).
 * - A SINGLE currency is analysed. When lines carry more than one currency the
 *   dominant currency (greatest total spend, ties broken by code ascending) is
 *   picked deterministically and ONLY its lines are aggregated — currencies are
 *   never summed together. The chosen code and every code present are disclosed.
 * - Tag-key matching is case-insensitive; a tag counts as present only when its
 *   value is a non-empty string. "Untagged" is a coverage statement about the
 *   line's own tags, not proof of an untracked cost.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";

export const DEFAULT_ALLOCATION_TAG_KEYS: readonly string[] = [
  "env",
  "team",
  "owner",
  "cost-center",
  "customer",
];

export const DEFAULT_UNALLOCATED_TOP_N = 5;

export interface TagKeyCoverage {
  readonly key: string;
  /** Spend on lines that carry a non-empty value for this key. */
  readonly coveredMicros: string;
  readonly coveredUnits: number;
  /** Spend on lines missing (empty/absent) a value for this key. */
  readonly missingMicros: string;
  readonly missingUnits: number;
  readonly coveragePercent: number | null;
  readonly coveredLineCount: number;
  readonly missingLineCount: number;
}

export interface UnallocatedGroup {
  /** Group label: a service name or an account id, per the ranking. */
  readonly key: string;
  readonly untaggedMicros: string;
  readonly untaggedUnits: number;
  readonly lineCount: number;
}

export interface TagCoverageOverall {
  readonly totalMicros: string;
  readonly totalUnits: number;
  readonly taggedMicros: string;
  readonly taggedUnits: number;
  readonly untaggedMicros: string;
  readonly untaggedUnits: number;
  readonly taggedPercent: number | null;
  readonly lineCount: number;
  readonly taggedLineCount: number;
  readonly untaggedLineCount: number;
}

export interface TagCoverageReport {
  readonly schema: "sutra.finops-tag-coverage.v1";
  /** The single currency analysed; null when there are no aggregable lines. */
  readonly currency: string | null;
  /** Every currency present in the input, sorted; discloses what was excluded. */
  readonly currenciesPresent: readonly string[];
  readonly allocationTagKeys: readonly string[];
  readonly overall: TagCoverageOverall;
  readonly perTagKey: readonly TagKeyCoverage[];
  readonly biggestUnallocated: {
    readonly services: readonly UnallocatedGroup[];
    readonly accounts: readonly UnallocatedGroup[];
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const TAG_COVERAGE_DISCLAIMER =
  "Tag coverage measures how much ingested CUR/FOCUS spend carries " +
  "cost-allocation tags. 'Tagged' means a billing line carries at least one " +
  "non-empty tag; per-key coverage means the line carries a non-empty value for " +
  "that specific allocation key. 'Untagged' is a coverage statement about the " +
  "line's own tags, not proof of an untracked cost. A single currency is " +
  "analysed — when several are present the dominant one (greatest total spend, " +
  "ties broken by code) is chosen and only its lines are summed; currencies are " +
  "never mixed. Tag-key matching is case-insensitive.";

const LIMITATIONS: readonly string[] = [
  "TAGGED_MEANS_THE_BILLING_LINE_CARRIES_AT_LEAST_ONE_NON_EMPTY_TAG_OF_ANY_KEY",
  "PER_KEY_COVERAGE_COUNTS_A_LINE_ONLY_WHEN_IT_HAS_A_NON_EMPTY_VALUE_FOR_THAT_KEY",
  "A_SINGLE_CURRENCY_IS_ANALYSED_AND_CURRENCIES_ARE_NEVER_SUMMED_TOGETHER",
  "TAG_KEY_MATCHING_IS_CASE_INSENSITIVE",
  "UNTAGGED_IS_A_COVERAGE_STATEMENT_NOT_PROOF_OF_AN_UNTRACKED_COST",
];

function unitsFromMicros(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

function percentBig(part: bigint, whole: bigint): number | null {
  if (whole <= BigInt(0)) return null;
  return Number((part * BigInt(10000)) / whole) / 100;
}

/** True when the line carries at least one tag with a non-empty value. */
function hasAnyTag(tags: Readonly<Record<string, string>>): boolean {
  for (const value of Object.values(tags)) {
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

/** Case-insensitive lookup: true when `key` has a non-empty value on the line. */
function hasTagKey(tags: Readonly<Record<string, string>>, key: string): boolean {
  const wanted = key.toLowerCase();
  for (const [tagKey, value] of Object.entries(tags)) {
    if (tagKey.toLowerCase() === wanted && typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

function normalizeTagKeys(keys: readonly string[] | undefined): readonly string[] {
  const source = keys !== undefined && keys.length > 0 ? keys : DEFAULT_ALLOCATION_TAG_KEYS;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of source) {
    if (typeof key !== "string" || key.length === 0) continue;
    const lower = key.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(key);
  }
  return result.length > 0 ? result : DEFAULT_ALLOCATION_TAG_KEYS;
}

/**
 * Pick the currency to analyse: the one with the greatest total spend, ties
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

interface GroupAccumulator {
  untagged: bigint;
  lineCount: number;
}

function rankUnallocated(
  groups: Map<string, GroupAccumulator>,
  topN: number,
): UnallocatedGroup[] {
  return [...groups.entries()]
    .filter(([, group]) => group.untagged > BigInt(0))
    .sort(([keyA, a], [keyB, b]) => {
      if (a.untagged !== b.untagged) return a.untagged > b.untagged ? -1 : 1;
      return keyA.localeCompare(keyB, "en-US");
    })
    .slice(0, Math.max(0, topN))
    .map(([key, group]) => ({
      key,
      untaggedMicros: group.untagged.toString(),
      untaggedUnits: unitsFromMicros(group.untagged),
      lineCount: group.lineCount,
    }));
}

/**
 * Build the tag-coverage / unallocated-spend report over the given lines.
 *
 * @param lines   ingested & normalized CUR/FOCUS lines for a period.
 * @param tagKeys configured allocation tag keys; defaults to
 *                DEFAULT_ALLOCATION_TAG_KEYS when omitted or empty.
 * @param topN    how many services/accounts to rank in `biggestUnallocated`.
 */
export function buildTagCoverage(
  lines: readonly NormalizedCurLine[],
  tagKeys?: readonly string[],
  topN: number = DEFAULT_UNALLOCATED_TOP_N,
): TagCoverageReport {
  const allocationTagKeys = normalizeTagKeys(tagKeys);
  const currenciesPresent = [...new Set(
    lines.map((line) => line.currency).filter((code) => /^[A-Z]{3}$/u.test(code)),
  )].sort((a, b) => a.localeCompare(b, "en-US"));
  const currency = pickCurrency(lines);

  const emptyOverall: TagCoverageOverall = {
    totalMicros: "0",
    totalUnits: 0,
    taggedMicros: "0",
    taggedUnits: 0,
    untaggedMicros: "0",
    untaggedUnits: 0,
    taggedPercent: null,
    lineCount: 0,
    taggedLineCount: 0,
    untaggedLineCount: 0,
  };

  if (currency === null) {
    return {
      schema: "sutra.finops-tag-coverage.v1",
      currency: null,
      currenciesPresent,
      allocationTagKeys,
      overall: emptyOverall,
      perTagKey: allocationTagKeys.map((key) => ({
        key,
        coveredMicros: "0",
        coveredUnits: 0,
        missingMicros: "0",
        missingUnits: 0,
        coveragePercent: null,
        coveredLineCount: 0,
        missingLineCount: 0,
      })),
      biggestUnallocated: { services: [], accounts: [] },
      limitations: LIMITATIONS,
      disclaimer: TAG_COVERAGE_DISCLAIMER,
    };
  }

  let total = BigInt(0);
  let tagged = BigInt(0);
  let untagged = BigInt(0);
  let lineCount = 0;
  let taggedLineCount = 0;
  let untaggedLineCount = 0;

  interface KeyAccumulator {
    covered: bigint;
    missing: bigint;
    coveredLineCount: number;
    missingLineCount: number;
  }
  const perKey = new Map<string, KeyAccumulator>(
    allocationTagKeys.map((key) => [key, { covered: BigInt(0), missing: BigInt(0), coveredLineCount: 0, missingLineCount: 0 }]),
  );
  const byService = new Map<string, GroupAccumulator>();
  const byAccount = new Map<string, GroupAccumulator>();

  for (const line of lines) {
    if (line.currency !== currency) continue;
    const amount = BigInt(line.amountMicros);
    total += amount;
    lineCount += 1;

    const lineTagged = hasAnyTag(line.tags);
    if (lineTagged) {
      tagged += amount;
      taggedLineCount += 1;
    } else {
      untagged += amount;
      untaggedLineCount += 1;
      const service = byService.get(line.service) ?? { untagged: BigInt(0), lineCount: 0 };
      service.untagged += amount;
      service.lineCount += 1;
      byService.set(line.service, service);
      const account = byAccount.get(line.usageAccountId) ?? { untagged: BigInt(0), lineCount: 0 };
      account.untagged += amount;
      account.lineCount += 1;
      byAccount.set(line.usageAccountId, account);
    }

    for (const key of allocationTagKeys) {
      const accumulator = perKey.get(key);
      if (accumulator === undefined) continue;
      if (hasTagKey(line.tags, key)) {
        accumulator.covered += amount;
        accumulator.coveredLineCount += 1;
      } else {
        accumulator.missing += amount;
        accumulator.missingLineCount += 1;
      }
    }
  }

  return {
    schema: "sutra.finops-tag-coverage.v1",
    currency,
    currenciesPresent,
    allocationTagKeys,
    overall: {
      totalMicros: total.toString(),
      totalUnits: unitsFromMicros(total),
      taggedMicros: tagged.toString(),
      taggedUnits: unitsFromMicros(tagged),
      untaggedMicros: untagged.toString(),
      untaggedUnits: unitsFromMicros(untagged),
      taggedPercent: percentBig(tagged, total),
      lineCount,
      taggedLineCount,
      untaggedLineCount,
    },
    perTagKey: allocationTagKeys.map((key) => {
      const accumulator = perKey.get(key) ?? { covered: BigInt(0), missing: BigInt(0), coveredLineCount: 0, missingLineCount: 0 };
      return {
        key,
        coveredMicros: accumulator.covered.toString(),
        coveredUnits: unitsFromMicros(accumulator.covered),
        missingMicros: accumulator.missing.toString(),
        missingUnits: unitsFromMicros(accumulator.missing),
        coveragePercent: percentBig(accumulator.covered, total),
        coveredLineCount: accumulator.coveredLineCount,
        missingLineCount: accumulator.missingLineCount,
      };
    }),
    biggestUnallocated: {
      services: rankUnallocated(byService, topN),
      accounts: rankUnallocated(byAccount, topN),
    },
    limitations: LIMITATIONS,
    disclaimer: TAG_COVERAGE_DISCLAIMER,
  };
}
