/**
 * Pure, deterministic utilization-based rightsizing engine.
 *
 * Given per-resource CloudWatch utilization samples, the current on-demand
 * monthly cost (integer micro-units, per-currency), and an instance-family
 * catalog, it recommends a SMALLER same-family instance only when observed
 * utilization is confidently low over a sufficient observation window, and it
 * attaches a DERIVABLE dollar saving computed from the catalog's relative
 * pricing applied to the observed cost.
 *
 * Evidence-honesty rules (never relaxed):
 * - A saving is emitted ONLY when it is derivable from the collected data
 *   (a smaller catalog target AND a known current cost). It is NEVER invented.
 * - When utilization data is absent or the window is too short, the resource is
 *   emitted as `insufficient-data` (savings null) with the reason disclosed.
 * - Memory utilization is often NOT collected (no CloudWatch agent). When memory
 *   is unknown the recommendation is CPU/network-based and MUST disclose
 *   "memory utilization not collected" so a memory-bound workload is not wrongly
 *   downsized. When memory IS known and high, the resource is NOT downsized.
 * - The observation window is always disclosed, and every saving is labelled an
 *   estimate, not a guarantee.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n); currencies
 *   are never summed together — savings are totalled per currency.
 */

export interface InstanceCatalogEntry {
  readonly instanceType: string;
  readonly family: string;
  readonly vcpu: number;
  readonly memGiB: number;
  /**
   * Relative cost within the family (proportional to on-demand price). Either
   * `relativeCost` or `hourlyMicros` must be present; when both are present
   * `hourlyMicros` is used. Ratios only — the absolute scale is irrelevant.
   */
  readonly relativeCost?: number;
  /** Explicit on-demand hourly price in integer micro-units (bigint-safe string). */
  readonly hourlyMicros?: string;
}

export interface UtilizationSample {
  readonly resourceKey: string;
  readonly currentInstanceType: string;
  readonly region: string;
  /** Observed p95 CPU utilization percent over the window. Null when not collected. */
  readonly cpuP95Percent: number | null;
  /** Observed p95 network throughput (bytes/min). Null when not collected. */
  readonly networkP95BytesPerMinute: number | null;
  /** OPTIONAL observed p95 memory utilization percent. Null when not collected. */
  readonly memoryP95Percent: number | null;
  readonly sampleWindowDays: number;
}

export interface ResourceCost {
  readonly resourceKey: string;
  readonly currency: string;
  /** Current on-demand monthly cost in integer micro-units (bigint-safe string). */
  readonly currentMonthlyCostMicros: string;
}

export interface RightsizingThresholds {
  /** CPU p95 must be strictly below this to be "confidently low". */
  readonly maxCpuP95Percent: number;
  /** Memory p95 (when known) must be strictly below this to allow a downsize. */
  readonly maxMemoryP95Percent: number;
  /** Minimum observation window (days) before any recommendation is made. */
  readonly minSampleWindowDays: number;
}

export const DEFAULT_RIGHTSIZING_THRESHOLDS: RightsizingThresholds = {
  maxCpuP95Percent: 40,
  maxMemoryP95Percent: 50,
  minSampleWindowDays: 14,
};

export interface RightsizingInput {
  readonly samples: readonly UtilizationSample[];
  readonly costs: readonly ResourceCost[];
  readonly catalog: readonly InstanceCatalogEntry[];
  readonly thresholds?: Partial<RightsizingThresholds>;
}

export type RightsizingState =
  | "downsize-recommended"
  | "insufficient-data"
  | "already-optimal";

export interface RightsizingObservation {
  readonly cpuP95Percent: number | null;
  readonly memoryP95Percent: number | null;
  readonly networkP95BytesPerMinute: number | null;
  readonly sampleWindowDays: number | null;
}

export interface RightsizingRecommendation {
  readonly resourceKey: string;
  readonly region: string | null;
  readonly currentInstanceType: string | null;
  readonly state: RightsizingState;
  readonly targetInstanceType: string | null;
  readonly currency: string | null;
  readonly currentMonthlyCostMicros: string | null;
  readonly targetMonthlyCostMicros: string | null;
  /**
   * Derivable monthly saving in integer micro-units, or null when not derivable
   * (the reason is then present in `reasons`). Never fabricated.
   */
  readonly estimatedMonthlySavingsMicros: string | null;
  readonly observed: RightsizingObservation;
  /** True only when memory utilization was actually collected for this resource. */
  readonly memoryKnown: boolean;
  readonly basis: "cpu-network" | "cpu-network-memory" | null;
  readonly reasons: readonly string[];
}

