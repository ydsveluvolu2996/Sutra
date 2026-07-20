/**
 * Pure, deterministic Kubernetes cost-allocation engine.
 *
 * It splits a cluster's already-known node/compute cost across the cluster's
 * namespaces (and optionally workloads) using each namespace's summed pod
 * CPU + memory REQUESTS as the allocation key. Requests are the reserved
 * capacity a scheduler honours, so they are the defensible weighting basis
 * (an OpenCost/Kubecost-style request-share model) rather than live usage,
 * which this codebase does not collect.
 *
 * WHAT IS AND IS NOT COLLECTED (honesty preamble):
 * - The persisted Kubernetes evidence snapshot records only whether a container
 *   HAS a cpu/memory request (a boolean), NOT the numeric quantity, and it does
 *   NOT collect Node objects or a node -> EC2 instance mapping. Therefore the
 *   numeric request weights, the optional allocatable node capacity, and the
 *   per-cluster node cost are all INPUTS to this engine — never invented here.
 *   Where a needed figure is absent the engine DISCLOSES it (null + reason) and
 *   fabricates nothing.
 *
 * Evidence-honesty rules (never relaxed):
 * - Node/compute cost per cluster is supplied per currency. When it is NOT
 *   derivable (no per-currency cost map, or an empty one) the cluster's
 *   allocatable cost is unavailable: `costAvailable = false`, reason
 *   "node-cost-not-derivable", and NO namespace cost figures are produced.
 * - Currencies are NEVER summed together. Allocation runs independently per
 *   currency over the SAME (currency-independent) request weights.
 * - Idle / unallocated capacity is ALWAYS shown explicitly and never hidden or
 *   redistributed: `unallocatedMicros = clusterCostMicros - sum(allocated)` by
 *   construction. When the cluster's allocatable node capacity is supplied and
 *   exceeds total requests, that remainder is genuine idle headroom
 *   ("idle-from-allocatable-capacity"). When capacity is not supplied the full
 *   cost is spread over requests (remainder 0) and the zero is disclosed as
 *   "capacity-not-collected-idle-not-measured" — never as a measured zero. When
 *   requests meet or exceed capacity the cluster is over-committed
 *   ("over-committed-no-idle").
 * - The weighting basis is disclosed per cluster: a normalized cpu/memory blend
 *   when both request dimensions are collected for every contributing namespace,
 *   "cpu-only" when memory requests are absent (fully or partially — a blend
 *   would be inconsistent), "memory-only" when only memory is present, or null
 *   ("no-namespace-requests") when nothing is collected (whole cost is idle).
 * - Namespaces with zero requests are disclosed (0 weight -> 0 allocation,
 *   `zeroRequests: true`), never dropped.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n). Allocation is
 *   floor-division integer math; rounding dust falls into the disclosed
 *   unallocated remainder rather than being spread to fabricate exactness.
 * - The clock is INJECTED (`now`); Date.now() is never called. `generatedAt` is
 *   null unless a clock is supplied.
 */

/** Per-workload request contribution within a namespace (optional finer split). */
export interface WorkloadRequests {
  readonly workload: string;
  readonly workloadKind?: string;
  /** Summed pod CPU requests in millicores; null when not collected. */
  readonly cpuRequestMillicores: number | null;
  /** Summed pod memory requests in bytes; null when not collected. */
  readonly memoryRequestBytes: number | null;
}

/** One namespace's summed pod requests (the allocation weight source). */
export interface NamespaceRequests {
  readonly namespace: string;
  /** Summed pod CPU requests in millicores; null when not collected. */
  readonly cpuRequestMillicores: number | null;
  /** Summed pod memory requests in bytes; null when not collected. */
  readonly memoryRequestBytes: number | null;
  /** Optional per-workload breakdown (used only when options.includeWorkloads). */
  readonly workloads?: readonly WorkloadRequests[];
}

/** Total allocatable node capacity for the cluster (from Node objects, if collected). */
export interface ClusterCapacity {
  /** Total allocatable CPU across the cluster's nodes, millicores; null when not collected. */
  readonly cpuMillicores: number | null;
  /** Total allocatable memory across the cluster's nodes, bytes; null when not collected. */
  readonly memoryBytes: number | null;
}

