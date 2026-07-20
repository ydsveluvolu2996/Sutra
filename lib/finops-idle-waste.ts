/**
 * Pure, deterministic idle / waste detection over collected CMDB evidence and
 * (optionally) ingested CUR/FOCUS billing lines.
 *
 * It flags five well-understood sources of recurring cloud waste:
 *   - unattached EBS volumes (allocated storage with no attachment),
 *   - idle / empty load balancers (running but with no healthy targets),
 *   - unused Elastic IPs (allocated but not associated),
 *   - stopped-but-still-billing instances (compute is $0 while stopped, yet
 *     attached EBS storage keeps billing),
 *   - orphaned snapshots (the source volume is gone).
 *
 * Evidence-honesty rules (never relaxed):
 * - A monthly `$` is attached to a finding ONLY when it is derivable: either
 *   from a per-resource CUR/FOCUS cost the adapter has already joined (basis
 *   "cur-line-items"), or from a bundled, conservative published list price for
 *   that resource type applied to a collected sizing attribute (basis
 *   "bundled-list-price"). When neither is derivable the amount is `null` and
 *   the reason is disclosed. A number is NEVER invented.
 * - Bundled list prices are USD us-east-1 published rates, labelled an INPUT and
 *   an ESTIMATE, never a quote. The basis is always disclosed on each finding.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n). Currencies
 *   are never summed together — waste totals are per-currency.
 * - The predicate that makes a resource "waste" is applied here (deterministic
 *   and testable); the adapter only shapes collected metadata into inputs.
 */
export type IdleWasteCategory =
  | "unattached-ebs-volume"
  | "idle-load-balancer"
  | "unused-elastic-ip"
  | "stopped-instance-billing"
  | "orphaned-snapshot";

export type IdleWasteSeverity = "low" | "medium" | "high";

/** How a finding's monthly `$` was derived (or that it could not be). */
export type IdleWasteCostBasis = "cur-line-items" | "bundled-list-price" | "none";

/** A per-resource monthly cost the adapter has already joined from CUR lines. */
export interface DerivedCurCost {
  readonly currency: string;
  readonly monthlyMicros: string;
}

interface BaseWasteResource {
  readonly resourceKey: string;
  readonly region: string | null;
  readonly name: string | null;
  /**
   * Optional per-resource CUR/FOCUS monthly cost the adapter joined for THIS
   * exact resource (preferred, exact). When present it is used verbatim and the
   * basis is "cur-line-items"; the bundled price is only a fallback.
   */
  readonly curCost?: DerivedCurCost | null;
}

export interface UnattachedVolumeInput extends BaseWasteResource {
  /** True only when the volume has at least one live attachment. */
  readonly attached: boolean;
  readonly sizeGiB: number | null;
  readonly volumeType: string | null;
}

export interface IdleLoadBalancerInput extends BaseWasteResource {
  readonly loadBalancerType: string | null;
  /** Healthy registered targets across all of this balancer's target groups. */
  readonly healthyTargetCount: number;
  readonly registeredTargetCount: number;
}

export interface UnusedElasticIpInput extends BaseWasteResource {
  /** False => the address is allocated but not associated with anything. */
  readonly associated: boolean;
}

export interface StoppedInstanceInput extends BaseWasteResource {
  /** True only when the instance is in a stopped/deallocated state. */
  readonly stopped: boolean;
  /** Total attached EBS storage (GiB), when the attachment sizes were collected. */
  readonly attachedVolumeGiB: number | null;
  readonly instanceType: string | null;
}

export interface OrphanedSnapshotInput extends BaseWasteResource {
  /** False => the snapshot's source volume no longer exists. */
  readonly sourceVolumeExists: boolean;
  /** Source volume size (GiB); an UPPER BOUND on billed incremental storage. */
  readonly volumeSizeGiB: number | null;
}

export interface IdleWastePricing {
  /** EBS gp3 storage, USD micro-units per GiB-month (us-east-1 list). */
  readonly ebsGiBMonthMicros: string;
  /** EBS snapshot storage, USD micro-units per GiB-month (us-east-1 list). */
  readonly snapshotGiBMonthMicros: string;
  /** Idle/unassociated Elastic IP, USD micro-units per month (0.005/hr * 720). */
  readonly elasticIpMonthMicros: string;
  /** Application/Gateway Load Balancer fixed hourly component, USD micros/month. */
  readonly albMonthMicros: string;
  /** Network Load Balancer fixed hourly component, USD micros/month. */
  readonly nlbMonthMicros: string;
}

