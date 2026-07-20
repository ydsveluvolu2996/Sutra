/**
 * Pure projection: turn a persisted Kubernetes evidence snapshot into the exact
 * adapter input `buildKubernetesAllocationInput` expects, plus a disclosure of
 * how much of the cluster's node cost the bundled catalog could actually price.
 *
 * Data provenance (nothing is invented):
 * - Per-namespace/workload numeric requests come from each Workload's container
 *   `cpuRequestMillicores` / `memoryRequestBytes` (collected as real quantities;
 *   a container with no numeric request contributes nothing).
 * - Cluster allocatable capacity is the sum of the evidence `nodes[]`
 *   allocatable CPU (millicores) and memory (bytes).
 * - Node cost is summed from a DISCLOSED, BUNDLED monthly USD list-price catalog
 *   keyed by each node's instance type. Nodes whose type is unknown (or that
 *   carry no instance-type label) contribute no cost and are disclosed. When no
 *   node type is known the cost map is empty and the engine discloses
 *   "node-cost-not-derivable" — no cost is fabricated.
 *
 * Money is integer micro-USD. This is a planning estimate, never an AWS quote.
 */
import type { KubernetesEvidenceSnapshot } from "./kubernetes-posture.ts";
import type {
  ClusterCapacityInput,
  ClusterNodeCost,
  CollectedPodRequest,
  KubernetesAllocationAdapterInput,
} from "./finops-k8s-allocation-inputs.ts";

/**
 * Bundled monthly (730h) USD on-demand Linux list-price ESTIMATES, in integer
 * micro-USD, keyed by EC2 instance type. Deliberately small and conservative:
 * common EKS node types only. NOT a live price-list lookup, NOT region-adjusted,
 * and excludes Savings Plans, Reserved Instances, Spot, EBS and network. Values
 * are hourly on-demand list price x 730 x 1_000_000, rounded to whole micros.
 */
export const NODE_MONTHLY_LIST_PRICE_USD_MICROS: Readonly<Record<string, number>> = Object.freeze({
  // General purpose, burstable (t3)
  "t3.small": 15_184_000,
  "t3.medium": 30_368_000,
  "t3.large": 60_736_000,
  "t3.xlarge": 121_472_000,
  "t3.2xlarge": 242_944_000,
  // General purpose (m5 / m6i)
  "m5.large": 70_080_000,
  "m5.xlarge": 140_160_000,
  "m5.2xlarge": 280_320_000,
  "m6i.large": 70_080_000,
  "m6i.xlarge": 140_160_000,
  "m6i.2xlarge": 280_320_000,
  // Compute optimized (c5 / c6i)
  "c5.large": 62_050_000,
  "c5.xlarge": 124_100_000,
  "c5.2xlarge": 248_200_000,
  "c6i.large": 62_050_000,
  "c6i.xlarge": 124_100_000,
  "c6i.2xlarge": 248_200_000,
  // Memory optimized (r5)
  "r5.large": 91_980_000,
  "r5.xlarge": 183_960_000,
  "r5.2xlarge": 367_920_000,
});

export const NODE_COST_CATALOG_DISCLOSURE =
  "Node cost is a BUNDLED list-price ESTIMATE: monthly (730h) AWS on-demand " +
  "Linux list prices for a fixed set of common EKS instance types, keyed by the " +
  "node's instance-type label. It is NOT a live AWS price-list lookup, NOT " +
  "region-adjusted, and excludes Savings Plans, Reserved Instances, Spot, and " +
  "EBS/network charges. Nodes whose instance type is absent from the catalog, or " +
  "that carry no instance-type label, contribute no cost and are disclosed; when " +
  "no node type is known the cluster's node cost is not derivable.";

export interface NodeCostCatalogCoverage {
  readonly currency: "USD";
  readonly priceModel: "bundled-monthly-on-demand-list-price-estimate";
  /** Total nodes seen in the evidence side array. */
  readonly nodesTotal: number;
  /** Nodes whose instance type was found in the catalog and priced. */
  readonly nodesPriced: number;
  /** Nodes with an instance type that is NOT in the catalog. */
  readonly nodesWithUnknownType: number;
  /** Nodes that carried no instance-type label at all. */
  readonly nodesMissingInstanceType: number;
  /** Sorted, de-duplicated instance types that were seen but not priced. */
  readonly unknownInstanceTypes: readonly string[];
  /** Summed monthly cost (micro-USD) over priced nodes, as a bigint-safe string. */
  readonly monthlyCostMicros: string;
  /** Whether any node was priced (i.e. a node cost is derivable at all). */
  readonly costDerivable: boolean;
  readonly disclosure: string;
}

