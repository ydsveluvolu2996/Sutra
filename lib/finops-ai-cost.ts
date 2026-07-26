/**
 * Pure, deterministic AI / LLM TOKEN COST intelligence over ingested CUR/FOCUS
 * billing lines.
 *
 * What it answers: how much generative-AI inference (Amazon Bedrock) spend a
 * billing period carries, split by MODEL and by TOKEN DIRECTION (input vs
 * output vs prompt-cache), how many tokens were metered, the resulting cost per
 * 1K tokens, and how per-model spend moves across the ingested periods.
 *
 * Where the data comes from: nothing here calls an API or a price list. Bedrock
 * token billing lands in the CUR as usage line items whose `line_item_usage_type`
 * names both the model and the token direction (e.g.
 * "USE1-InputTokenCount-anthropic.claude-3-sonnet-v1:0") and whose
 * `line_item_usage_amount` carries the metered token quantity with
 * `pricing_unit` naming its scale ("tokens", "1K tokens"). Those three columns
 * are the entire basis of this view.
 *
 * Evidence-honesty rules (never relaxed):
 * - Money is integer micro-units summed with BigInt (BigInt(0), never 0n).
 *   Amounts are returned as both `*Micros` (exact string) and `*Units` (number).
 * - Token counts are a MEASURED QUANTITY. They are read from the metered usage
 *   amount and rescaled ONLY by an explicitly recognised unit. A missing usage
 *   amount, a missing unit, or an unrecognised unit means tokens are UNAVAILABLE
 *   for that line, disclosed with the unit verbatim. Tokens are NEVER derived
 *   from cost, defaulted, or guessed from a model's public list price.
 * - Cost per 1K tokens is emitted ONLY when EVERY line in the group carried a
 *   derivable token quantity. Partial token coverage yields null with a reason —
 *   dividing a full spend total by a partial token total would overstate the rate.
 * - When no analyzed line carries a usage type at all (uploads that predate the
 *   usage-type column), the view reports `available: false` with the reason. The
 *   spend total is still exact; only the model/token split is unavailable.
 * - A line whose usage type carries no recognisable model identifier is bucketed
 *   under UNATTRIBUTED_MODEL rather than being attributed to a guessed model.
 * - A SINGLE currency is analysed. When lines carry more than one currency the
 *   dominant currency (greatest AI spend, ties broken by code ascending) is
 *   picked deterministically and ONLY its lines are aggregated — currencies are
 *   never summed together. Every currency present is disclosed.
 * - Non-AWS providers (OpenAI, Anthropic first-party, ...) are NOT covered: they
 *   do not appear in an AWS billing file and no usage export is ingested. That
 *   omission is disclosed rather than being filled with an estimate.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";

/** Bucket for Bedrock spend whose usage type names no recognisable model. */
export const UNATTRIBUTED_MODEL = "unattributed";

export type TokenDirection = "input" | "output" | "cache_read" | "cache_write" | "other";

export interface AiTokenTotals {
  /** Token count in integer micro-units (bigint-safe string); null when not derivable. */
  readonly tokensMicros: string | null;
  /** Same total as a display number; null when not derivable. */
  readonly tokens: number | null;
}

export interface AiDirectionBreakdown extends AiTokenTotals {
  readonly direction: TokenDirection;
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
  /** Lines in this direction that carried a derivable token quantity. */
  readonly tokenLineCount: number;
}

export interface AiModelBreakdown extends AiTokenTotals {
  /** Model identifier lifted verbatim from the usage type, or UNATTRIBUTED_MODEL. */
  readonly model: string;
  readonly modelIdentified: boolean;
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
  readonly tokenLineCount: number;
  /** True when EVERY line for this model carried a derivable token quantity. */
  readonly tokensDerivable: boolean;
  /** Cost of 1,000 tokens in integer micro-units; null when tokens are not fully derivable. */
  readonly costPer1kTokensMicros: string | null;
  readonly costPer1kTokensUnits: number | null;
  /** Why tokens (and therefore the rate) are unavailable; null when they are available. */
  readonly tokensUnavailableReason: string | null;
  readonly byDirection: readonly AiDirectionBreakdown[];
}

export interface AiSpendTrendPoint extends AiTokenTotals {
  /** Billing month derived from the line's usage start, "YYYY-MM". */
  readonly period: string;
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
}

