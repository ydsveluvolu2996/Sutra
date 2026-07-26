/**
 * Pure, deterministic GPU / ACCELERATOR COST view over ingested CUR/FOCUS
 * billing lines plus collected CMDB inventory.
 *
 * What it answers: which accelerated instances this tenant runs, how much they
 * cost, and how that spend splits by accelerator family and region. What it
 * deliberately does NOT answer: whether a GPU is idle. See below.
 *
 * Where the data comes from:
 * - SPEND: the billing line's usage type is the only column naming the metered
 *   instance type ("USE1-BoxUsage:p4d.24xlarge", "SpotUsage:g5.xlarge"). The
 *   family is derived from that instance type, so a family AWS ships tomorrow is
 *   still recognised by the accelerator-prefix fallback.
 * - BILLED HOURS: the line's metered usage amount, only when its unit is an hour
 *   unit. These are INSTANCE-hours billed, not a utilisation measurement.
 * - INVENTORY: collected CMDB EC2 instances and their instance type.
 *
 * Evidence-honesty rules (never relaxed):
 * - Money is integer micro-units summed with BigInt (BigInt(0), never 0n).
 * - IDLE DETECTION REQUIRES A COLLECTOR THAT IS NOT INSTALLED. GPU utilisation
 *   is not exposed by CloudWatch's default EC2 metrics; it needs an in-guest
 *   collector (DCGM exporter / nvidia-smi via the CloudWatch agent). None is
 *   collected, so callers pass an EMPTY sample set and this engine reports
 *   `utilization.collected: false` with the required collector named, and emits
 *   NO idle candidates. CPU utilisation is never substituted for GPU
 *   utilisation — a GPU job can pin a GPU at 100% with an idle CPU and vice
 *   versa, so that substitution would be a fabricated finding.
 * - A line counts as accelerated ONLY when its usage type yields a parseable
 *   accelerated instance type. A line whose usage type names no instance type is
 *   not accelerated-by-assumption — it is left out, because there is no evidence
 *   either way. `usageTypePresent` discloses whether that evidence existed at all.
 * - When no analyzed line carries a usage type (uploads predating that column),
 *   `spendAvailable` is false with the reason; the CMDB inventory is still
 *   reported because it does not depend on the billing file.
 * - A SINGLE currency is analysed; the dominant currency (greatest accelerated
 *   spend, ties broken by code ascending) wins and currencies are never summed.
 * - No price list is consulted and no saving is estimated anywhere in this file.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import type { PilotResource } from "./pilot-types.ts";

export type AcceleratorClass = "gpu" | "inferentia" | "trainium";

/** How a family was recognised — a named catalog entry or the prefix fallback. */
export type FamilyMatch = "catalog" | "prefix-fallback";

/**
 * Known accelerated EC2 families and what accelerator they carry. This is a
 * convenience catalog, NOT the authority: `acceleratorFamily` falls back to an
 * accelerator-prefix rule so families released after this list still match.
 */
const ACCELERATOR_CATALOG: Readonly<Record<string, AcceleratorClass>> = {
  p2: "gpu", p3: "gpu", p3dn: "gpu", p4d: "gpu", p4de: "gpu", p5: "gpu", p5e: "gpu", p5en: "gpu", p6: "gpu",
  g3: "gpu", g3s: "gpu", g4dn: "gpu", g4ad: "gpu", g5: "gpu", g5g: "gpu", g6: "gpu", g6e: "gpu", gr6: "gpu",
  dl1: "gpu", dl2q: "gpu",
  inf1: "inferentia", inf2: "inferentia",
  trn1: "trainium", trn1n: "trainium", trn2: "trainium",
};

/**
 * Accelerator-prefix fallback: a family whose leading letters are an accelerated
 * prefix and which is followed by a generation digit (p5, g6e, inf2, trn2, dl1).
 * This is a HEURISTIC and is reported as `prefix-fallback` so a consumer can see
 * the family was not in the named catalog.
 */
const PREFIX_FALLBACK: readonly { readonly pattern: RegExp; readonly accelerator: AcceleratorClass }[] = [
  { pattern: /^inf\d/u, accelerator: "inferentia" },
  { pattern: /^trn\d/u, accelerator: "trainium" },
  { pattern: /^dl\d/u, accelerator: "gpu" },
  { pattern: /^gr?\d/u, accelerator: "gpu" },
  { pattern: /^p\d/u, accelerator: "gpu" },
];

