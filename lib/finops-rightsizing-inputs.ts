/**
 * Adapter: maps collected CloudWatch utilization samples, CMDB EC2 resources,
 * per-resource cost (supplied directly or derived from CUR/FOCUS lines via a
 * resource-identifying tag), and a bundled instance-family catalog into the
 * pure rightsizing engine's input.
 *
 * Honesty is preserved end-to-end: when a resource's current cost cannot be
 * derived it is simply omitted from the cost set (the engine then emits the
 * resource with a null saving and a disclosed reason — nothing is invented).
 * Money stays in integer micro-units; the currency travels with each cost.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import type { PilotResource } from "./pilot-types.ts";
import type {
  InstanceCatalogEntry,
  ResourceCost,
  RightsizingInput,
  UtilizationSample,
} from "./finops-rightsizing.ts";

/** A normalized utilization sample as produced by the collector's CloudWatch runner. */
export interface CollectedUtilizationSample {
  readonly resourceKey: string;
  readonly instanceId: string;
  readonly region: string;
  readonly instanceType: string | null;
  readonly cpuP95Percent: number | null;
  readonly networkP95BytesPerMinute: number | null;
  readonly memoryP95Percent: number | null;
  readonly sampleWindowDays: number;
}

export interface RightsizingAdapterInput {
  readonly utilization: readonly CollectedUtilizationSample[];
  /** Optional CMDB EC2 instances, used to fill in a missing instance type / region. */
  readonly resources?: readonly PilotResource[];
  /** Directly-supplied per-resource monthly on-demand cost (preferred, exact). */
  readonly resourceCosts?: readonly ResourceCost[];
  /** Optional CUR/FOCUS lines used to derive per-resource cost when a tag identifies the instance. */
  readonly curLines?: readonly NormalizedCurLine[];
  /** Tag key on the CUR line whose value equals the EC2 instance id (e.g. a resource-id tag). */
  readonly curResourceTagKey?: string;
  /** Override the bundled catalog (tests / custom pricing). */
  readonly catalog?: readonly InstanceCatalogEntry[];
}

/**
 * Bundled, conservative instance-family catalog. Costs are RELATIVE within a
 * family (proportional to on-demand price) — the engine applies the target/
 * current ratio to the observed cost, so only the ratios matter. Sizes double
 * per step, matching AWS's published per-size linear pricing within a family.
 */
export const BUNDLED_INSTANCE_CATALOG: readonly InstanceCatalogEntry[] = Object.freeze([
  // General purpose burstable (t3): base unit doubles each size up.
  entry("t3.nano", "t3", 2, 0.5, 1),
  entry("t3.micro", "t3", 2, 1, 2),
  entry("t3.small", "t3", 2, 2, 4),
  entry("t3.medium", "t3", 2, 4, 8),
  entry("t3.large", "t3", 2, 8, 16),
  entry("t3.xlarge", "t3", 4, 16, 32),
  entry("t3.2xlarge", "t3", 8, 32, 64),
  // General purpose (m5): large = base, doubling per step.
  entry("m5.large", "m5", 2, 8, 1),
  entry("m5.xlarge", "m5", 4, 16, 2),
  entry("m5.2xlarge", "m5", 8, 32, 4),
  entry("m5.4xlarge", "m5", 16, 64, 8),
  entry("m5.8xlarge", "m5", 32, 128, 16),
  entry("m5.12xlarge", "m5", 48, 192, 24),
  entry("m5.16xlarge", "m5", 64, 256, 32),
  entry("m5.24xlarge", "m5", 96, 384, 48),
  // Compute optimized (c5).
  entry("c5.large", "c5", 2, 4, 1),
  entry("c5.xlarge", "c5", 4, 8, 2),
  entry("c5.2xlarge", "c5", 8, 16, 4),
  entry("c5.4xlarge", "c5", 16, 32, 8),
  entry("c5.9xlarge", "c5", 36, 72, 18),
  entry("c5.12xlarge", "c5", 48, 96, 24),
  entry("c5.18xlarge", "c5", 72, 144, 36),
  entry("c5.24xlarge", "c5", 96, 192, 48),
  // Memory optimized (r5).
  entry("r5.large", "r5", 2, 16, 1),
  entry("r5.xlarge", "r5", 4, 32, 2),
  entry("r5.2xlarge", "r5", 8, 64, 4),
  entry("r5.4xlarge", "r5", 16, 128, 8),
  entry("r5.8xlarge", "r5", 32, 256, 16),
  entry("r5.12xlarge", "r5", 48, 384, 24),
  entry("r5.16xlarge", "r5", 64, 512, 32),
  entry("r5.24xlarge", "r5", 96, 768, 48),
]);

function entry(
  instanceType: string,
  family: string,
  vcpu: number,
  memGiB: number,
  relativeCost: number,
): InstanceCatalogEntry {
  return { instanceType, family, vcpu, memGiB, relativeCost };
}