export interface ClusterAllocationInput {
  readonly clusterId: string;
  /**
   * Per-currency node/compute cost attributable to this cluster's nodes, in
   * integer micro-units (bigint-safe strings). `null` or an empty map means the
   * node -> cost mapping was not derivable — the engine then discloses
   * "node-cost-not-derivable" and produces no namespace cost figures.
   */
  readonly nodeCostMicrosByCurrency: Readonly<Record<string, string>> | null;
  readonly namespaces: readonly NamespaceRequests[];
  /** Optional total allocatable node capacity; enables genuine idle measurement. */
  readonly capacity?: ClusterCapacity;
}

export interface KubernetesAllocationInput {
  readonly clusters: readonly ClusterAllocationInput[];
}

export interface KubernetesAllocationOptions {
  /** Injected clock; never defaults to Date.now(). Only used to stamp generatedAt. */
  readonly now?: () => Date;
  /**
   * CPU share of the blended cost pool, in per-mille (0..1000, default 500 =>
   * 50/50 cpu/memory). Memory receives the remainder. Ignored for single-basis
   * clusters (cpu-only / memory-only).
   */
  readonly cpuWeightPermille?: number;
  /** Emit a per-workload sub-allocation inside each namespace when true. */
  readonly includeWorkloads?: boolean;
}

export type AllocationBasis = "cpu-memory-blend" | "cpu-only" | "memory-only";

export type UnallocatedBasis =
  | "idle-from-allocatable-capacity"
  | "over-committed-no-idle"
  | "capacity-not-collected-idle-not-measured";

export interface WorkloadAllocation {
  readonly workload: string;
  readonly workloadKind: string | null;
  readonly cpuRequestMillicores: number | null;
  readonly memoryRequestBytes: number | null;
  readonly allocatedMicros: string;
  readonly zeroRequests: boolean;
}

export interface NamespaceAllocation {
  readonly namespace: string;
  readonly cpuRequestMillicores: number | null;
  readonly memoryRequestBytes: number | null;
  readonly allocatedMicros: string;
  /** Namespace share of this currency's cluster cost, in per-mille (informational). */
  readonly sharePermille: number;
  /** True when the namespace has no positive requests in the active basis. */
  readonly zeroRequests: boolean;
  /** Per-workload split; null unless options.includeWorkloads was set. */
  readonly workloads: readonly WorkloadAllocation[] | null;
}

export interface CurrencyAllocation {
  readonly currency: string;
  readonly clusterCostMicros: string;
  /** Sum of namespace allocations in micros. */
  readonly allocatedMicros: string;
  /** clusterCost - allocated; the disclosed idle / unallocated remainder. */
  readonly unallocatedMicros: string;
  readonly unallocatedBasis: UnallocatedBasis;
  readonly namespaces: readonly NamespaceAllocation[];
}

export interface ClusterAllocation {
  readonly clusterId: string;
  /** True when a per-currency node cost was derivable for this cluster. */
  readonly costAvailable: boolean;
  /** Reason when cost is unavailable ("node-cost-not-derivable"); else null. */
  readonly unavailableReason: string | null;
  /** The weighting basis actually used, or null when there are no requests. */
  readonly basis: AllocationBasis | null;
  /** Human/machine reason explaining the basis choice (e.g. memory absent). */
  readonly basisReason: string;
  readonly namespacesEvaluated: number;
  /** Cluster-wide summed requests (real observed inputs, per basis dimension). */
  readonly totalCpuRequestMillicores: number | null;
  readonly totalMemoryRequestBytes: number | null;
  /** Allocatable capacity echoed back when supplied; null when not collected. */
  readonly allocatableCpuMillicores: number | null;
  readonly allocatableMemoryBytes: number | null;
  /** Per-currency allocation series; empty when cost is unavailable. */
  readonly currencies: readonly CurrencyAllocation[];
}