/**
 * The exact object `buildKubernetesAllocationInput` accepts (structurally a
 * `KubernetesAllocationAdapterInput`), enriched with a `costCatalogCoverage`
 * disclosure. The extra field is ignored by the adapter, so callers may pass
 * this value straight into `buildKubernetesAllocationInput`.
 */
export type KubernetesAllocationProjection =
  KubernetesAllocationAdapterInput & { readonly costCatalogCoverage: NodeCostCatalogCoverage };

/**
 * Project a single-cluster evidence snapshot into allocation adapter input.
 * Pure: no clock, no I/O, no persistence.
 */
export function projectKubernetesAllocationInput(
  evidence: KubernetesEvidenceSnapshot,
): KubernetesAllocationProjection {
  const clusterId = evidence.clusterId;

  // 1. One pod-request row per Workload, summing its containers' numeric requests.
  const pods: CollectedPodRequest[] = [];
  for (const resource of evidence.resources) {
    if (resource.kind !== "Workload") continue;
    let cpu: number | null = null;
    let memory: number | null = null;
    for (const c of resource.containers) {
      if (typeof c.cpuRequestMillicores === "number") cpu = (cpu ?? 0) + c.cpuRequestMillicores;
      if (typeof c.memoryRequestBytes === "number") memory = (memory ?? 0) + c.memoryRequestBytes;
    }
    pods.push({
      clusterId,
      namespace: resource.namespace,
      workload: resource.name,
      workloadKind: resource.workloadKind,
      cpuRequestMillicores: cpu,
      memoryRequestBytes: memory,
    });
  }

  // 2. Allocatable capacity: sum over collected nodes (null when none reported it).
  const nodes = evidence.nodes ?? [];
  let cpuMillicores: number | null = null;
  let memoryBytes: number | null = null;
  for (const node of nodes) {
    if (typeof node.allocatableCpuMillicores === "number") {
      cpuMillicores = (cpuMillicores ?? 0) + node.allocatableCpuMillicores;
    }
    if (typeof node.allocatableMemoryBytes === "number") {
      memoryBytes = (memoryBytes ?? 0) + node.allocatableMemoryBytes;
    }
  }

  // 3. Node cost: sum the catalog over nodes with a known instance type.
  let monthlyMicros = BigInt(0);
  let nodesPriced = 0;
  let nodesWithUnknownType = 0;
  let nodesMissingInstanceType = 0;
  const unknownTypes = new Set<string>();
  for (const node of nodes) {
    const type = node.instanceType;
    if (type === null) {
      nodesMissingInstanceType += 1;
      continue;
    }
    if (Object.hasOwn(NODE_MONTHLY_LIST_PRICE_USD_MICROS, type)) {
      monthlyMicros += BigInt(NODE_MONTHLY_LIST_PRICE_USD_MICROS[type]);
      nodesPriced += 1;
    } else {
      nodesWithUnknownType += 1;
      unknownTypes.add(type);
    }
  }

  const clusterCosts: ClusterNodeCost[] = nodesPriced > 0
    ? [{ clusterId, currency: "USD", amountMicros: monthlyMicros.toString() }]
    : [];

  const capacity: ClusterCapacityInput[] = nodes.length > 0
    ? [{ clusterId, cpuMillicores, memoryBytes }]
    : [];

  const costCatalogCoverage: NodeCostCatalogCoverage = {
    currency: "USD",
    priceModel: "bundled-monthly-on-demand-list-price-estimate",
    nodesTotal: nodes.length,
    nodesPriced,
    nodesWithUnknownType,
    nodesMissingInstanceType,
    unknownInstanceTypes: [...unknownTypes].sort((a, b) => a.localeCompare(b, "en-US")),
    monthlyCostMicros: monthlyMicros.toString(),
    costDerivable: nodesPriced > 0,
    disclosure: NODE_COST_CATALOG_DISCLOSURE,
  };

  return {
    pods,
    clusterIds: [clusterId],
    clusterCosts,
    capacity,
    costCatalogCoverage,
  };
}
