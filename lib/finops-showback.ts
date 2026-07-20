/**
 * Pure, deterministic SHOWBACK / CHARGEBACK engine over ALREADY-persisted
 * CUR/FOCUS spend. It attributes billed line items to customers (tenants),
 * PER CURRENCY, and reports informational per-customer totals (showback).
 * Chargeback — spreading shared/unattributed spend and/or applying an uplift —
 * is OFF by default and fully disclosed when enabled.
 *
 * Multi-tenant model: a cloud connection belongs to a customer; each CUR line
 * carries a usageAccountId and cost-allocation tags. Attribution therefore maps
 * an AWS account id and/or a cost-allocation tag value to a customerId. The
 * mapping is applied by the input adapter (`buildShowbackInput`), which records
 * the basis used per line; this engine only aggregates.
 *
 * Evidence-honesty rules (never relaxed):
 * - Currencies are NEVER summed together — one result per currency.
 * - Spend that matches no customer is disclosed as `unattributedMicros`; it is
 *   NEVER force-assigned to a customer in the showback view.
 * - Each customer bucket discloses WHICH attribution bases contributed
 *   (account-map, tag, or both) — attribution is never silent.
 * - Chargeback is opt-in and disclosed: the shared-cost distribution basis
 *   ("by-direct-spend-share") and the uplift percent are both echoed in the
 *   result. There is NEVER a hidden markup — with chargeback off, every
 *   chargeback field is null.
 * - Distribution uses integer BigInt floor math; the penny remainder that does
 *   not divide evenly is disclosed as `undistributedRemainderMicros` and left in
 *   the unattributed pool rather than being silently sprinkled onto a customer.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n). No fabricated
 *   numbers, no assumed splits.
 */

export type AttributionBasis = "account-map" | "tag";

/** One CUR line already attributed to a customer (or explicitly unattributed). */
export interface AttributedCurLine {
  /** The customer this line was attributed to, or null when nothing matched. */
  readonly customerId: string | null;
  /** Which basis attributed it; null iff `customerId` is null. */
  readonly basis: AttributionBasis | null;
  readonly currency: string;
  /** Integer micro-units as a bigint-safe decimal string. */
  readonly amountMicros: string;
  readonly usageAccountId: string;
  readonly service: string;
}

/** A line the adapter could not use; disclosed, never guessed. */
export interface SkippedShowbackLine {
  readonly reason: string;
}

export interface ShowbackInput {
  readonly lines: readonly AttributedCurLine[];
  /** Optional disclosure of lines the adapter dropped (the engine ignores it). */
  readonly skipped?: readonly SkippedShowbackLine[];
}

export interface ShowbackChargebackOptions {
  /**
   * Spread unattributed (shared/common) spend across customers in proportion to
   * their direct-spend share, PER CURRENCY. Off by default.
   */
  readonly distributeShared?: boolean;
  /**
   * A disclosed uplift/markup percent applied to each customer's chargeable base
   * (direct + any distributed shared spend). Off (0) by default. Negative or
   * non-finite values are treated as 0 — an uplift is never hidden or negative.
   */
  readonly upliftPercent?: number;
}

export interface ShowbackOptions {
  readonly chargeback?: ShowbackChargebackOptions;
}

export interface ShowbackCustomerBucket {
  readonly customerId: string;
  /** Directly attributed spend in micros — always present (the showback figure). */
  readonly directMicros: string;
  /** Which attribution bases contributed to this bucket, sorted & deduplicated. */
  readonly attributionBases: readonly AttributionBasis[];
  readonly lineCount: number;
  /** Shared spend distributed onto this customer; null when distribution is off. */
  readonly distributedSharedMicros: string | null;
  /** Disclosed uplift amount; null when no uplift is applied. */
  readonly upliftMicros: string | null;
  /** direct + distributed + uplift; null when chargeback is entirely off. */
  readonly chargebackTotalMicros: string | null;
}

export type ChargebackNote =
  | "NO_DIRECT_SPEND_BASIS_FOR_DISTRIBUTION"
  | "NO_UNATTRIBUTED_SPEND_TO_DISTRIBUTE";