export interface IdleWasteInput {
  readonly volumes?: readonly UnattachedVolumeInput[];
  readonly loadBalancers?: readonly IdleLoadBalancerInput[];
  readonly elasticIps?: readonly UnusedElasticIpInput[];
  readonly stoppedInstances?: readonly StoppedInstanceInput[];
  readonly snapshots?: readonly OrphanedSnapshotInput[];
  /** Override the bundled pricing (tests / region-specific pricing). */
  readonly pricing?: Partial<IdleWastePricing>;
}

export interface IdleWasteFinding {
  readonly id: string;
  readonly category: IdleWasteCategory;
  readonly severity: IdleWasteSeverity;
  readonly resourceKey: string;
  readonly region: string | null;
  readonly title: string;
  readonly summary: string;
  /** ISO 4217 code for the estimate; null when no estimate is derivable. */
  readonly currency: string | null;
  /** Integer micro-units, or null when not derivable (reason disclosed). */
  readonly estimatedMonthlyWasteMicros: string | null;
  readonly costBasis: IdleWasteCostBasis;
  /** Discloses the pricing assumption OR why no estimate is derivable. */
  readonly basisReason: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

export interface IdleWasteReport {
  readonly schema: "sutra.finops-idle-waste.v1";
  readonly findings: readonly IdleWasteFinding[];
  readonly summary: {
    readonly count: number;
    readonly byCategory: Readonly<Record<IdleWasteCategory, number>>;
    /** Derivable waste totalled per currency — never summed across currencies. */
    readonly wasteByCurrencyMicros: Readonly<Record<string, string>>;
    readonly findingsWithoutEstimate: number;
  };
  readonly pricingBasis: IdleWastePricing;
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

// Conservative, publicly documented us-east-1 list prices, expressed in USD
// micro-units. They are a labelled ESTIMATE input, never an AWS quote.
export const DEFAULT_IDLE_WASTE_PRICING: IdleWastePricing = {
  ebsGiBMonthMicros: "80000", // $0.08 / GiB-month (gp3)
  snapshotGiBMonthMicros: "50000", // $0.05 / GiB-month
  elasticIpMonthMicros: "3600000", // $3.60 / month (0.005/hr * 720)
  albMonthMicros: "16200000", // ~$16.20 / month fixed ALB hours (0.0225/hr * 720)
  nlbMonthMicros: "16200000", // ~$16.20 / month fixed NLB hours
};

const BUNDLED_PRICING_CURRENCY = "USD";

export const IDLE_WASTE_DISCLAIMER =
  "Idle/waste findings are derived from collected CMDB metadata and, when " +
  "present, ingested CUR/FOCUS billing lines. A monthly cost is shown only when " +
  "derivable: from per-resource CUR line items (exact) or a bundled conservative " +
  "USD us-east-1 published list price applied to a collected sizing attribute " +
  "(an ESTIMATE input, not a quote). Where neither is derivable no figure is " +
  "claimed and the reason is disclosed. Waste is totalled per currency and never " +
  "summed across currencies. Review each item against the workload before acting.";

const REASON_CUR = "DERIVED_FROM_PER_RESOURCE_CUR_LINE_ITEMS";
const REASON_BUNDLED_EBS =
  "ESTIMATE_FROM_BUNDLED_EBS_LIST_PRICE_USD_APPLIED_TO_COLLECTED_VOLUME_SIZE_NOT_A_QUOTE";
const REASON_BUNDLED_SNAPSHOT =
  "ESTIMATE_FROM_BUNDLED_SNAPSHOT_LIST_PRICE_USD_UPPER_BOUND_ON_SOURCE_VOLUME_SIZE_ACTUAL_INCREMENTAL_MAY_BE_LOWER";
const REASON_BUNDLED_EIP =
  "ESTIMATE_FROM_BUNDLED_UNASSOCIATED_ELASTIC_IP_LIST_PRICE_USD_NOT_A_QUOTE";
const REASON_BUNDLED_LB =
  "ESTIMATE_FROM_BUNDLED_LOAD_BALANCER_FIXED_HOURLY_LIST_PRICE_USD_EXCLUDES_LCU_AND_DATA_PROCESSING";
const REASON_NO_VOLUME_SIZE = "VOLUME_SIZE_NOT_COLLECTED_NO_ESTIMATE_CLAIMED";
const REASON_NO_SNAPSHOT_SIZE = "SNAPSHOT_SOURCE_VOLUME_SIZE_NOT_COLLECTED_NO_ESTIMATE_CLAIMED";
const REASON_NO_ATTACHED_SIZE =
  "STOPPED_INSTANCE_ATTACHED_EBS_SIZE_NOT_COLLECTED_NO_ESTIMATE_CLAIMED_COMPUTE_IS_ZERO_WHILE_STOPPED";
const REASON_NO_LB_TYPE = "LOAD_BALANCER_TYPE_NOT_COLLECTED_NO_BUNDLED_PRICE_NO_ESTIMATE_CLAIMED";

const LIMITATIONS: readonly string[] = [
  "COST_IS_DERIVED_ONLY_FROM_CUR_LINE_ITEMS_OR_BUNDLED_LIST_PRICE_NEVER_INVENTED",
  "BUNDLED_PRICES_ARE_USD_US_EAST_1_LIST_PRICES_AN_ESTIMATE_INPUT_NOT_A_QUOTE",
  "SNAPSHOT_ESTIMATE_USES_SOURCE_VOLUME_SIZE_AS_AN_UPPER_BOUND_ON_INCREMENTAL_STORAGE",
  "LOAD_BALANCER_ESTIMATE_EXCLUDES_LCU_AND_DATA_PROCESSING_CHARGES",
  "WASTE_IS_TOTALLED_PER_CURRENCY_AND_NEVER_SUMMED_ACROSS_CURRENCIES",
];

const MICROS = /^-?\d+$/u;

function resolvePricing(overrides?: Partial<IdleWastePricing>): IdleWastePricing {
  return {
    ebsGiBMonthMicros: overrides?.ebsGiBMonthMicros ?? DEFAULT_IDLE_WASTE_PRICING.ebsGiBMonthMicros,
    snapshotGiBMonthMicros:
      overrides?.snapshotGiBMonthMicros ?? DEFAULT_IDLE_WASTE_PRICING.snapshotGiBMonthMicros,
    elasticIpMonthMicros:
      overrides?.elasticIpMonthMicros ?? DEFAULT_IDLE_WASTE_PRICING.elasticIpMonthMicros,
    albMonthMicros: overrides?.albMonthMicros ?? DEFAULT_IDLE_WASTE_PRICING.albMonthMicros,
    nlbMonthMicros: overrides?.nlbMonthMicros ?? DEFAULT_IDLE_WASTE_PRICING.nlbMonthMicros,
  };
}

/** A CUR cost is used only when the currency and micro amount are both well-formed. */
function curEstimate(cost: DerivedCurCost | null | undefined): { currency: string; micros: string } | null {
  if (cost === null || cost === undefined) return null;
  if (!/^[A-Z]{3}$/u.test(cost.currency) || !MICROS.test(cost.monthlyMicros)) return null;
  if (BigInt(cost.monthlyMicros) < BigInt(0)) return null;
  return { currency: cost.currency, micros: cost.monthlyMicros };
}

function bundledFromGiB(sizeGiB: number | null, perGiBMicros: string): string | null {
  if (sizeGiB === null || !Number.isFinite(sizeGiB) || sizeGiB <= 0) return null;
  // Integer GiB only — never fabricate fractional storage we did not observe.
  return (BigInt(Math.trunc(sizeGiB)) * BigInt(perGiBMicros)).toString();
}

interface Estimate {
  readonly currency: string | null;
  readonly micros: string | null;
  readonly basis: IdleWasteCostBasis;
  readonly reason: string;
}

export function buildIdleWaste(input: IdleWasteInput): IdleWasteReport {
  const pricing = resolvePricing(input.pricing);
  const findings: IdleWasteFinding[] = [];

  for (const volume of input.volumes ?? []) {
    if (volume.attached) continue;
    const cur = curEstimate(volume.curCost);
    const estimate: Estimate = cur !== null
      ? { currency: cur.currency, micros: cur.micros, basis: "cur-line-items", reason: REASON_CUR }
      : bundle(bundledFromGiB(volume.sizeGiB, pricing.ebsGiBMonthMicros), REASON_BUNDLED_EBS, REASON_NO_VOLUME_SIZE);
    findings.push({
      id: `idle-waste-unattached-volume-${volume.resourceKey}`,
      category: "unattached-ebs-volume",
      severity: (volume.sizeGiB ?? 0) >= 500 ? "high" : "medium",
      resourceKey: volume.resourceKey,
      region: volume.region,
      title: `Unattached EBS volume${volume.name ? ` ${volume.name}` : ""} is billing for allocated storage`,
      summary: "The volume has no live attachment yet keeps billing for provisioned storage. Snapshot then delete it if the data is no longer needed.",
      ...estimateFields(estimate),
      evidence: compactEvidence({
        sizeGiB: volume.sizeGiB ?? undefined,
        volumeType: volume.volumeType ?? undefined,
        attached: false,
      }),
    });
  }

  for (const balancer of input.loadBalancers ?? []) {
    if (balancer.healthyTargetCount > 0) continue;
    const cur = curEstimate(balancer.curCost);
    const estimate = cur !== null
      ? { currency: cur.currency, micros: cur.micros, basis: "cur-line-items" as const, reason: REASON_CUR }
      : bundle(bundledLbPrice(balancer.loadBalancerType, pricing), REASON_BUNDLED_LB, REASON_NO_LB_TYPE);
    findings.push({
      id: `idle-waste-idle-load-balancer-${balancer.resourceKey}`,
      category: "idle-load-balancer",
      severity: "medium",
      resourceKey: balancer.resourceKey,
      region: balancer.region,
      title: `Load balancer${balancer.name ? ` ${balancer.name}` : ""} has no healthy targets`,
      summary: "The balancer is provisioned (and billing hourly) but serves no healthy backend. Remove it or attach targets.",
      ...estimateFields(estimate),
      evidence: compactEvidence({
        loadBalancerType: balancer.loadBalancerType ?? undefined,
        healthyTargetCount: balancer.healthyTargetCount,
        registeredTargetCount: balancer.registeredTargetCount,
      }),
    });
  }

  for (const address of input.elasticIps ?? []) {
    if (address.associated) continue;
    const cur = curEstimate(address.curCost);
    const estimate: Estimate = cur !== null
      ? { currency: cur.currency, micros: cur.micros, basis: "cur-line-items", reason: REASON_CUR }
      : { currency: BUNDLED_PRICING_CURRENCY, micros: pricing.elasticIpMonthMicros, basis: "bundled-list-price", reason: REASON_BUNDLED_EIP };
    findings.push({
      id: `idle-waste-unused-elastic-ip-${address.resourceKey}`,
      category: "unused-elastic-ip",
      severity: "low",
      resourceKey: address.resourceKey,
      region: address.region,
      title: `Elastic IP${address.name ? ` ${address.name}` : ""} is allocated but not associated`,
      summary: "An allocated Elastic IP that is not associated with a running resource bills hourly. Release it if unused.",
      ...estimateFields(estimate),
      evidence: compactEvidence({ associated: false }),
    });
  }

  for (const instance of input.stoppedInstances ?? []) {
    if (!instance.stopped) continue;
    const cur = curEstimate(instance.curCost);
    const estimate = cur !== null
      ? { currency: cur.currency, micros: cur.micros, basis: "cur-line-items" as const, reason: REASON_CUR }
      : bundle(bundledFromGiB(instance.attachedVolumeGiB, pricing.ebsGiBMonthMicros), REASON_BUNDLED_EBS, REASON_NO_ATTACHED_SIZE);
    findings.push({
      id: `idle-waste-stopped-instance-${instance.resourceKey}`,
      category: "stopped-instance-billing",
      severity: "medium",
      resourceKey: instance.resourceKey,
      region: instance.region,
      title: `Stopped instance${instance.name ? ` ${instance.name}` : ""} still bills for attached EBS`,
      summary: "Compute is $0 while stopped, but attached EBS storage keeps billing. Snapshot-and-terminate if the instance is not needed.",
      ...estimateFields(estimate),
      evidence: compactEvidence({
        stopped: true,
        instanceType: instance.instanceType ?? undefined,
        attachedVolumeGiB: instance.attachedVolumeGiB ?? undefined,
      }),
    });
  }

  for (const snapshot of input.snapshots ?? []) {
    if (snapshot.sourceVolumeExists) continue;
    const cur = curEstimate(snapshot.curCost);
    const estimate = cur !== null
      ? { currency: cur.currency, micros: cur.micros, basis: "cur-line-items" as const, reason: REASON_CUR }
      : bundle(bundledFromGiB(snapshot.volumeSizeGiB, pricing.snapshotGiBMonthMicros), REASON_BUNDLED_SNAPSHOT, REASON_NO_SNAPSHOT_SIZE);
    findings.push({
      id: `idle-waste-orphaned-snapshot-${snapshot.resourceKey}`,
      category: "orphaned-snapshot",
      severity: (snapshot.volumeSizeGiB ?? 0) >= 500 ? "high" : "low",
      resourceKey: snapshot.resourceKey,
      region: snapshot.region,
      title: `Orphaned snapshot${snapshot.name ? ` ${snapshot.name}` : ""} has no source volume`,
      summary: "The snapshot's source volume no longer exists. Delete it if it is not part of a retention policy or restore plan.",
      ...estimateFields(estimate),
      evidence: compactEvidence({
        sourceVolumeExists: false,
        volumeSizeGiB: snapshot.volumeSizeGiB ?? undefined,
      }),
    });
  }

  const rank: Readonly<Record<IdleWasteSeverity, number>> = { high: 0, medium: 1, low: 2 };
  findings.sort((left, right) => rank[left.severity] - rank[right.severity] || left.id.localeCompare(right.id, "en-US"));

  const byCategory: Record<IdleWasteCategory, number> = {
    "unattached-ebs-volume": 0,
    "idle-load-balancer": 0,
    "unused-elastic-ip": 0,
    "stopped-instance-billing": 0,
    "orphaned-snapshot": 0,
  };
  const wasteByCurrency: Record<string, bigint> = {};
  let findingsWithoutEstimate = 0;
  for (const finding of findings) {
    byCategory[finding.category] += 1;
    if (finding.estimatedMonthlyWasteMicros !== null && finding.currency !== null) {
      wasteByCurrency[finding.currency] =
        (wasteByCurrency[finding.currency] ?? BigInt(0)) + BigInt(finding.estimatedMonthlyWasteMicros);
    } else {
      findingsWithoutEstimate += 1;
    }
  }
  const wasteByCurrencyMicros: Record<string, string> = {};
  for (const currency of Object.keys(wasteByCurrency).sort((a, b) => a.localeCompare(b, "en-US"))) {
    wasteByCurrencyMicros[currency] = wasteByCurrency[currency].toString();
  }

  return {
    schema: "sutra.finops-idle-waste.v1",
    findings,
    summary: {
      count: findings.length,
      byCategory,
      wasteByCurrencyMicros,
      findingsWithoutEstimate,
    },
    pricingBasis: pricing,
    limitations: LIMITATIONS,
    disclaimer: IDLE_WASTE_DISCLAIMER,
  };
}

function bundle(micros: string | null, reasonWhenPriced: string, reasonWhenNull: string): Estimate {
  return micros === null
    ? { currency: null, micros: null, basis: "none", reason: reasonWhenNull }
    : { currency: BUNDLED_PRICING_CURRENCY, micros, basis: "bundled-list-price", reason: reasonWhenPriced };
}

function bundledLbPrice(type: string | null, pricing: IdleWastePricing): string | null {
  if (type === null) return null;
  const normalized = type.trim().toLowerCase();
  if (normalized === "network" || normalized === "gateway") return pricing.nlbMonthMicros;
  if (normalized === "application") return pricing.albMonthMicros;
  return null;
}

function estimateFields(estimate: Estimate): Pick<
  IdleWasteFinding,
  "currency" | "estimatedMonthlyWasteMicros" | "costBasis" | "basisReason"
> {
  return {
    currency: estimate.currency,
    estimatedMonthlyWasteMicros: estimate.micros,
    costBasis: estimate.basis,
    basisReason: estimate.reason,
  };
}

function compactEvidence(
  values: Readonly<Record<string, string | number | boolean | undefined>>,
): Readonly<Record<string, string | number | boolean>> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
