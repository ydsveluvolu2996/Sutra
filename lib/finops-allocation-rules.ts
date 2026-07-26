/**
 * Allocation rules ("virtual tags"): a pure, deterministic engine that assigns
 * each ingested billing line to a customer / product / cost-center by matching
 * account / service / tag patterns. This is the classic MSP problem — shared
 * accounts and untagged spend have to be attributed by RULE, not by a tag the
 * customer never set.
 *
 * Honesty rules mirror the rest of FinOps:
 * - Money stays in bigint micro-units; no float drift.
 * - The FIRST enabled rule (ordered by priority asc, then id asc) that matches
 *   a line wins; a line matched by no rule lands in an explicit `unallocated`
 *   bucket rather than being silently attributed to anyone.
 * - A rule matches only when EVERY criterion it specifies matches; an empty
 *   match ({}) is treated as "matches nothing" so a misconfigured catch-all
 *   can never sweep the whole bill by accident.
 */

import type { NormalizedCurLine } from "./finops-cur.ts";

export type AllocationTargetKind = "customer" | "product" | "cost_center";

export const ALLOCATION_TARGET_KINDS: readonly AllocationTargetKind[] = ["customer", "product", "cost_center"];

export interface AllocationMatch {
  readonly account?: string; // exact usageAccountId
  readonly service?: string; // exact service name
  readonly tagKey?: string; // line must carry this tag key…
  readonly tagValue?: string; // …and (when present) this exact value
}

export interface AllocationRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number; // lower is matched first
  readonly match: AllocationMatch;
  readonly targetKind: AllocationTargetKind;
  readonly targetValue: string;
  readonly enabled: boolean;
}

export interface AllocationBucket {
  readonly targetKind: AllocationTargetKind;
  readonly targetValue: string;
  readonly ruleId: string | null; // the rule that produced this bucket; null for the unallocated bucket
  readonly ruleName: string | null;
  readonly amountMicros: string;
  readonly amountUnits: number;
  readonly lineCount: number;
}

export interface AllocationResult {
  readonly allocated: readonly AllocationBucket[];
  readonly unallocated: {
    readonly amountMicros: string;
    readonly amountUnits: number;
    readonly lineCount: number;
  };
  readonly currency: string | null;
  readonly totalMicros: string;
  readonly totalUnits: number;
  readonly ruleCount: number;
}

function microsToUnits(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/** True when every criterion the rule specifies is satisfied by the line. */
function lineMatchesRule(line: NormalizedCurLine, match: AllocationMatch): boolean {
  let specified = false;
  if (match.account !== undefined) {
    specified = true;
    if (line.usageAccountId !== match.account) return false;
  }
  if (match.service !== undefined) {
    specified = true;
    if (line.service !== match.service) return false;
  }
  if (match.tagKey !== undefined) {
    specified = true;
    const value = line.tags[match.tagKey];
    if (value === undefined) return false;
    if (match.tagValue !== undefined && value !== match.tagValue) return false;
  }
  // An empty match matches nothing — never sweep the whole bill by accident.
  return specified;
}

interface Accumulator {
  targetKind: AllocationTargetKind;
  targetValue: string;
  ruleId: string;
  ruleName: string;
  micros: bigint;
  lineCount: number;
}

/**
 * Assign each line to the first matching enabled rule. Deterministic: rules are
 * evaluated in (priority asc, id asc) order and buckets are emitted in that same
 * rule order, so the same inputs always yield byte-identical output.
 */
export function applyAllocationRules(
  lines: readonly NormalizedCurLine[],
  rules: readonly AllocationRule[],
): AllocationResult {
  const ordered = rules
    .filter((rule) => rule.enabled)
    .slice()
    .sort((a, b) => (a.priority - b.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const buckets = new Map<string, Accumulator>();
  let unallocatedMicros = BigInt(0);
  let unallocatedLines = 0;
  let totalMicros = BigInt(0);
  let currency: string | null = null;

  for (const line of lines) {
    let amount: bigint;
    try {
      amount = BigInt(line.amountMicros);
    } catch {
      continue; // malformed micros never counted (mirrors the parser's honesty)
    }
    if (currency === null && line.currency.length > 0) currency = line.currency;
    totalMicros += amount;

    const rule = ordered.find((candidate) => lineMatchesRule(line, candidate.match));
    if (rule === undefined) {
      unallocatedMicros += amount;
      unallocatedLines += 1;
      continue;
    }
    const key = `${rule.id}`;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, {
        targetKind: rule.targetKind,
        targetValue: rule.targetValue,
        ruleId: rule.id,
        ruleName: rule.name,
        micros: amount,
        lineCount: 1,
      });
    } else {
      existing.micros += amount;
      existing.lineCount += 1;
    }
  }

  const allocated: AllocationBucket[] = ordered
    .map((rule) => buckets.get(rule.id))
    .filter((entry): entry is Accumulator => entry !== undefined)
    .map((entry) => ({
      targetKind: entry.targetKind,
      targetValue: entry.targetValue,
      ruleId: entry.ruleId,
      ruleName: entry.ruleName,
      amountMicros: entry.micros.toString(),
      amountUnits: microsToUnits(entry.micros),
      lineCount: entry.lineCount,
    }));

  return {
    allocated,
    unallocated: {
      amountMicros: unallocatedMicros.toString(),
      amountUnits: microsToUnits(unallocatedMicros),
      lineCount: unallocatedLines,
    },
    currency,
    totalMicros: totalMicros.toString(),
    totalUnits: microsToUnits(totalMicros),
    ruleCount: ordered.length,
  };
}