export interface ShowbackChargebackDisclosure {
  readonly enabled: boolean;
  readonly distributeShared: boolean;
  readonly distributionBasis: "by-direct-spend-share" | null;
  readonly upliftPercent: number;
  /** Portion of unattributed spend actually distributed; null when off. */
  readonly distributedUnattributedMicros: string | null;
  /** Floor remainder left undistributed (kept unattributed); null when off. */
  readonly undistributedRemainderMicros: string | null;
  readonly note: ChargebackNote | null;
}

export interface ShowbackCurrencyResult {
  readonly currency: string;
  readonly customers: readonly ShowbackCustomerBucket[];
  /** Spend that matched no customer — disclosed, never assigned in showback. */
  readonly unattributedMicros: string;
  readonly unattributedLineCount: number;
  readonly totalMicros: string;
  readonly chargeback: ShowbackChargebackDisclosure;
}

export interface ShowbackReport {
  readonly schema: "sutra.finops-showback.v1";
  readonly results: readonly ShowbackCurrencyResult[];
  readonly chargebackEnabled: boolean;
  readonly options: {
    readonly distributeShared: boolean;
    readonly upliftPercent: number;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const SHOWBACK_DISCLAIMER =
  "Showback attributes persisted billing line items to customers per currency " +
  "(currencies are never summed together) using an account-id map and/or a " +
  "cost-allocation tag; the attribution basis is disclosed per customer. Spend " +
  "matching no customer is reported as unattributed and is never force-assigned. " +
  "Chargeback (distributing shared spend by direct-spend share and/or applying an " +
  "uplift percent) is off by default and fully disclosed when enabled — there is " +
  "never a hidden markup. This is a cost-attribution view, not an invoice.";

const LIMITATIONS: readonly string[] = [
  "SHOWBACK_IS_COMPUTED_OVER_ALREADY_PERSISTED_BILLING_LINES_NO_NEW_INGESTION",
  "CURRENCIES_ARE_NEVER_SUMMED_ONE_RESULT_PER_CURRENCY",
  "SPEND_MATCHING_NO_CUSTOMER_IS_DISCLOSED_AS_UNATTRIBUTED_NEVER_FORCE_ASSIGNED",
  "ATTRIBUTION_BASIS_ACCOUNT_MAP_OR_TAG_IS_DISCLOSED_PER_CUSTOMER",
  "CHARGEBACK_DISTRIBUTION_AND_UPLIFT_ARE_OPT_IN_AND_FULLY_DISCLOSED_NO_HIDDEN_MARKUP",
  "DISTRIBUTION_REMAINDER_THAT_DOES_NOT_DIVIDE_EVENLY_IS_DISCLOSED_NOT_SPRINKLED",
];

const MICROS_INT = /^-?\d+$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;

interface ResolvedChargeback {
  readonly enabled: boolean;
  readonly distributeShared: boolean;
  readonly upliftPercent: number;
  /** Uplift as integer basis points (percent * 100) for exact BigInt math. */
  readonly upliftBps: bigint;
}

function resolveChargeback(options?: ShowbackOptions): ResolvedChargeback {
  const distributeShared = options?.chargeback?.distributeShared === true;
  const raw = options?.chargeback?.upliftPercent;
  const upliftPercent =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
  const upliftBps = BigInt(Math.round(upliftPercent * 100));
  return {
    enabled: distributeShared || upliftPercent > 0,
    distributeShared,
    upliftPercent: Number(upliftBps) / 100,
    upliftBps,
  };
}

interface CustomerAccumulator {
  direct: bigint;
  lineCount: number;
  readonly bases: Set<AttributionBasis>;
}

export function buildShowback(input: ShowbackInput, options?: ShowbackOptions): ShowbackReport {
  const chargeback = resolveChargeback(options);

  // Group lines per currency; within a currency, accumulate per customer and
  // track the unattributed remainder separately.
  const byCurrency = new Map<
    string,
    {
      readonly customers: Map<string, CustomerAccumulator>;
      unattributed: bigint;
      unattributedLineCount: number;
      total: bigint;
    }
  >();

  for (const line of input.lines) {
    if (!CURRENCY_RE.test(line.currency) || !MICROS_INT.test(line.amountMicros)) continue;
    const amount = BigInt(line.amountMicros);
    let group = byCurrency.get(line.currency);
    if (group === undefined) {
      group = { customers: new Map(), unattributed: BigInt(0), unattributedLineCount: 0, total: BigInt(0) };
      byCurrency.set(line.currency, group);
    }
    group.total += amount;
    if (line.customerId === null || line.customerId.length === 0 || line.basis === null) {
      group.unattributed += amount;
      group.unattributedLineCount += 1;
      continue;
    }
    let acc = group.customers.get(line.customerId);
    if (acc === undefined) {
      acc = { direct: BigInt(0), lineCount: 0, bases: new Set() };
      group.customers.set(line.customerId, acc);
    }
    acc.direct += amount;
    acc.lineCount += 1;
    acc.bases.add(line.basis);
  }

  const results: ShowbackCurrencyResult[] = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-US"))
    .map(([currency, group]) => buildCurrencyResult(currency, group, chargeback));

  return {
    schema: "sutra.finops-showback.v1",
    results,
    chargebackEnabled: chargeback.enabled,
    options: {
      distributeShared: chargeback.distributeShared,
      upliftPercent: chargeback.upliftPercent,
    },
    limitations: LIMITATIONS,
    disclaimer: SHOWBACK_DISCLAIMER,
  };
}

function buildCurrencyResult(
  currency: string,
  group: {
    readonly customers: Map<string, CustomerAccumulator>;
    readonly unattributed: bigint;
    readonly unattributedLineCount: number;
    readonly total: bigint;
  },
  chargeback: ResolvedChargeback,
): ShowbackCurrencyResult {
  // Deterministic ordering: descending direct spend, then customerId ascending.
  const ordered = [...group.customers.entries()].sort((a, b) => {
    if (b[1].direct > a[1].direct) return 1;
    if (b[1].direct < a[1].direct) return -1;
    return a[0].localeCompare(b[0], "en-US");
  });

  const directTotal = ordered.reduce((sum, [, acc]) => sum + acc.direct, BigInt(0));

  // Distribution of the unattributed pool, when requested.
  const distributed = new Map<string, bigint>();
  let distributedUnattributed = BigInt(0);
  let note: ChargebackNote | null = null;
  if (chargeback.distributeShared) {
    if (group.unattributed <= BigInt(0)) {
      note = "NO_UNATTRIBUTED_SPEND_TO_DISTRIBUTE";
    } else if (directTotal <= BigInt(0)) {
      note = "NO_DIRECT_SPEND_BASIS_FOR_DISTRIBUTION";
    } else {
      for (const [customerId, acc] of ordered) {
        // floor(unattributed * share); the remainder is disclosed, never sprinkled.
        const share = (group.unattributed * acc.direct) / directTotal;
        distributed.set(customerId, share);
        distributedUnattributed += share;
      }
    }
  }
  const undistributedRemainder = chargeback.distributeShared
    ? group.unattributed - distributedUnattributed
    : BigInt(0);

  const customers: ShowbackCustomerBucket[] = ordered.map(([customerId, acc]) => {
    const distributedShared = chargeback.distributeShared
      ? distributed.get(customerId) ?? BigInt(0)
      : null;
    const chargeableBase = acc.direct + (distributedShared ?? BigInt(0));
    const uplift =
      chargeback.upliftPercent > 0 ? (chargeableBase * chargeback.upliftBps) / BigInt(10000) : null;
    const chargebackTotal = chargeback.enabled
      ? chargeableBase + (uplift ?? BigInt(0))
      : null;
    return {
      customerId,
      directMicros: acc.direct.toString(),
      attributionBases: [...acc.bases].sort((x, y) => x.localeCompare(y, "en-US")),
      lineCount: acc.lineCount,
      distributedSharedMicros: distributedShared === null ? null : distributedShared.toString(),
      upliftMicros: uplift === null ? null : uplift.toString(),
      chargebackTotalMicros: chargebackTotal === null ? null : chargebackTotal.toString(),
    };
  });

  return {
    currency,
    customers,
    unattributedMicros: group.unattributed.toString(),
    unattributedLineCount: group.unattributedLineCount,
    totalMicros: group.total.toString(),
    chargeback: {
      enabled: chargeback.enabled,
      distributeShared: chargeback.distributeShared,
      distributionBasis: chargeback.distributeShared ? "by-direct-spend-share" : null,
      upliftPercent: chargeback.upliftPercent,
      distributedUnattributedMicros: chargeback.distributeShared ? distributedUnattributed.toString() : null,
      undistributedRemainderMicros: chargeback.distributeShared ? undistributedRemainder.toString() : null,
      note,
    },
  };
}