export interface AcceleratorFamily {
  readonly family: string;
  readonly accelerator: AcceleratorClass;
  readonly matchedBy: FamilyMatch;
}

/** Bucket for lines and resources with no region. */
export const UNKNOWN_REGION = "unknown";

export interface GpuFamilySpend {
  readonly family: string;
  readonly accelerator: AcceleratorClass | null;
  readonly matchedBy: FamilyMatch | null;
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
  /** Instance-hours billed; null unless EVERY line in the group carried an hour quantity. */
  readonly billedHours: number | null;
  readonly billedHoursMicros: string | null;
  /** Distinct instance types seen for this family, ascending. */
  readonly instanceTypes: readonly string[];
}

export interface GpuRegionSpend {
  readonly region: string;
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
}

export interface GpuInventoryEntry {
  readonly resourceKey: string;
  readonly instanceType: string;
  readonly family: string;
  readonly accelerator: AcceleratorClass;
  readonly matchedBy: FamilyMatch;
  readonly region: string;
  readonly state: string;
}

export interface GpuInventory {
  readonly entries: readonly GpuInventoryEntry[];
  readonly instanceCount: number;
  /** Accelerated instances that are not running (stopped/stopping/terminated). */
  readonly notRunningCount: number;
  /**
   * EC2 instances in the CMDB whose instance type was not collected, so they
   * could be accelerated and are simply unknown. Disclosed, never assumed.
   */
  readonly instanceTypeUnknownCount: number;
  readonly byFamily: readonly { readonly family: string; readonly instanceCount: number }[];
}

/**
 * A collected GPU utilisation observation. There is no collector producing these
 * today; the type exists so the engine's contract is explicit about what idle
 * detection would require.
 */
export interface GpuUtilizationSample {
  readonly resourceKey: string;
  /** p95 GPU core utilisation percent over the window. Null when not collected. */
  readonly gpuUtilizationP95Percent: number | null;
  /** p95 GPU memory utilisation percent over the window. Null when not collected. */
  readonly gpuMemoryUtilizationP95Percent: number | null;
  readonly sampleWindowDays: number;
}

export interface GpuIdleThresholds {
  /** GPU p95 utilisation must be strictly below this to be "confidently idle". */
  readonly maxGpuP95Percent: number;
  /** Minimum observation window (days) before any idle claim is made. */
  readonly minSampleWindowDays: number;
}

export const DEFAULT_GPU_IDLE_THRESHOLDS: GpuIdleThresholds = {
  maxGpuP95Percent: 10,
  minSampleWindowDays: 14,
};

export interface GpuIdleCandidate {
  readonly resourceKey: string;
  readonly instanceType: string | null;
  readonly gpuUtilizationP95Percent: number;
  readonly sampleWindowDays: number;
  readonly evidence: string;
}

export interface GpuUtilizationStatus {
  /** False whenever no usable GPU utilisation sample was supplied. */
  readonly collected: boolean;
  readonly sampleCount: number;
  /** Samples that named a GPU utilisation figure (a sample may carry none). */
  readonly usableSampleCount: number;
  readonly thresholds: GpuIdleThresholds;
  /** Why idle detection produced nothing; null when samples were usable. */
  readonly reason: string | null;
  /** The collector idle detection needs, named so it can be installed. */
  readonly requiredCollector: string;
}

export interface GpuCostInput {
  readonly curLines: readonly NormalizedCurLine[];
  /** Collected CMDB resources; EC2 instances among them form the inventory. */
  readonly resources?: readonly PilotResource[];
  /** Collected GPU utilisation samples. Empty in production — no collector exists. */
  readonly utilization?: readonly GpuUtilizationSample[];
  readonly thresholds?: Partial<GpuIdleThresholds>;
}

