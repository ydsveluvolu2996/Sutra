/**
 * Pure, deterministic tag / cost-allocation governance over collected CMDB
 * resources, ingested CUR/FOCUS billing lines, and a configurable required-tag
 * policy (e.g. ["CostCenter","Owner","Environment"]).
 *
 * It reports three things, all honestly bounded:
 *   1. Per-currency untagged-spend %: the share of CUR spend on billing lines
 *      that are missing at least one required tag. Spend is attributed by the
 *      SAME tag-join `buildAllocation` uses (the CUR line's own tags), so the
 *      denominator is the ingested spend and nothing is redistributed.
 *   2. Per-required-tag coverage %: over collected resources, how many carry
 *      each required tag.
 *   3. The list of resources missing each required tag (resourceKey + which
 *      required tags are absent from the collected metadata).
 *
 * Evidence-honesty rules (never relaxed):
 * - "Untagged" means a resource/line lacks a required tag IN THE COLLECTED
 *   METADATA. It is a coverage statement, not proof of an untracked cost.
 * - Money is integer micro-units via BigInt; currencies are never summed
 *   together — every spend figure is per-currency.
 * - Tag-key matching is case-insensitive (AWS keys are case-sensitive, orgs are
 *   inconsistent); this is disclosed. A tag counts as present only when its
 *   value is non-empty.
 * - The two views use different denominators (CUR spend vs resource count) and
 *   the CUR line tags and resource tags may differ; this is disclosed. Spend on
 *   lines that carry none of the required tags is reported as unattributable to
 *   any required allocation dimension — it is never hidden.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";

export const DEFAULT_REQUIRED_TAGS: readonly string[] = ["CostCenter", "Owner", "Environment"];

export interface TagGovernanceResource {
  readonly resourceKey: string;
  readonly service: string | null;
  readonly region: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

export interface TagGovernanceInput {
  readonly resources: readonly TagGovernanceResource[];
  readonly curLines?: readonly NormalizedCurLine[];
  /** Required-tag policy; defaults to DEFAULT_REQUIRED_TAGS when omitted/empty. */
  readonly requiredTags?: readonly string[];
}

export interface RequiredTagCoverage {
  readonly tag: string;
  readonly resourcesTotal: number;
  readonly resourcesWithTag: number;
  readonly coveragePercent: number | null;
  readonly missingResourceKeys: readonly string[];
}

export interface CurrencyUntaggedSpend {
  readonly currency: string;
  readonly totalMicros: string;
  /** Spend on lines missing at least one required tag. */
  readonly untaggedMicros: string;
  readonly untaggedPercent: number | null;
  /** Spend missing each specific required tag, keyed by tag. */
  readonly perTagMissingMicros: Readonly<Record<string, string>>;
  /** Spend on lines carrying NONE of the required tags (unattributable dimension). */
  readonly unattributableMicros: string;
  readonly lineCount: number;
  readonly untaggedLineCount: number;
}

export interface MissingTagResource {
  readonly resourceKey: string;
  readonly service: string | null;
  readonly region: string | null;
  readonly missingTags: readonly string[];
}