const EC2_INSTANCE_TYPES = new Set(["aws.ec2.instance", "ec2.instance"]);
const MICROS = /^-?\d+$/u;

function instanceTypeFromResource(resource: PilotResource): string | null {
  const value = resource.configuration.instanceType;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isEc2Instance(resource: PilotResource): boolean {
  return EC2_INSTANCE_TYPES.has(resource.resourceType) || /ec2.*instance/iu.test(resource.resourceType);
}

/**
 * Derive per-resource monthly on-demand cost from CUR lines, summing on-demand
 * "Usage" lines whose identifying tag equals the instance id. Mixed currencies
 * for one resource are not merged — the dominant-currency total is not guessed;
 * a resource with lines in multiple currencies is skipped (no fabricated total).
 */
function costsFromCur(
  curLines: readonly NormalizedCurLine[],
  tagKey: string,
  instanceIds: ReadonlySet<string>,
  resourceKeyByInstanceId: ReadonlyMap<string, string>,
): ResourceCost[] {
  const byInstance = new Map<string, Map<string, bigint>>();
  for (const line of curLines) {
    if (line.chargeCategory.trim().toLowerCase() !== "usage") continue;
    const instanceId = line.tags[tagKey];
    if (instanceId === undefined || !instanceIds.has(instanceId)) continue;
    if (!MICROS.test(line.amountMicros)) continue;
    const amount = BigInt(line.amountMicros);
    if (amount <= BigInt(0)) continue;
    const perCurrency = byInstance.get(instanceId) ?? new Map<string, bigint>();
    perCurrency.set(line.currency, (perCurrency.get(line.currency) ?? BigInt(0)) + amount);
    byInstance.set(instanceId, perCurrency);
  }
  const costs: ResourceCost[] = [];
  for (const [instanceId, perCurrency] of byInstance) {
    if (perCurrency.size !== 1) continue; // ambiguous currency — do not guess a total
    const resourceKey = resourceKeyByInstanceId.get(instanceId) ?? instanceId;
    const [currency, micros] = [...perCurrency.entries()][0];
    costs.push({ resourceKey, currency, currentMonthlyCostMicros: micros.toString() });
  }
  return costs;
}

export function buildRightsizingInput(input: RightsizingAdapterInput): RightsizingInput {
  const catalog = input.catalog ?? BUNDLED_INSTANCE_CATALOG;

  // Index CMDB EC2 resources by instance id (nativeId) to backfill type/region.
  const resourceByInstanceId = new Map<string, PilotResource>();
  const resourceKeyByInstanceId = new Map<string, string>();
  for (const resource of input.resources ?? []) {
    if (!isEc2Instance(resource)) continue;
    if (!resourceByInstanceId.has(resource.nativeId)) resourceByInstanceId.set(resource.nativeId, resource);
    if (!resourceKeyByInstanceId.has(resource.nativeId)) resourceKeyByInstanceId.set(resource.nativeId, resource.resourceKey);
  }

  const samples: UtilizationSample[] = input.utilization.map((collected) => {
    const resource = resourceByInstanceId.get(collected.instanceId) ?? null;
    const currentInstanceType =
      collected.instanceType ?? (resource === null ? "" : instanceTypeFromResource(resource) ?? "");
    const region = collected.region.length > 0 ? collected.region : resource?.region ?? "";
    return {
      resourceKey: collected.resourceKey,
      currentInstanceType,
      region,
      cpuP95Percent: collected.cpuP95Percent,
      networkP95BytesPerMinute: collected.networkP95BytesPerMinute,
      memoryP95Percent: collected.memoryP95Percent,
      sampleWindowDays: collected.sampleWindowDays,
    };
  });

  const costs: ResourceCost[] = [];
  const seenCostKeys = new Set<string>();
  for (const cost of input.resourceCosts ?? []) {
    if (!MICROS.test(cost.currentMonthlyCostMicros) || !/^[A-Z]{3}$/u.test(cost.currency)) continue;
    if (seenCostKeys.has(cost.resourceKey)) continue;
    seenCostKeys.add(cost.resourceKey);
    costs.push(cost);
  }
  if (input.curLines !== undefined && input.curResourceTagKey !== undefined && input.curResourceTagKey.length > 0) {
    const instanceIds = new Set(input.utilization.map((sample) => sample.instanceId));
    const keyByInstanceId = new Map<string, string>(resourceKeyByInstanceId);
    for (const sample of input.utilization) {
      if (!keyByInstanceId.has(sample.instanceId)) keyByInstanceId.set(sample.instanceId, sample.resourceKey);
    }
    for (const derived of costsFromCur(input.curLines, input.curResourceTagKey, instanceIds, keyByInstanceId)) {
      if (seenCostKeys.has(derived.resourceKey)) continue; // direct cost wins
      seenCostKeys.add(derived.resourceKey);
      costs.push(derived);
    }
  }

  return { samples, costs, catalog };
}