export interface GpuCostView {
  readonly schema: "sutra.finops-gpu-cost.v1";
  /** True when accelerated spend was derivable from the billing file. */
  readonly spendAvailable: boolean;
  /** Why accelerated spend is unavailable; null when available. */
  readonly spendUnavailableReason: string | null;
  /** True when at least one analyzed line carried a usage-type string. */
  readonly usageTypePresent: boolean;
  readonly currency: string | null;
  readonly currenciesPresent: readonly string[];
  readonly spendMicros: string;
  readonly spendUnits: number;
  readonly lineCount: number;
  readonly byFamily: readonly GpuFamilySpend[];
  readonly byRegion: readonly GpuRegionSpend[];
  readonly byAccelerator: readonly { readonly accelerator: AcceleratorClass; readonly spendMicros: string; readonly spendUnits: number }[];
  readonly inventory: GpuInventory;
  readonly utilization: GpuUtilizationStatus;
  /** Idle GPUs. ALWAYS empty until a GPU utilisation collector is installed. */
  readonly idleCandidates: readonly GpuIdleCandidate[];
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const GPU_COST_DISCLAIMER =
  "GPU cost is derived from ingested AWS billing lines: the accelerated instance " +
  "type is read from each line's usage type and its family from that instance " +
  "type, with an accelerator-prefix fallback for families not in the bundled " +
  "catalog (disclosed per row). Billed hours are the metered usage amount, which " +
  "is instance-hours billed and NOT a utilisation measurement. Idle-GPU detection " +
  "is NOT performed: GPU core and GPU memory utilisation are not exposed by " +
  "default EC2 CloudWatch metrics and require an in-guest collector (DCGM " +
  "exporter or nvidia-smi via the CloudWatch agent) that is not installed. CPU " +
  "utilisation is never used as a proxy for GPU utilisation, so no idle finding " +
  "and no saving estimate is produced. A single currency is analysed and " +
  "currencies are never summed together.";

const LIMITATIONS: readonly string[] = [
  "ACCELERATED_INSTANCE_TYPES_COME_ONLY_FROM_THE_BILLING_LINE_USAGE_TYPE",
  "FAMILIES_OUTSIDE_THE_BUNDLED_CATALOG_MATCH_BY_ACCELERATOR_PREFIX_AND_ARE_DISCLOSED",
  "BILLED_HOURS_ARE_INSTANCE_HOURS_METERED_NOT_A_UTILISATION_MEASUREMENT",
  "GPU_UTILISATION_IS_NOT_COLLECTED_SO_NO_IDLE_GPU_IS_REPORTED",
  "CPU_UTILISATION_IS_NEVER_USED_AS_A_PROXY_FOR_GPU_UTILISATION",
  "NO_PRICE_LIST_IS_CONSULTED_AND_NO_SAVING_IS_ESTIMATED",
  "A_SINGLE_CURRENCY_IS_ANALYSED_AND_CURRENCIES_ARE_NEVER_SUMMED_TOGETHER",
];

const NO_USAGE_TYPE_REASON =
  "The billing file carries no usage-type column, so the instance type behind compute " +
  "spend is not derivable and accelerated spend cannot be separated. Re-upload a " +
  "CUR/FOCUS export that includes the usage type.";
const NO_LINES_REASON = "No billing lines have been ingested for this period.";
const NO_GPU_SPEND_REASON =
  "No accelerated (GPU / Inferentia / Trainium) instance types were found in this billing file's usage types.";
const NO_UTILIZATION_REASON =
  "GPU utilisation is not collected. Default EC2 CloudWatch metrics do not expose GPU " +
  "core or GPU memory utilisation, so idle-GPU detection is unavailable: spend and " +
  "inventory below are measured, idleness is not claimed.";
const NO_USABLE_UTILIZATION_REASON =
  "GPU utilisation samples were supplied but none named a GPU utilisation figure, so no idleness is claimed.";
const REQUIRED_COLLECTOR = "In-guest GPU metrics collector (NVIDIA DCGM exporter, or nvidia-smi via the CloudWatch agent)";

const CURRENCY = /^[A-Z]{3}$/u;
const INSTANCE_TYPE = /^([a-z][a-z0-9-]{0,15})\.([a-z0-9]+)$/u;
const NOT_RUNNING = /^(stopped|stopping|shutting-down|terminated|deallocated)$/iu;
const EC2_INSTANCE_TYPES = new Set(["aws.ec2.instance", "ec2.instance"]);

function unitsFromMicros(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/**
 * Classify an EC2 family as accelerated, or null when it is not. The bundled
 * catalog wins; otherwise the accelerator-prefix fallback applies and is
 * reported as such so nothing looks more authoritative than it is.
 */
export function acceleratorFamily(instanceType: string): AcceleratorFamily | null {
  const match = INSTANCE_TYPE.exec(instanceType.trim().toLowerCase());
  if (match === null) return null;
  const family = match[1];
  const known = ACCELERATOR_CATALOG[family];
  if (known !== undefined) return { family, accelerator: known, matchedBy: "catalog" };
  for (const rule of PREFIX_FALLBACK) {
    if (rule.pattern.test(family)) return { family, accelerator: rule.accelerator, matchedBy: "prefix-fallback" };
  }
  return null;
}

/**
 * Lift an EC2 instance type out of a usage type. CUR compute usage types carry
 * it after a colon ("USE1-BoxUsage:p4d.24xlarge", "SpotUsage:g5.xlarge",
 * "HeavyUsage:trn1.32xlarge"). A usage type with no colon-suffixed instance type
 * yields null — nothing is inferred from the prefix alone.
 */
export function instanceTypeFromUsageType(usageType: string): string | null {
  const colon = usageType.lastIndexOf(":");
  if (colon < 0) return null;
  const candidate = usageType.slice(colon + 1).trim().toLowerCase();
  return INSTANCE_TYPE.test(candidate) ? candidate : null;
}

/** Hours for a line as integer micro-units, or null when the unit is not an hour unit. */
function billedHoursMicrosFor(line: NormalizedCurLine): bigint | null {
  if (line.usageAmountMicros === null || line.usageUnit === null) return null;
  const unit = line.usageUnit.toLowerCase().replaceAll(/[\s_.-]/gu, "");
  if (!(unit === "hrs" || unit === "hr" || unit === "hour" || unit === "hours" || unit === "instancehours" || unit === "instancehour")) {
    return null;
  }
  const amount = BigInt(line.usageAmountMicros);
  return amount < BigInt(0) ? null : amount;
}

/** Pick the currency to analyse: greatest accelerated spend, ties by code ascending. */
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

interface FamilyAccumulator {
  spend: bigint;
  hours: bigint;
  lineCount: number;
  hourLineCount: number;
  accelerator: AcceleratorClass | null;
  matchedBy: FamilyMatch | null;
  instanceTypes: Set<string>;
}

/** Build the CMDB-side accelerated inventory. Independent of the billing file. */
function buildInventory(resources: readonly PilotResource[]): GpuInventory {
  const entries: GpuInventoryEntry[] = [];
  let instanceTypeUnknownCount = 0;
  for (const resource of resources) {
    if (!EC2_INSTANCE_TYPES.has(resource.resourceType.toLowerCase())) continue;
    const configured = resource.configuration.instanceType;
    if (typeof configured !== "string" || configured.length === 0) {
      instanceTypeUnknownCount += 1;
      continue;
    }
    const family = acceleratorFamily(configured);
    if (family === null) continue;
    entries.push({
      resourceKey: resource.resourceKey,
      instanceType: configured.trim().toLowerCase(),
      family: family.family,
      accelerator: family.accelerator,
      matchedBy: family.matchedBy,
      region: resource.region.length > 0 ? resource.region : UNKNOWN_REGION,
      state: resource.state,
    });
  }
  entries.sort((a, b) => a.resourceKey.localeCompare(b.resourceKey, "en-US"));
  const byFamily = new Map<string, number>();
  for (const entry of entries) byFamily.set(entry.family, (byFamily.get(entry.family) ?? 0) + 1);
  return {
    entries,
    instanceCount: entries.length,
    notRunningCount: entries.filter((entry) => NOT_RUNNING.test(entry.state)).length,
    instanceTypeUnknownCount,
    byFamily: [...byFamily.entries()]
      .map(([family, instanceCount]) => ({ family, instanceCount }))
      .sort((a, b) => (a.instanceCount === b.instanceCount
        ? a.family.localeCompare(b.family, "en-US")
        : b.instanceCount - a.instanceCount)),
  };
}

/**
 * Idle GPUs from collected utilisation samples. With no usable sample — the
 * production case, since no GPU metrics collector exists — this returns an empty
 * candidate list and a status that names the missing collector. It NEVER falls
 * back to CPU utilisation or to a spend-based guess.
 */
function detectIdle(
  samples: readonly GpuUtilizationSample[],
  thresholds: GpuIdleThresholds,
  inventory: GpuInventory,
): { readonly status: GpuUtilizationStatus; readonly candidates: readonly GpuIdleCandidate[] } {
  const usable = samples.flatMap((sample) => (
    typeof sample.gpuUtilizationP95Percent === "number" && Number.isFinite(sample.gpuUtilizationP95Percent)
      ? [{ sample, percent: sample.gpuUtilizationP95Percent }]
      : []));
  if (usable.length === 0) {
    return {
      status: {
        collected: false,
        sampleCount: samples.length,
        usableSampleCount: 0,
        thresholds,
        reason: samples.length === 0 ? NO_UTILIZATION_REASON : NO_USABLE_UTILIZATION_REASON,
        requiredCollector: REQUIRED_COLLECTOR,
      },
      candidates: [],
    };
  }
  const instanceTypeByKey = new Map(inventory.entries.map((entry) => [entry.resourceKey, entry.instanceType]));
  const candidates = usable
    .filter(({ sample, percent }) =>
      percent < thresholds.maxGpuP95Percent && sample.sampleWindowDays >= thresholds.minSampleWindowDays)
    .map(({ sample, percent }) => {
      const memory = sample.gpuMemoryUtilizationP95Percent;
      return {
        resourceKey: sample.resourceKey,
        instanceType: instanceTypeByKey.get(sample.resourceKey) ?? null,
        gpuUtilizationP95Percent: percent,
        sampleWindowDays: sample.sampleWindowDays,
        evidence: `GPU p95 ${percent}% over ${sample.sampleWindowDays}d (below ${thresholds.maxGpuP95Percent}%)` +
          (memory === null || memory === undefined
            ? "; GPU memory utilisation not collected"
            : `; GPU memory p95 ${memory}%`),
      };
    })
    .sort((a, b) => (a.gpuUtilizationP95Percent === b.gpuUtilizationP95Percent
      ? a.resourceKey.localeCompare(b.resourceKey, "en-US")
      : a.gpuUtilizationP95Percent - b.gpuUtilizationP95Percent));
  return {
    status: {
      collected: true,
      sampleCount: samples.length,
      usableSampleCount: usable.length,
      thresholds,
      reason: null,
      requiredCollector: REQUIRED_COLLECTOR,
    },
    candidates,
  };
}

/**
 * Build the GPU/accelerator cost view.
 *
 * @param input billing lines, optional CMDB resources, and optional collected
 *   GPU utilisation samples (empty in production — see the file header).
 */
export function buildGpuCostView(input: GpuCostInput): GpuCostView {
  const thresholds: GpuIdleThresholds = { ...DEFAULT_GPU_IDLE_THRESHOLDS, ...input.thresholds };
  const inventory = buildInventory(input.resources ?? []);
  const idle = detectIdle(input.utilization ?? [], thresholds, inventory);
  const base = {
    schema: "sutra.finops-gpu-cost.v1" as const,
    inventory,
    utilization: idle.status,
    idleCandidates: idle.candidates,
    limitations: LIMITATIONS,
    disclaimer: GPU_COST_DISCLAIMER,
  };

  const priced = input.curLines.filter((line) => CURRENCY.test(line.currency));
  const usageTypePresent = priced.some((line) => line.usageType !== null);
  // Accelerated lines: a usage type that yields an accelerated instance type.
  const accelerated = priced.flatMap((line) => {
    if (line.usageType === null) return [];
    const instanceType = instanceTypeFromUsageType(line.usageType);
    if (instanceType === null) return [];
    const family = acceleratorFamily(instanceType);
    return family === null ? [] : [{ line, instanceType, family }];
  });
  const currenciesPresent = [...new Set(accelerated.map((entry) => entry.line.currency))]
    .sort((a, b) => a.localeCompare(b, "en-US"));
  const currency = pickCurrency(accelerated.map((entry) => entry.line));

  if (currency === null) {
    return {
      ...base,
      spendAvailable: false,
      spendUnavailableReason: priced.length === 0
        ? NO_LINES_REASON
        : usageTypePresent ? NO_GPU_SPEND_REASON : NO_USAGE_TYPE_REASON,
      usageTypePresent,
      currency: null,
      currenciesPresent,
      spendMicros: "0",
      spendUnits: 0,
      lineCount: 0,
      byFamily: [],
      byRegion: [],
      byAccelerator: [],
    };
  }

  let total = BigInt(0);
  let lineCount = 0;
  const byFamily = new Map<string, FamilyAccumulator>();
  const byRegion = new Map<string, { spend: bigint; lineCount: number }>();
  const byAccelerator = new Map<AcceleratorClass, bigint>();

  for (const entry of accelerated) {
    if (entry.line.currency !== currency) continue;
    const spend = BigInt(entry.line.amountMicros);
    const hours = billedHoursMicrosFor(entry.line);
    total += spend;
    lineCount += 1;

    const accumulator = byFamily.get(entry.family.family) ?? {
      spend: BigInt(0), hours: BigInt(0), lineCount: 0, hourLineCount: 0,
      accelerator: entry.family.accelerator, matchedBy: entry.family.matchedBy, instanceTypes: new Set<string>(),
    };
    accumulator.spend += spend;
    accumulator.lineCount += 1;
    if (hours !== null) {
      accumulator.hours += hours;
      accumulator.hourLineCount += 1;
    }
    accumulator.instanceTypes.add(entry.instanceType);
    byFamily.set(entry.family.family, accumulator);

    const regionKey = entry.line.region !== null && entry.line.region.length > 0 ? entry.line.region : UNKNOWN_REGION;
    const region = byRegion.get(regionKey) ?? { spend: BigInt(0), lineCount: 0 };
    region.spend += spend;
    region.lineCount += 1;
    byRegion.set(regionKey, region);

    byAccelerator.set(entry.family.accelerator, (byAccelerator.get(entry.family.accelerator) ?? BigInt(0)) + spend);
  }

  const families: readonly GpuFamilySpend[] = [...byFamily.entries()]
    .map(([family, accumulator]) => {
      const hoursComplete = accumulator.lineCount > 0 && accumulator.hourLineCount === accumulator.lineCount;
      return {
        family,
        accelerator: accumulator.accelerator,
        matchedBy: accumulator.matchedBy,
        spendMicros: accumulator.spend.toString(),
        spendUnits: unitsFromMicros(accumulator.spend),
        lineCount: accumulator.lineCount,
        billedHoursMicros: hoursComplete ? accumulator.hours.toString() : null,
        billedHours: hoursComplete ? unitsFromMicros(accumulator.hours) : null,
        instanceTypes: [...accumulator.instanceTypes].sort((a, b) => a.localeCompare(b, "en-US")),
      };
    })
    .sort((a, b) => {
      const spendA = BigInt(a.spendMicros);
      const spendB = BigInt(b.spendMicros);
      if (spendA !== spendB) return spendA > spendB ? -1 : 1;
      return a.family.localeCompare(b.family, "en-US");
    });

  const regions: readonly GpuRegionSpend[] = [...byRegion.entries()]
    .map(([region, accumulator]) => ({
      region,
      spendMicros: accumulator.spend.toString(),
      spendUnits: unitsFromMicros(accumulator.spend),
      lineCount: accumulator.lineCount,
    }))
    .sort((a, b) => {
      const spendA = BigInt(a.spendMicros);
      const spendB = BigInt(b.spendMicros);
      if (spendA !== spendB) return spendA > spendB ? -1 : 1;
      return a.region.localeCompare(b.region, "en-US");
    });

  const accelerators = [...byAccelerator.entries()]
    .map(([accelerator, spend]) => ({ accelerator, spendMicros: spend.toString(), spendUnits: unitsFromMicros(spend) }))
    .sort((a, b) => {
      const spendA = BigInt(a.spendMicros);
      const spendB = BigInt(b.spendMicros);
      if (spendA !== spendB) return spendA > spendB ? -1 : 1;
      return a.accelerator.localeCompare(b.accelerator, "en-US");
    });

  return {
    ...base,
    spendAvailable: lineCount > 0,
    spendUnavailableReason: lineCount > 0 ? null : NO_GPU_SPEND_REASON,
    usageTypePresent,
    currency,
    currenciesPresent,
    spendMicros: total.toString(),
    spendUnits: unitsFromMicros(total),
    lineCount,
    byFamily: families,
    byRegion: regions,
    byAccelerator: accelerators,
  };
}