export interface KubernetesAllocationReport {
  readonly schema: "sutra.finops-k8s-allocation.v1";
  readonly clusters: readonly ClusterAllocation[];
  readonly generatedAt: string | null;
  readonly options: {
    readonly cpuWeightPermille: number;
    readonly memoryWeightPermille: number;
    readonly includeWorkloads: boolean;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

export const K8S_ALLOCATION_DISCLAIMER =
  "Kubernetes cost allocation splits an already-known cluster node/compute cost across " +
  "namespaces using summed pod CPU/memory REQUESTS as the weighting key (reserved capacity, " +
  "not live usage — usage is not collected). Costs are allocated per currency; currencies are " +
  "never summed together. Idle / unallocated capacity is shown explicitly as clusterCost minus " +
  "the sum of allocations and is never redistributed; genuine idle is measured only when the " +
  "cluster's allocatable node capacity is supplied. When the node -> cost mapping is not " +
  "derivable the cluster's allocatable cost is disclosed as unavailable and no namespace figures " +
  "are produced. This is a planning ESTIMATE, not an invoice or an AWS quote.";

const REASON_NODE_COST_NOT_DERIVABLE = "node-cost-not-derivable";
const BASIS_REASON_BLEND = "BOTH_CPU_AND_MEMORY_REQUESTS_COLLECTED_FOR_EVERY_CONTRIBUTING_NAMESPACE";
const BASIS_REASON_CPU_ONLY_NO_MEMORY = "MEMORY_REQUESTS_NOT_COLLECTED_ALLOCATION_IS_CPU_ONLY";
const BASIS_REASON_CPU_ONLY_PARTIAL_MEMORY =
  "MEMORY_REQUESTS_ONLY_PARTIALLY_COLLECTED_BLEND_WOULD_BE_INCONSISTENT_ALLOCATION_IS_CPU_ONLY";
const BASIS_REASON_MEMORY_ONLY = "CPU_REQUESTS_NOT_COLLECTED_ALLOCATION_IS_MEMORY_ONLY";
const BASIS_REASON_NONE = "NO_NAMESPACE_REQUESTS_COLLECTED_WHOLE_CLUSTER_COST_IS_UNALLOCATED";

const LIMITATIONS: readonly string[] = [
  "COLLECTOR_RECORDS_ONLY_WHETHER_A_REQUEST_EXISTS_NOT_ITS_QUANTITY_QUANTITIES_ARE_SUPPLIED_INPUTS",
  "NODE_OBJECTS_AND_NODE_TO_EC2_INSTANCE_MAPPING_ARE_NOT_COLLECTED_NODE_COST_IS_A_SUPPLIED_INPUT",
  "ALLOCATION_KEY_IS_POD_REQUESTS_RESERVED_CAPACITY_NOT_MEASURED_LIVE_USAGE",
  "CURRENCIES_ARE_NEVER_SUMMED_ALLOCATION_RUNS_PER_CURRENCY",
  "IDLE_IS_MEASURED_ONLY_WHEN_ALLOCATABLE_NODE_CAPACITY_IS_SUPPLIED_ELSE_DISCLOSED_AS_NOT_MEASURED",
  "WHEN_NODE_COST_IS_NOT_DERIVABLE_NO_NAMESPACE_FIGURES_ARE_FABRICATED",
];

const MICROS_INT = /^-?\d+$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;

function isPositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeIntBig(value: number | null | undefined): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return BigInt(0);
  return BigInt(Math.round(value));
}

function resolveOptions(options?: KubernetesAllocationOptions): {
  readonly cpuWeightPermille: number;
  readonly memoryWeightPermille: number;
  readonly includeWorkloads: boolean;
} {
  let cpu = Math.trunc(options?.cpuWeightPermille ?? 500);
  if (!Number.isFinite(cpu)) cpu = 500;
  cpu = Math.max(0, Math.min(1000, cpu));
  return {
    cpuWeightPermille: cpu,
    memoryWeightPermille: 1000 - cpu,
    includeWorkloads: options?.includeWorkloads === true,
  };
}

interface BasisDecision {
  readonly basis: AllocationBasis | null;
  readonly basisReason: string;
  readonly totalCpu: bigint;
  readonly totalMemory: bigint;
  readonly usesCpu: boolean;
  readonly usesMemory: boolean;
}

function decideBasis(namespaces: readonly NamespaceRequests[]): BasisDecision {
  let totalCpu = BigInt(0);
  let totalMemory = BigInt(0);
  let anyCpu = false;
  let anyMemory = false;
  // For a consistent blend every namespace contributing positive CPU must also
  // report a (non-null) memory request; otherwise a blend under-weights it.
  let cpuNamespaceMissingMemory = false;
  for (const ns of namespaces) {
    const hasCpu = isPositiveNumber(ns.cpuRequestMillicores);
    const memoryCollected = typeof ns.memoryRequestBytes === "number" && Number.isFinite(ns.memoryRequestBytes);
    if (hasCpu) {
      totalCpu += nonNegativeIntBig(ns.cpuRequestMillicores);
      anyCpu = true;
      if (!memoryCollected) cpuNamespaceMissingMemory = true;
    }
    if (isPositiveNumber(ns.memoryRequestBytes)) {
      totalMemory += nonNegativeIntBig(ns.memoryRequestBytes);
      anyMemory = true;
    }
  }

  if (anyCpu && anyMemory && !cpuNamespaceMissingMemory) {
    return { basis: "cpu-memory-blend", basisReason: BASIS_REASON_BLEND, totalCpu, totalMemory, usesCpu: true, usesMemory: true };
  }
  if (anyCpu) {
    const reason = anyMemory ? BASIS_REASON_CPU_ONLY_PARTIAL_MEMORY : BASIS_REASON_CPU_ONLY_NO_MEMORY;
    return { basis: "cpu-only", basisReason: reason, totalCpu, totalMemory: BigInt(0), usesCpu: true, usesMemory: false };
  }
  if (anyMemory) {
    return { basis: "memory-only", basisReason: BASIS_REASON_MEMORY_ONLY, totalCpu: BigInt(0), totalMemory, usesCpu: false, usesMemory: true };
  }
  return { basis: null, basisReason: BASIS_REASON_NONE, totalCpu: BigInt(0), totalMemory: BigInt(0), usesCpu: false, usesMemory: false };
}

/** Resolve a per-dimension denominator (BigInt) and whether capacity was known/over-committed. */
interface Denominator {
  readonly value: bigint;
  readonly capacityKnown: boolean;
  readonly overCommitted: boolean;
}

function resolveDenominator(totalRequests: bigint, capacity: number | null | undefined): Denominator {
  const capacityKnown = typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0;
  if (!capacityKnown) {
    return { value: totalRequests, capacityKnown: false, overCommitted: false };
  }
  const capBig = nonNegativeIntBig(capacity);
  if (capBig >= totalRequests) {
    return { value: capBig, capacityKnown: true, overCommitted: false };
  }
  // Over-committed: requests exceed allocatable capacity. Cap the denominator at
  // requests so allocations never exceed the pool and idle stays >= 0.
  return { value: totalRequests, capacityKnown: true, overCommitted: true };
}

function allocateCurrency(
  currency: string,
  clusterCost: bigint,
  namespaces: readonly NamespaceRequests[],
  decision: BasisDecision,
  cluster: ClusterAllocationInput,
  options: { readonly cpuWeightPermille: number; readonly memoryWeightPermille: number; readonly includeWorkloads: boolean },
): CurrencyAllocation {
  // Split the cluster cost into a CPU pool and a memory pool per the basis.
  let cpuPool = BigInt(0);
  let memPool = BigInt(0);
  if (decision.basis === "cpu-memory-blend") {
    cpuPool = (clusterCost * BigInt(options.cpuWeightPermille)) / BigInt(1000);
    memPool = clusterCost - cpuPool;
  } else if (decision.basis === "cpu-only") {
    cpuPool = clusterCost;
  } else if (decision.basis === "memory-only") {
    memPool = clusterCost;
  }

  const cpuDenom = decision.usesCpu ? resolveDenominator(decision.totalCpu, cluster.capacity?.cpuMillicores) : null;
  const memDenom = decision.usesMemory ? resolveDenominator(decision.totalMemory, cluster.capacity?.memoryBytes) : null;

  const allocateOne = (cpuReq: number | null, memReq: number | null): bigint => {
    let allocated = BigInt(0);
    if (cpuDenom !== null && cpuDenom.value > BigInt(0) && isPositiveNumber(cpuReq)) {
      allocated += (cpuPool * nonNegativeIntBig(cpuReq)) / cpuDenom.value;
    }
    if (memDenom !== null && memDenom.value > BigInt(0) && isPositiveNumber(memReq)) {
      allocated += (memPool * nonNegativeIntBig(memReq)) / memDenom.value;
    }
    return allocated;
  };

  const ordered = [...namespaces].sort((a, b) => a.namespace.localeCompare(b.namespace, "en-US"));
  const nsAllocations: NamespaceAllocation[] = [];
  let allocatedTotal = BigInt(0);
  for (const ns of ordered) {
    const allocated = allocateOne(ns.cpuRequestMillicores, ns.memoryRequestBytes);
    allocatedTotal += allocated;
    const cpuActive = decision.usesCpu && isPositiveNumber(ns.cpuRequestMillicores);
    const memActive = decision.usesMemory && isPositiveNumber(ns.memoryRequestBytes);
    const zeroRequests = !cpuActive && !memActive;

    let workloads: WorkloadAllocation[] | null = null;
    if (options.includeWorkloads) {
      workloads = allocateWorkloads(ns, decision, cpuDenom, memDenom, cpuPool, memPool);
    }

    nsAllocations.push({
      namespace: ns.namespace,
      cpuRequestMillicores: typeof ns.cpuRequestMillicores === "number" && Number.isFinite(ns.cpuRequestMillicores) ? ns.cpuRequestMillicores : null,
      memoryRequestBytes: typeof ns.memoryRequestBytes === "number" && Number.isFinite(ns.memoryRequestBytes) ? ns.memoryRequestBytes : null,
      allocatedMicros: allocated.toString(),
      sharePermille: clusterCost > BigInt(0) ? Number((allocated * BigInt(1000)) / clusterCost) : 0,
      zeroRequests,
      workloads,
    });
  }

  const unallocated = clusterCost - allocatedTotal;

  // Determine the honest idle basis. Capacity-not-collected is the headline when
  // any active dimension lacked capacity; then over-commit; else genuine idle.
  let unallocatedBasis: UnallocatedBasis;
  const activeDenoms = [cpuDenom, memDenom].filter((d): d is Denominator => d !== null && d.value > BigInt(0));
  if (activeDenoms.length === 0) {
    // No requests at all: whole cost is unallocated; treat as capacity-not-collected
    // unless capacity was actually supplied for a dimension we did not use.
    unallocatedBasis = "capacity-not-collected-idle-not-measured";
  } else if (activeDenoms.some((d) => !d.capacityKnown)) {
    unallocatedBasis = "capacity-not-collected-idle-not-measured";
  } else if (activeDenoms.some((d) => d.overCommitted)) {
    unallocatedBasis = "over-committed-no-idle";
  } else {
    unallocatedBasis = "idle-from-allocatable-capacity";
  }

  return {
    currency,
    clusterCostMicros: clusterCost.toString(),
    allocatedMicros: allocatedTotal.toString(),
    unallocatedMicros: unallocated.toString(),
    unallocatedBasis,
    namespaces: nsAllocations,
  };
}

function allocateWorkloads(
  ns: NamespaceRequests,
  decision: BasisDecision,
  cpuDenom: Denominator | null,
  memDenom: Denominator | null,
  cpuPool: bigint,
  memPool: bigint,
): WorkloadAllocation[] {
  const workloads = ns.workloads ?? [];
  const ordered = [...workloads].sort((a, b) => a.workload.localeCompare(b.workload, "en-US"));
  // Workloads are allocated over the SAME cluster-wide denominators as namespaces,
  // so summed workload allocations reconcile exactly to the namespace total.
  return ordered.map((wl) => {
    let allocated = BigInt(0);
    if (cpuDenom !== null && cpuDenom.value > BigInt(0) && isPositiveNumber(wl.cpuRequestMillicores)) {
      allocated += (cpuPool * nonNegativeIntBig(wl.cpuRequestMillicores)) / cpuDenom.value;
    }
    if (memDenom !== null && memDenom.value > BigInt(0) && isPositiveNumber(wl.memoryRequestBytes)) {
      allocated += (memPool * nonNegativeIntBig(wl.memoryRequestBytes)) / memDenom.value;
    }
    const cpuActive = decision.usesCpu && isPositiveNumber(wl.cpuRequestMillicores);
    const memActive = decision.usesMemory && isPositiveNumber(wl.memoryRequestBytes);
    return {
      workload: wl.workload,
      workloadKind: typeof wl.workloadKind === "string" && wl.workloadKind.length > 0 ? wl.workloadKind : null,
      cpuRequestMillicores: typeof wl.cpuRequestMillicores === "number" && Number.isFinite(wl.cpuRequestMillicores) ? wl.cpuRequestMillicores : null,
      memoryRequestBytes: typeof wl.memoryRequestBytes === "number" && Number.isFinite(wl.memoryRequestBytes) ? wl.memoryRequestBytes : null,
      allocatedMicros: allocated.toString(),
      zeroRequests: !cpuActive && !memActive,
    };
  });
}

function normalizeCostMap(
  map: Readonly<Record<string, string>> | null | undefined,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (map === null || map === undefined) return out;
  for (const [currencyRaw, microsRaw] of Object.entries(map)) {
    const currency = currencyRaw.toUpperCase();
    if (!CURRENCY_RE.test(currency)) continue;
    if (typeof microsRaw !== "string" || !MICROS_INT.test(microsRaw)) continue;
    out.set(currency, BigInt(microsRaw));
  }
  return out;
}

export function buildKubernetesAllocation(
  input: KubernetesAllocationInput,
  options?: KubernetesAllocationOptions,
): KubernetesAllocationReport {
  const resolved = resolveOptions(options);
  const generatedAt = options?.now !== undefined ? options.now().toISOString() : null;

  const orderedClusters = [...input.clusters].sort((a, b) => a.clusterId.localeCompare(b.clusterId, "en-US"));
  const clusters: ClusterAllocation[] = orderedClusters.map((cluster) => {
    const decision = decideBasis(cluster.namespaces);
    const costMap = normalizeCostMap(cluster.nodeCostMicrosByCurrency);

    const totalCpu = decision.usesCpu ? Number(decision.totalCpu) : null;
    const totalMemory = decision.usesMemory ? Number(decision.totalMemory) : null;
    const capCpu = typeof cluster.capacity?.cpuMillicores === "number" && Number.isFinite(cluster.capacity.cpuMillicores)
      ? cluster.capacity.cpuMillicores
      : null;
    const capMem = typeof cluster.capacity?.memoryBytes === "number" && Number.isFinite(cluster.capacity.memoryBytes)
      ? cluster.capacity.memoryBytes
      : null;

    const base = {
      clusterId: cluster.clusterId,
      basis: decision.basis,
      basisReason: decision.basisReason,
      namespacesEvaluated: cluster.namespaces.length,
      totalCpuRequestMillicores: totalCpu,
      totalMemoryRequestBytes: totalMemory,
      allocatableCpuMillicores: capCpu,
      allocatableMemoryBytes: capMem,
    };

    if (costMap.size === 0) {
      return {
        ...base,
        costAvailable: false,
        unavailableReason: REASON_NODE_COST_NOT_DERIVABLE,
        currencies: [],
      };
    }

    const currencies: CurrencyAllocation[] = [...costMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "en-US"))
      .map(([currency, cost]) => allocateCurrency(currency, cost, cluster.namespaces, decision, cluster, resolved));

    return {
      ...base,
      costAvailable: true,
      unavailableReason: null,
      currencies,
    };
  });

  return {
    schema: "sutra.finops-k8s-allocation.v1",
    clusters,
    generatedAt,
    options: {
      cpuWeightPermille: resolved.cpuWeightPermille,
      memoryWeightPermille: resolved.memoryWeightPermille,
      includeWorkloads: resolved.includeWorkloads,
    },
    limitations: LIMITATIONS,
    disclaimer: K8S_ALLOCATION_DISCLAIMER,
  };
}