export interface RightsizingReport {
  readonly schema: "sutra.finops-rightsizing.v1";
  readonly recommendations: readonly RightsizingRecommendation[];
  readonly summary: {
    readonly evaluated: number;
    readonly downsizeRecommended: number;
    readonly insufficientData: number;
    /** Savings totalled per currency in micro-units — never summed across currencies. */
    readonly savingsByCurrencyMicros: Readonly<Record<string, string>>;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const RIGHTSIZING_DISCLAIMER =
  "Rightsizing recommendations are derived from collected CloudWatch utilization " +
  "over the disclosed observation window and the current on-demand cost. A smaller " +
  "same-family instance is suggested only when utilization is confidently low; the " +
  "estimated saving is a planning ESTIMATE (catalog relative pricing applied to the " +
  "observed cost), not a guarantee or an AWS quote. Where memory utilization was not " +
  "collected the recommendation is CPU/network-based — verify the workload is not " +
  "memory-bound before downsizing. Resources without sufficient data are surfaced as " +
  "insufficient-data, never as a fabricated saving.";

const REASON_ESTIMATE =
  "SAVINGS_ARE_AN_ESTIMATE_FROM_CATALOG_RELATIVE_PRICING_NOT_A_GUARANTEE";
const REASON_MEMORY_UNKNOWN =
  "MEMORY_UTILIZATION_NOT_COLLECTED_RECOMMENDATION_IS_CPU_NETWORK_BASED_VERIFY_NOT_MEMORY_BOUND";
const REASON_WINDOW_TOO_SHORT = "OBSERVATION_WINDOW_BELOW_MINIMUM_FOR_A_CONFIDENT_RECOMMENDATION";
const REASON_NO_CPU = "CPU_UTILIZATION_NOT_COLLECTED_FOR_THIS_RESOURCE";
const REASON_TYPE_UNKNOWN = "CURRENT_INSTANCE_TYPE_NOT_IN_CATALOG_CANNOT_SIZE";
const REASON_NO_COST = "CURRENT_ON_DEMAND_COST_NOT_DERIVABLE_NO_SAVING_CLAIMED";
const REASON_SMALLEST_IN_FAMILY = "ALREADY_THE_SMALLEST_INSTANCE_IN_ITS_FAMILY";
const REASON_UTILIZATION_NOT_LOW = "UTILIZATION_NOT_CONFIDENTLY_LOW_OVER_THE_WINDOW";
const REASON_MEMORY_BOUND = "MEMORY_P95_ABOVE_THRESHOLD_WORKLOAD_APPEARS_MEMORY_BOUND_NOT_DOWNSIZED";

const LIMITATIONS: readonly string[] = [
  "RIGHTSIZING_USES_COLLECTED_CLOUDWATCH_UTILIZATION_OVER_THE_DISCLOSED_WINDOW",
  "MEMORY_UTILIZATION_REQUIRES_CLOUDWATCH_AGENT_AND_IS_OFTEN_UNKNOWN",
  "SAVINGS_ARE_ESTIMATES_FROM_CATALOG_RELATIVE_PRICING_NOT_AWS_QUOTES",
  "RESOURCES_WITHOUT_SUFFICIENT_DATA_ARE_SURFACED_AS_INSUFFICIENT_DATA_NOT_ZERO",
];

function resolveThresholds(overrides?: Partial<RightsizingThresholds>): RightsizingThresholds {
  return {
    maxCpuP95Percent: overrides?.maxCpuP95Percent ?? DEFAULT_RIGHTSIZING_THRESHOLDS.maxCpuP95Percent,
    maxMemoryP95Percent:
      overrides?.maxMemoryP95Percent ?? DEFAULT_RIGHTSIZING_THRESHOLDS.maxMemoryP95Percent,
    minSampleWindowDays:
      overrides?.minSampleWindowDays ?? DEFAULT_RIGHTSIZING_THRESHOLDS.minSampleWindowDays,
  };
}

/** Scaled integer "cost units" for exact BigInt ratio math; identical units for target/current. */
function costUnits(entry: InstanceCatalogEntry): bigint | null {
  if (typeof entry.hourlyMicros === "string" && /^\d+$/u.test(entry.hourlyMicros)) {
    const micros = BigInt(entry.hourlyMicros);
    return micros > BigInt(0) ? micros : null;
  }
  if (typeof entry.relativeCost === "number" && Number.isFinite(entry.relativeCost) && entry.relativeCost > 0) {
    // Scale to micro-units so common fractional ratios (0.5, 0.25) stay exact.
    return BigInt(Math.round(entry.relativeCost * 1_000_000));
  }
  return null;
}

/**
 * The immediately-smaller instance in the same family: the largest catalog entry
 * whose cost is strictly below the current one. A one-step downsize keeps a
 * conservative headroom (halving resources roughly doubles observed utilization),
 * which is why a < ~40% CPU p95 gate makes it safe. Deterministic tie-break by type.
 */
function nextSmaller(
  current: InstanceCatalogEntry,
  catalog: readonly InstanceCatalogEntry[],
): InstanceCatalogEntry | null {
  const currentUnits = costUnits(current);
  if (currentUnits === null) return null;
  let best: { entry: InstanceCatalogEntry; units: bigint } | null = null;
  for (const entry of catalog) {
    if (entry.family !== current.family || entry.instanceType === current.instanceType) continue;
    const units = costUnits(entry);
    if (units === null || units >= currentUnits) continue;
    if (
      best === null ||
      units > best.units ||
      (units === best.units && entry.instanceType.localeCompare(best.entry.instanceType, "en-US") < 0)
    ) {
      best = { entry, units };
    }
  }
  return best === null ? null : best.entry;
}

export function buildRightsizingRecommendations(input: RightsizingInput): RightsizingReport {
  const thresholds = resolveThresholds(input.thresholds);
  const catalogByType = new Map<string, InstanceCatalogEntry>();
  for (const entry of input.catalog) {
    if (!catalogByType.has(entry.instanceType)) catalogByType.set(entry.instanceType, entry);
  }
  const costByResource = new Map<string, ResourceCost>();
  for (const cost of input.costs) {
    if (!costByResource.has(cost.resourceKey)) costByResource.set(cost.resourceKey, cost);
  }

  const savingsByCurrency: Record<string, bigint> = {};
  const recommendations: RightsizingRecommendation[] = [];

  const orderedSamples = [...input.samples].sort((a, b) =>
    a.resourceKey.localeCompare(b.resourceKey, "en-US"),
  );

  for (const sample of orderedSamples) {
    const cost = costByResource.get(sample.resourceKey) ?? null;
    const memoryKnown = typeof sample.memoryP95Percent === "number" && Number.isFinite(sample.memoryP95Percent);
    const observed: RightsizingObservation = {
      cpuP95Percent: typeof sample.cpuP95Percent === "number" && Number.isFinite(sample.cpuP95Percent)
        ? sample.cpuP95Percent
        : null,
      memoryP95Percent: memoryKnown ? (sample.memoryP95Percent as number) : null,
      networkP95BytesPerMinute:
        typeof sample.networkP95BytesPerMinute === "number" && Number.isFinite(sample.networkP95BytesPerMinute)
          ? sample.networkP95BytesPerMinute
          : null,
      sampleWindowDays: Number.isFinite(sample.sampleWindowDays) ? sample.sampleWindowDays : null,
    };

    const base = {
      resourceKey: sample.resourceKey,
      region: sample.region.length > 0 ? sample.region : null,
      currentInstanceType: sample.currentInstanceType.length > 0 ? sample.currentInstanceType : null,
      currency: cost?.currency ?? null,
      currentMonthlyCostMicros: cost?.currentMonthlyCostMicros ?? null,
      observed,
      memoryKnown,
    };

    // 1. Insufficient data: no CPU signal, or the window is too short to be confident.
    if (observed.cpuP95Percent === null) {
      recommendations.push({
        ...base,
        state: "insufficient-data",
        targetInstanceType: null,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis: null,
        reasons: [REASON_NO_CPU, windowDisclosure(observed.sampleWindowDays)],
      });
      continue;
    }
    if (observed.sampleWindowDays === null || observed.sampleWindowDays < thresholds.minSampleWindowDays) {
      recommendations.push({
        ...base,
        state: "insufficient-data",
        targetInstanceType: null,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis: null,
        reasons: [REASON_WINDOW_TOO_SHORT, windowDisclosure(observed.sampleWindowDays, thresholds)],
      });
      continue;
    }

    const currentEntry = catalogByType.get(sample.currentInstanceType) ?? null;
    if (currentEntry === null) {
      recommendations.push({
        ...base,
        state: "insufficient-data",
        targetInstanceType: null,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis: memoryKnown ? "cpu-network-memory" : "cpu-network",
        reasons: [REASON_TYPE_UNKNOWN],
      });
      continue;
    }

    const basis: "cpu-network" | "cpu-network-memory" = memoryKnown ? "cpu-network-memory" : "cpu-network";

    // 2. Memory-bound: memory is known AND at/above the threshold — never downsize.
    if (memoryKnown && (observed.memoryP95Percent as number) >= thresholds.maxMemoryP95Percent) {
      recommendations.push({
        ...base,
        state: "already-optimal",
        targetInstanceType: null,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis,
        reasons: [REASON_MEMORY_BOUND, windowDisclosure(observed.sampleWindowDays)],
      });
      continue;
    }

    // 3. Utilization must be confidently low to consider a downsize.
    if (observed.cpuP95Percent >= thresholds.maxCpuP95Percent) {
      recommendations.push({
        ...base,
        state: "already-optimal",
        targetInstanceType: null,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis,
        reasons: [REASON_UTILIZATION_NOT_LOW, windowDisclosure(observed.sampleWindowDays)],
      });
      continue;
    }

    const target = nextSmaller(currentEntry, input.catalog);
    if (target === null) {
      recommendations.push({
        ...base,
        state: "already-optimal",
        targetInstanceType: null,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis,
        reasons: [REASON_SMALLEST_IN_FAMILY, windowDisclosure(observed.sampleWindowDays)],
      });
      continue;
    }

    // 4. A downsize target exists. Attach a saving ONLY if the current cost is known.
    const reasons: string[] = [windowDisclosure(observed.sampleWindowDays), REASON_ESTIMATE];
    if (!memoryKnown) reasons.unshift(REASON_MEMORY_UNKNOWN);

    if (cost === null) {
      recommendations.push({
        ...base,
        state: "downsize-recommended",
        targetInstanceType: target.instanceType,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis,
        reasons: [REASON_NO_COST, ...reasons],
      });
      continue;
    }

    const currentUnits = costUnits(currentEntry);
    const targetUnits = costUnits(target);
    if (
      currentUnits === null ||
      targetUnits === null ||
      !/^-?\d+$/u.test(cost.currentMonthlyCostMicros)
    ) {
      recommendations.push({
        ...base,
        state: "downsize-recommended",
        targetInstanceType: target.instanceType,
        targetMonthlyCostMicros: null,
        estimatedMonthlySavingsMicros: null,
        basis,
        reasons: [REASON_NO_COST, ...reasons],
      });
      continue;
    }

    const currentMicros = BigInt(cost.currentMonthlyCostMicros);
    // target = current * (targetUnits / currentUnits), integer math, then saving = current - target.
    const targetMicros = (currentMicros * targetUnits) / currentUnits;
    const savingMicros = currentMicros - targetMicros;
    if (savingMicros > BigInt(0)) {
      savingsByCurrency[cost.currency] = (savingsByCurrency[cost.currency] ?? BigInt(0)) + savingMicros;
    }
    recommendations.push({
      ...base,
      state: "downsize-recommended",
      targetInstanceType: target.instanceType,
      targetMonthlyCostMicros: targetMicros.toString(),
      estimatedMonthlySavingsMicros: savingMicros.toString(),
      basis,
      reasons,
    });
  }

  const savingsOut: Record<string, string> = {};
  for (const currency of Object.keys(savingsByCurrency).sort((a, b) => a.localeCompare(b, "en-US"))) {
    savingsOut[currency] = savingsByCurrency[currency].toString();
  }

  return {
    schema: "sutra.finops-rightsizing.v1",
    recommendations,
    summary: {
      evaluated: recommendations.length,
      downsizeRecommended: recommendations.filter((rec) => rec.state === "downsize-recommended").length,
      insufficientData: recommendations.filter((rec) => rec.state === "insufficient-data").length,
      savingsByCurrencyMicros: savingsOut,
    },
    limitations: LIMITATIONS,
    disclaimer: RIGHTSIZING_DISCLAIMER,
  };
}

function windowDisclosure(days: number | null, thresholds?: RightsizingThresholds): string {
  if (days === null) return "OBSERVATION_WINDOW_UNKNOWN";
  const minimum = thresholds === undefined ? "" : `_MINIMUM_${thresholds.minSampleWindowDays}_DAYS`;
  return `OBSERVATION_WINDOW_${days}_DAYS${minimum}`;
}
