import type { NormalizedCurLine } from "./finops-cur.ts";

/**
 * Pure, deterministic REGION cost grouping over ingested CUR/FOCUS line items.
 * Honesty rules mirror the other FinOps engines:
 * - Currencies are NEVER summed together — one reporting currency is chosen
 *   deterministically and only its lines are aggregated.
 * - Region cost is only meaningful once at least one ingested line carries a
 *   region. Older uploads predate the region-aware parser and every line's
 *   region is null; that is disclosed as `available: false` (regions empty) so
 *   the UI can say the region was not in the uploaded billing file — it is
 *   never fabricated.
 * - When SOME lines carry a region, lines with a null region are disclosed
 *   under an "unattributed" bucket; they are never redistributed.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n).
 */

export interface RegionCostBucket {
  readonly region: string;
  readonly amountMicros: string;
  readonly amount: number;
  readonly percent: number;
}

export interface RegionCostResult {
  readonly available: boolean;
  readonly currency: string;
  readonly regions: readonly RegionCostBucket[];
}

/** Bucket for lines that carry no region while others in the set do. */
export const UNATTRIBUTED_REGION = "unattributed";

export function groupCostByRegion(lines: readonly NormalizedCurLine[]): RegionCostResult {
  // Choose a single reporting currency deterministically (lowest code), then
  // aggregate ONLY that currency's lines — currencies are never mixed.
  const currency = [...new Set(lines.map((line) => line.currency))].sort()[0] ?? "";
  const inCurrency = lines.filter((line) => line.currency === currency);
  const anyRegion = inCurrency.some((line) => line.region !== null);
  if (!anyRegion) {
    return { available: false, currency, regions: [] };
  }
  const byRegion = new Map<string, bigint>();
  let total = BigInt(0);
  for (const line of inCurrency) {
    const amount = BigInt(line.amountMicros);
    total += amount;
    const region = line.region ?? UNATTRIBUTED_REGION;
    byRegion.set(region, (byRegion.get(region) ?? BigInt(0)) + amount);
  }
  const regions = [...byRegion.entries()]
    .map(([region, amountMicros]) => ({
      region,
      amountMicros: amountMicros.toString(),
      amount: Number(amountMicros) / 1_000_000,
      percent: total === BigInt(0) ? 0 : Number((amountMicros * BigInt(10000)) / total) / 100,
    }))
    .sort((a, b) => (BigInt(b.amountMicros) > BigInt(a.amountMicros)
      ? 1
      : BigInt(b.amountMicros) < BigInt(a.amountMicros)
        ? -1
        : a.region.localeCompare(b.region)));
  return { available: true, currency, regions };
}