export interface TagGovernanceReport {
  readonly schema: "sutra.finops-tag-governance.v1";
  readonly requiredTags: readonly string[];
  readonly resourceCoverage: readonly RequiredTagCoverage[];
  readonly spendByCurrency: readonly CurrencyUntaggedSpend[];
  readonly missingByResource: readonly MissingTagResource[];
  readonly summary: {
    readonly resourcesEvaluated: number;
    readonly resourcesFullyTagged: number;
    readonly resourcesMissingAnyTag: number;
    readonly fullyTaggedPercent: number | null;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const TAG_GOVERNANCE_DISCLAIMER =
  "Tag governance measures cost-allocation tag coverage. 'Untagged' means a " +
  "resource or billing line is missing a required tag IN THE COLLECTED METADATA " +
  "— a coverage statement, not proof of untracked cost. Untagged-spend % is " +
  "computed from CUR/FOCUS line tags using the same tag-join as allocation, per " +
  "currency and never summed across currencies; spend on lines carrying none of " +
  "the required tags is disclosed as unattributable to any required allocation " +
  "dimension. Tag-key matching is case-insensitive. Resource coverage and spend " +
  "use different denominators (resource count vs spend) and the two tag sources " +
  "can differ.";

const LIMITATIONS: readonly string[] = [
  "UNTAGGED_MEANS_MISSING_A_REQUIRED_TAG_IN_COLLECTED_METADATA_NOT_PROOF_OF_UNTRACKED_COST",
  "UNTAGGED_SPEND_IS_COMPUTED_FROM_CUR_LINE_TAGS_THE_SAME_JOIN_AS_ALLOCATION",
  "SPEND_IS_PER_CURRENCY_AND_NEVER_SUMMED_ACROSS_CURRENCIES",
  "TAG_KEY_MATCHING_IS_CASE_INSENSITIVE_AND_A_TAG_COUNTS_ONLY_WHEN_ITS_VALUE_IS_NON_EMPTY",
  "RESOURCE_COVERAGE_AND_SPEND_USE_DIFFERENT_DENOMINATORS_AND_TAG_SOURCES_MAY_DIFFER",
];

function normalizeRequiredTags(tags: readonly string[] | undefined): readonly string[] {
  const source = tags !== undefined && tags.length > 0 ? tags : DEFAULT_REQUIRED_TAGS;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of source) {
    if (typeof tag !== "string" || tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result.length > 0 ? result : DEFAULT_REQUIRED_TAGS;
}

/** Case-insensitive lookup: true when a required tag has a non-empty value. */
function hasTag(tags: Readonly<Record<string, string>>, required: string): boolean {
  const wanted = required.toLowerCase();
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === wanted && typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

function percentBig(part: bigint, whole: bigint): number | null {
  if (whole <= BigInt(0)) return null;
  return Number((part * BigInt(10000)) / whole) / 100;
}

function percentInt(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 10000) / 100;
}

export function buildTagGovernance(input: TagGovernanceInput): TagGovernanceReport {
  const requiredTags = normalizeRequiredTags(input.requiredTags);
  const resources = input.resources;

  // --- Resource coverage + missing-by-resource ---
  const withTagCount = new Map<string, number>(requiredTags.map((tag) => [tag, 0]));
  const missingKeysByTag = new Map<string, string[]>(requiredTags.map((tag) => [tag, []]));
  const missingByResource: MissingTagResource[] = [];
  let fullyTagged = 0;

  const orderedResources = [...resources].sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, "en-US"));
  for (const resource of orderedResources) {
    const missing: string[] = [];
    for (const tag of requiredTags) {
      if (hasTag(resource.tags, tag)) {
        withTagCount.set(tag, (withTagCount.get(tag) ?? 0) + 1);
      } else {
        missing.push(tag);
        missingKeysByTag.get(tag)?.push(resource.resourceKey);
      }
    }
    if (missing.length === 0) {
      fullyTagged += 1;
    } else {
      missingByResource.push({
        resourceKey: resource.resourceKey,
        service: resource.service,
        region: resource.region,
        missingTags: missing,
      });
    }
  }

  const resourceCoverage: RequiredTagCoverage[] = requiredTags.map((tag) => ({
    tag,
    resourcesTotal: resources.length,
    resourcesWithTag: withTagCount.get(tag) ?? 0,
    coveragePercent: percentInt(withTagCount.get(tag) ?? 0, resources.length),
    missingResourceKeys: [...(missingKeysByTag.get(tag) ?? [])].sort((a, b) => a.localeCompare(b, "en-US")),
  }));

  // --- Per-currency untagged spend (CUR line tags, same join as allocation) ---
  const spendByCurrency = buildSpendByCurrency(input.curLines ?? [], requiredTags);

  return {
    schema: "sutra.finops-tag-governance.v1",
    requiredTags,
    resourceCoverage,
    spendByCurrency,
    missingByResource,
    summary: {
      resourcesEvaluated: resources.length,
      resourcesFullyTagged: fullyTagged,
      resourcesMissingAnyTag: missingByResource.length,
      fullyTaggedPercent: percentInt(fullyTagged, resources.length),
    },
    limitations: LIMITATIONS,
    disclaimer: TAG_GOVERNANCE_DISCLAIMER,
  };
}

function buildSpendByCurrency(
  lines: readonly NormalizedCurLine[],
  requiredTags: readonly string[],
): CurrencyUntaggedSpend[] {
  interface Accumulator {
    total: bigint;
    untagged: bigint;
    unattributable: bigint;
    perTagMissing: Map<string, bigint>;
    lineCount: number;
    untaggedLineCount: number;
  }
  const byCurrency = new Map<string, Accumulator>();
  for (const line of lines) {
    const accumulator = byCurrency.get(line.currency) ?? {
      total: BigInt(0),
      untagged: BigInt(0),
      unattributable: BigInt(0),
      perTagMissing: new Map<string, bigint>(requiredTags.map((tag) => [tag, BigInt(0)])),
      lineCount: 0,
      untaggedLineCount: 0,
    };
    const amount = BigInt(line.amountMicros);
    accumulator.total += amount;
    accumulator.lineCount += 1;
    const missing = requiredTags.filter((tag) => !hasTag(line.tags, tag));
    for (const tag of missing) {
      accumulator.perTagMissing.set(tag, (accumulator.perTagMissing.get(tag) ?? BigInt(0)) + amount);
    }
    if (missing.length > 0) {
      accumulator.untagged += amount;
      accumulator.untaggedLineCount += 1;
    }
    if (missing.length === requiredTags.length) {
      accumulator.unattributable += amount;
    }
    byCurrency.set(line.currency, accumulator);
  }

  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([currency, accumulator]) => {
      const perTagMissingMicros: Record<string, string> = {};
      for (const tag of requiredTags) {
        perTagMissingMicros[tag] = (accumulator.perTagMissing.get(tag) ?? BigInt(0)).toString();
      }
      return {
        currency,
        totalMicros: accumulator.total.toString(),
        untaggedMicros: accumulator.untagged.toString(),
        untaggedPercent: percentBig(accumulator.untagged, accumulator.total),
        perTagMissingMicros,
        unattributableMicros: accumulator.unattributable.toString(),
        lineCount: accumulator.lineCount,
        untaggedLineCount: accumulator.untaggedLineCount,
      };
    });
}