export interface AiCostView {
  readonly schema: "sutra.finops-ai-cost.v1";
  /**
   * True when at least one AI (Bedrock) line was found AND it carried a usage
   * type, i.e. the model/token split is actually derivable from the billing file.
   */
  readonly available: boolean;
  /** Why the model/token split is unavailable; null when available. */
  readonly unavailableReason: string | null;
  /** True when at least one analyzed AI line carried a usage-type string. */
  readonly usageTypePresent: boolean;
  readonly currency: string | null;
  readonly currenciesPresent: readonly string[];
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
  /** Analyzed AI lines that carried a derivable token quantity. */
  readonly tokenLineCount: number;
  /** Total tokens across analyzed lines; null unless EVERY analyzed line was derivable. */
  readonly tokensMicros: string | null;
  readonly tokens: number | null;
  /** Every model, greatest spend first (ties broken by model ascending). */
  readonly byModel: readonly AiModelBreakdown[];
  /** The leading models by spend — a stable prefix of `byModel`. */
  readonly topModels: readonly AiModelBreakdown[];
  readonly byDirection: readonly AiDirectionBreakdown[];
  /** Spend per ingested billing month, ascending. */
  readonly trend: readonly AiSpendTrendPoint[];
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const AI_COST_DISCLAIMER =
  "AI/LLM cost is read from ingested AWS billing lines for Amazon Bedrock. Model " +
  "and token direction come from each line's usage type; token counts come from " +
  "the line's metered usage amount rescaled only by an explicitly recognised unit. " +
  "Where a line carries no usage type, no usage amount, or an unrecognised unit, " +
  "spend is still reported exactly and tokens are reported as unavailable — token " +
  "counts are never inferred from cost or from a model's list price, and cost per " +
  "1K tokens is withheld unless every line in the group carried a measured token " +
  "quantity. Non-AWS providers are not represented: no first-party OpenAI or " +
  "Anthropic usage export is ingested. A single currency is analysed and " +
  "currencies are never summed together.";

const LIMITATIONS: readonly string[] = [
  "MODEL_AND_TOKEN_DIRECTION_COME_ONLY_FROM_THE_BILLING_LINE_USAGE_TYPE",
  "TOKEN_COUNTS_COME_ONLY_FROM_THE_METERED_USAGE_AMOUNT_AND_A_RECOGNISED_UNIT",
  "TOKENS_ARE_NEVER_DERIVED_FROM_COST_OR_FROM_A_MODEL_LIST_PRICE",
  "COST_PER_1K_TOKENS_IS_WITHHELD_UNLESS_EVERY_LINE_IN_THE_GROUP_HAS_MEASURED_TOKENS",
  "SPEND_WHOSE_USAGE_TYPE_NAMES_NO_MODEL_IS_BUCKETED_AS_UNATTRIBUTED_NOT_GUESSED",
  "NON_AWS_LLM_PROVIDERS_ARE_NOT_INGESTED_AND_ARE_NOT_REPRESENTED",
  "A_SINGLE_CURRENCY_IS_ANALYSED_AND_CURRENCIES_ARE_NEVER_SUMMED_TOGETHER",
];

const NO_AI_LINES = "No Amazon Bedrock billing lines were found in this billing file.";
const NO_USAGE_TYPE =
  "The billing file carries Bedrock spend but no usage-type column, so the model and " +
  "token direction behind that spend are not derivable. Re-upload a CUR/FOCUS export " +
  "that includes the usage type.";
const PARTIAL_TOKENS =
  "Some lines carried no measured token quantity, so token totals and cost per 1K tokens are withheld.";

const CURRENCY = /^[A-Z]{3}$/u;
const TOP_MODEL_LIMIT = 5;

function unitsFromMicros(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/**
 * Is this billing line generative-AI inference? Matched on the service naming
 * Bedrock in either dialect ("AmazonBedrock" for CUR, "Amazon Bedrock" for
 * FOCUS). Deliberately narrow: services that do not bill by token (SageMaker
 * endpoints, Comprehend) belong to compute/GPU cost, not token cost, and are
 * NOT folded in here where they would corrupt a per-token rate.
 */
export function isAiServiceLine(line: NormalizedCurLine): boolean {
  return line.service.toLowerCase().replaceAll(/[\s_-]/gu, "").includes("bedrock");
}

/** Normalize a string for marker matching: lowercase, separators removed. */
function squash(value: string): string {
  return value.toLowerCase().replaceAll(/[\s_.:-]/gu, "");
}

/**
 * Token direction from a usage type. Cache markers are tested BEFORE the plain
 * input/output markers because a cache-read usage type also contains "input".
 * A token-bearing usage type with no recognised direction marker is "other" —
 * its spend still counts, it is simply not split.
 */
export function tokenDirectionFromUsageType(usageType: string): TokenDirection | null {
  const key = squash(usageType);
  if (!key.includes("token")) return null;
  if (key.includes("cacheread") || key.includes("cachedread") || key.includes("readcache")) return "cache_read";
  if (key.includes("cachewrite") || key.includes("cachecreation") || key.includes("writecache")) return "cache_write";
  if (key.includes("input")) return "input";
  if (key.includes("output")) return "output";
  return "other";
}

const REGION_PREFIX = /^[A-Z]{2,4}\d?-/u;
// Longest marker first so "cache-read-input-tokens" is not shortened to
// "-input-tokens". Deliberately NOT global: a global regex carries lastIndex
// state between calls, which would make this function non-deterministic.
const DIRECTION_TOKENS: readonly RegExp[] = [
  /cache[-_]?read[-_]?input[-_]?token(?:count|s)?/iu,
  /cache[-_]?write[-_]?input[-_]?token(?:count|s)?/iu,
  /cache[-_]?creation[-_]?input[-_]?token(?:count|s)?/iu,
  /input[-_]?token(?:count|s)?/iu,
  /output[-_]?token(?:count|s)?/iu,
  /token(?:count|s)?/iu,
];

/**
 * Lift the model identifier out of a usage type. The AWS region prefix, a
 * leading "Bedrock" qualifier and the token-direction marker are stripped; what
 * remains is the model identifier VERBATIM (e.g. "anthropic.claude-3-sonnet-v1:0").
 * Returns null when nothing recognisable remains — the caller then buckets the
 * spend as unattributed rather than inventing a model name.
 */
export function modelFromUsageType(usageType: string): string | null {
  let rest = usageType.trim().replace(REGION_PREFIX, "");
  for (const marker of DIRECTION_TOKENS) {
    if (!marker.test(rest)) continue;
    rest = rest.replace(marker, "");
    break;
  }
  rest = rest.replaceAll(/^[-_.:\s]+|[-_.:\s]+$/gu, "");
  if (/^bedrock[-_.:]?/iu.test(rest)) {
    rest = rest.replace(/^bedrock[-_.:]?/iu, "").replaceAll(/^[-_.:\s]+/gu, "");
  }
  return rest.length > 0 ? rest : null;
}

/**
 * Multiplier turning a metered usage amount into TOKENS, from the unit string.
 * Only explicitly recognised units are accepted; anything else (including a
 * missing unit) returns null so the caller reports tokens as unavailable.
 */
export function tokenUnitMultiplier(usageUnit: string | null): bigint | null {
  if (usageUnit === null) return null;
  // The unit must END in "token"/"tokens"; whatever precedes it is the scale.
  // Anything the scale grammar does not cover returns null (disclosed as an
  // unrecognised unit) rather than being assumed to be 1 token.
  const match = /^(?:per)?(\d*)([km])?tokens?$/u.exec(squash(usageUnit));
  if (match === null) return null;
  const count = match[1].length > 0 ? BigInt(match[1]) : BigInt(1);
  const si = match[2] === "k" ? BigInt(1000) : match[2] === "m" ? BigInt(1_000_000) : BigInt(1);
  const multiplier = count * si;
  return multiplier > BigInt(0) ? multiplier : null;
}

/** Tokens for a line in integer micro-units, or null when not measurable. */
function tokensMicrosFor(line: NormalizedCurLine): bigint | null {
  if (line.usageAmountMicros === null) return null;
  const multiplier = tokenUnitMultiplier(line.usageUnit);
  if (multiplier === null) return null;
  const amount = BigInt(line.usageAmountMicros);
  if (amount < BigInt(0)) return null;
  return amount * multiplier;
}

/**
 * Pick the currency to analyse: greatest AI spend, ties broken by code
 * ascending. Deterministic and never mixes currencies.
 */
function pickCurrency(lines: readonly NormalizedCurLine[]): string | null {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    if (!CURRENCY.test(line.currency)) continue;
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

interface Accumulator {
  spend: bigint;
  tokens: bigint;
  lineCount: number;
  tokenLineCount: number;
}

function emptyAccumulator(): Accumulator {
  return { spend: BigInt(0), tokens: BigInt(0), lineCount: 0, tokenLineCount: 0 };
}

function add(accumulator: Accumulator, spend: bigint, tokens: bigint | null): void {
  accumulator.spend += spend;
  accumulator.lineCount += 1;
  if (tokens !== null) {
    accumulator.tokens += tokens;
    accumulator.tokenLineCount += 1;
  }
}

/** Token totals, present only when every line in the group was measurable. */
function tokenTotals(accumulator: Accumulator): AiTokenTotals {
  const complete = accumulator.lineCount > 0 && accumulator.tokenLineCount === accumulator.lineCount;
  return complete
    ? { tokensMicros: accumulator.tokens.toString(), tokens: unitsFromMicros(accumulator.tokens) }
    : { tokensMicros: null, tokens: null };
}

/**
 * Cost of 1,000 tokens in micro-units. tokensMicros is a micro-scaled count, so
 * the rate is spend * 1000 * 1e6 / tokensMicros, floored by integer division —
 * never floating-point. Null when tokens are unknown or zero (no divide-by-zero,
 * no guessed denominator).
 */
function costPer1kMicros(spend: bigint, tokensMicros: string | null): string | null {
  if (tokensMicros === null) return null;
  const tokens = BigInt(tokensMicros);
  if (tokens <= BigInt(0)) return null;
  return ((spend * BigInt(1000) * BigInt(1_000_000)) / tokens).toString();
}

function directionRows(byDirection: Map<TokenDirection, Accumulator>): readonly AiDirectionBreakdown[] {
  return [...byDirection.entries()]
    .map(([direction, accumulator]) => ({
      direction,
      spendMicros: accumulator.spend.toString(),
      spendUnits: unitsFromMicros(accumulator.spend),
      lineCount: accumulator.lineCount,
      tokenLineCount: accumulator.tokenLineCount,
      ...tokenTotals(accumulator),
    }))
    .sort((a, b) => {
      const spendA = BigInt(a.spendMicros);
      const spendB = BigInt(b.spendMicros);
      if (spendA !== spendB) return spendA > spendB ? -1 : 1;
      return a.direction.localeCompare(b.direction, "en-US");
    });
}

function emptyView(
  currenciesPresent: readonly string[],
  currency: string | null,
  spend: bigint,
  lineCount: number,
  usageTypePresent: boolean,
  unavailableReason: string,
): AiCostView {
  return {
    schema: "sutra.finops-ai-cost.v1",
    available: false,
    unavailableReason,
    usageTypePresent,
    currency,
    currenciesPresent,
    spendMicros: spend.toString(),
    spendUnits: unitsFromMicros(spend),
    lineCount,
    tokenLineCount: 0,
    tokensMicros: null,
    tokens: null,
    byModel: [],
    topModels: [],
    byDirection: [],
    trend: [],
    limitations: LIMITATIONS,
    disclaimer: AI_COST_DISCLAIMER,
  };
}

/**
 * Build the AI/LLM token cost view over ingested billing lines.
 *
 * @param lines ingested & normalized CUR/FOCUS lines. Pass every period's lines
 *   to populate the multi-period trend; pass one period's for a single point.
 */
export function buildAiCostView(lines: readonly NormalizedCurLine[]): AiCostView {
  const aiLines = lines.filter((line) => CURRENCY.test(line.currency) && isAiServiceLine(line));
  const currenciesPresent = [...new Set(aiLines.map((line) => line.currency))]
    .sort((a, b) => a.localeCompare(b, "en-US"));
  const currency = pickCurrency(aiLines);
  if (currency === null) {
    return emptyView([], null, BigInt(0), 0, false, NO_AI_LINES);
  }

  const analyzed = aiLines.filter((line) => line.currency === currency);
  const usageTypePresent = analyzed.some((line) => line.usageType !== null);
  if (!usageTypePresent) {
    // Spend is still exact and worth showing; only the split is unavailable.
    let spend = BigInt(0);
    for (const line of analyzed) spend += BigInt(line.amountMicros);
    return emptyView(currenciesPresent, currency, spend, analyzed.length, false, NO_USAGE_TYPE);
  }

  const total = emptyAccumulator();
  const byModel = new Map<string, Accumulator>();
  const byModelDirection = new Map<string, Map<TokenDirection, Accumulator>>();
  const byDirection = new Map<TokenDirection, Accumulator>();
  const byPeriod = new Map<string, Accumulator>();
  const identified = new Set<string>();

  for (const line of analyzed) {
    const spend = BigInt(line.amountMicros);
    const tokens = tokensMicrosFor(line);
    const usageType = line.usageType;
    const model = usageType === null ? null : modelFromUsageType(usageType);
    const modelKey = model ?? UNATTRIBUTED_MODEL;
    if (model !== null) identified.add(modelKey);
    const direction = usageType === null ? "other" : tokenDirectionFromUsageType(usageType) ?? "other";

    add(total, spend, tokens);

    const modelAccumulator = byModel.get(modelKey) ?? emptyAccumulator();
    add(modelAccumulator, spend, tokens);
    byModel.set(modelKey, modelAccumulator);

    const directions = byModelDirection.get(modelKey) ?? new Map<TokenDirection, Accumulator>();
    const modelDirection = directions.get(direction) ?? emptyAccumulator();
    add(modelDirection, spend, tokens);
    directions.set(direction, modelDirection);
    byModelDirection.set(modelKey, directions);

    const directionAccumulator = byDirection.get(direction) ?? emptyAccumulator();
    add(directionAccumulator, spend, tokens);
    byDirection.set(direction, directionAccumulator);

    const period = line.usageStartIso.slice(0, 7);
    const periodAccumulator = byPeriod.get(period) ?? emptyAccumulator();
    add(periodAccumulator, spend, tokens);
    byPeriod.set(period, periodAccumulator);
  }

  const models: readonly AiModelBreakdown[] = [...byModel.entries()]
    .map(([model, accumulator]) => {
      const totals = tokenTotals(accumulator);
      const derivable = totals.tokensMicros !== null;
      const rate = costPer1kMicros(accumulator.spend, totals.tokensMicros);
      return {
        model,
        modelIdentified: identified.has(model) && model !== UNATTRIBUTED_MODEL,
        spendMicros: accumulator.spend.toString(),
        spendUnits: unitsFromMicros(accumulator.spend),
        lineCount: accumulator.lineCount,
        tokenLineCount: accumulator.tokenLineCount,
        tokensDerivable: derivable,
        ...totals,
        costPer1kTokensMicros: rate,
        costPer1kTokensUnits: rate === null ? null : unitsFromMicros(BigInt(rate)),
        tokensUnavailableReason: derivable
          ? null
          : accumulator.tokenLineCount === 0
            ? "No line for this model carried a measured token quantity with a recognised token unit."
            : PARTIAL_TOKENS,
        byDirection: directionRows(byModelDirection.get(model) ?? new Map()),
      };
    })
    .sort((a, b) => {
      const spendA = BigInt(a.spendMicros);
      const spendB = BigInt(b.spendMicros);
      if (spendA !== spendB) return spendA > spendB ? -1 : 1;
      return a.model.localeCompare(b.model, "en-US");
    });

  const trend: readonly AiSpendTrendPoint[] = [...byPeriod.entries()]
    .map(([period, accumulator]) => ({
      period,
      spendMicros: accumulator.spend.toString(),
      spendUnits: unitsFromMicros(accumulator.spend),
      lineCount: accumulator.lineCount,
      ...tokenTotals(accumulator),
    }))
    .sort((a, b) => a.period.localeCompare(b.period, "en-US"));

  const totals = tokenTotals(total);
  return {
    schema: "sutra.finops-ai-cost.v1",
    available: true,
    unavailableReason: null,
    usageTypePresent: true,
    currency,
    currenciesPresent,
    spendMicros: total.spend.toString(),
    spendUnits: unitsFromMicros(total.spend),
    lineCount: total.lineCount,
    tokenLineCount: total.tokenLineCount,
    ...totals,
    byModel: models,
    topModels: models.slice(0, TOP_MODEL_LIMIT),
    byDirection: directionRows(byDirection),
    trend,
    limitations: LIMITATIONS,
    disclaimer: AI_COST_DISCLAIMER,
  };
}
