/**
 * Adapter: shapes collected Kubernetes pod-request data and CUR/FOCUS node cost
 * into the pure `buildKubernetesAllocation` engine input. Pure, no I/O.
 *
 * IMPORTANT (data availability): the persisted Kubernetes evidence snapshot in
 * this codebase records only whether a container HAS a cpu/memory request, not
 * the numeric quantity, and does NOT collect Node objects or a node -> EC2
 * instance mapping. The numeric pod requests and allocatable node capacity are
 * therefore only reachable through a separate metrics/projection source, so this
 * adapter ACCEPTS already-shaped arrays as parameters (the route sources them);
 * it never imports DB/repository code. Nothing is invented: a pod contributes to
 * a namespace's CPU (or memory) total only when that request quantity is present.
 *
 * Node cost may be supplied directly per cluster, or derived from CUR/FOCUS
 * "Usage" lines whose identifying tag value equals the clusterId and whose
 * service is a compute/EKS service. When neither yields a cost for a cluster the
 * engine receives a null cost map and discloses "node-cost-not-derivable" — no
 * cost is fabricated. Currencies are kept separate throughout.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import type {
  ClusterAllocationInput,
  KubernetesAllocationInput,
  NamespaceRequests,
  WorkloadRequests,
} from "./finops-k8s-allocation.ts";

/** One collected pod's summed container requests, keyed to its cluster/namespace/workload. */
export interface CollectedPodRequest {
  readonly clusterId: string;
  readonly namespace: string;
  /** Owning workload (Deployment/StatefulSet/... ) or the pod name when standalone. */
  readonly workload: string;
  readonly workloadKind?: string;
  /** Summed container CPU requests for the pod, millicores; null when not collected. */
  readonly cpuRequestMillicores: number | null;
  /** Summed container memory requests for the pod, bytes; null when not collected. */
  readonly memoryRequestBytes: number | null;
}

/** Directly-supplied per-cluster node/compute cost (preferred, exact). */
export interface ClusterNodeCost {
  readonly clusterId: string;
  readonly currency: string;
  readonly amountMicros: string;
}

/** Total allocatable node capacity for a cluster (from Node objects, if collected). */
export interface ClusterCapacityInput {
  readonly clusterId: string;
  readonly cpuMillicores: number | null;
  readonly memoryBytes: number | null;
}

export interface KubernetesAllocationAdapterInput {
  /** Collected pod-level requests; bucketed into namespaces (and workloads) here. */
  readonly pods: readonly CollectedPodRequest[];
  /** Explicit clusters to always emit (e.g. a cluster with cost but no requests). */
  readonly clusterIds?: readonly string[];
  /** Directly-supplied per-cluster node cost, per currency. */
  readonly clusterCosts?: readonly ClusterNodeCost[];
  /** CUR/FOCUS lines used to derive node cost when a tag value identifies the cluster. */
  readonly curLines?: readonly NormalizedCurLine[];
  /** Tag key on the CUR line whose value equals the clusterId. */
  readonly curClusterTagKey?: string;
  /** Services counted as node/compute cost (case-insensitive). Defaults below. */
  readonly curComputeServices?: readonly string[];
  /** Optional total allocatable node capacity per cluster. */
  readonly capacity?: readonly ClusterCapacityInput[];
}

const MICROS_INT = /^-?\d+$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;

/** Default AWS compute/EKS service codes (CUR product_servicecode / FOCUS ServiceName). */
export const DEFAULT_COMPUTE_SERVICES: readonly string[] = Object.freeze([
  "amazonec2",
  "amazoneks",
  "amazonelasticcomputecloud",
  "elastic kubernetes service",
  "ec2 - other",
  "ec2",
  "eks",
]);

function addRequest(
  acc: { cpu: number | null; memory: number | null },
  cpu: number | null,
  memory: number | null,
): void {
  if (typeof cpu === "number" && Number.isFinite(cpu) && cpu > 0) {
    acc.cpu = (acc.cpu ?? 0) + cpu;
  }
  if (typeof memory === "number" && Number.isFinite(memory) && memory > 0) {
    acc.memory = (acc.memory ?? 0) + memory;
  }
}

interface NamespaceAcc {
  readonly cpuMem: { cpu: number | null; memory: number | null };
  readonly workloads: Map<string, { cpuMem: { cpu: number | null; memory: number | null }; kind: string | undefined }>;
}

/**
 * Derive per-cluster node cost from CUR lines: sum on-demand "Usage" compute
 * lines whose identifying tag value equals the clusterId, per currency. A
 * cluster with lines in multiple currencies keeps each currency separate.
 */
function costsFromCur(
  curLines: readonly NormalizedCurLine[],
  tagKey: string,
  computeServices: ReadonlySet<string>,
): Map<string, Map<string, bigint>> {
  const byCluster = new Map<string, Map<string, bigint>>();
  for (const line of curLines) {
    if (line.chargeCategory.trim().toLowerCase() !== "usage") continue;
    if (!computeServices.has(line.service.trim().toLowerCase())) continue;
    const clusterId = line.tags[tagKey];
    if (clusterId === undefined || clusterId.length === 0) continue;
    if (!MICROS_INT.test(line.amountMicros)) continue;
    const amount = BigInt(line.amountMicros);
    if (amount <= BigInt(0)) continue;
    const perCurrency = byCluster.get(clusterId) ?? new Map<string, bigint>();
    perCurrency.set(line.currency, (perCurrency.get(line.currency) ?? BigInt(0)) + amount);
    byCluster.set(clusterId, perCurrency);
  }
  return byCluster;
}

export function buildKubernetesAllocationInput(
  input: KubernetesAllocationAdapterInput,
): KubernetesAllocationInput {
  // 1. Bucket pod requests into namespaces (and workloads) per cluster.
  const clusterMap = new Map<string, Map<string, NamespaceAcc>>();
  const ensureCluster = (clusterId: string): Map<string, NamespaceAcc> => {
    const existing = clusterMap.get(clusterId);
    if (existing !== undefined) return existing;
    const created = new Map<string, NamespaceAcc>();
    clusterMap.set(clusterId, created);
    return created;
  };

  for (const clusterId of input.clusterIds ?? []) {
    if (clusterId.length > 0) ensureCluster(clusterId);
  }

  for (const pod of input.pods) {
    if (pod.clusterId.length === 0 || pod.namespace.length === 0) continue;
    const namespaces = ensureCluster(pod.clusterId);
    const nsAcc = namespaces.get(pod.namespace) ?? { cpuMem: { cpu: null, memory: null }, workloads: new Map() };
    addRequest(nsAcc.cpuMem, pod.cpuRequestMillicores, pod.memoryRequestBytes);
    if (pod.workload.length > 0) {
      const wlAcc = nsAcc.workloads.get(pod.workload) ?? { cpuMem: { cpu: null, memory: null }, kind: pod.workloadKind };
      addRequest(wlAcc.cpuMem, pod.cpuRequestMillicores, pod.memoryRequestBytes);
      nsAcc.workloads.set(pod.workload, wlAcc);
    }
    namespaces.set(pod.namespace, nsAcc);
  }

  // 2. Resolve per-cluster node cost: direct costs first, then CUR-derived.
  const costByCluster = new Map<string, Map<string, bigint>>();
  for (const cost of input.clusterCosts ?? []) {
    const currency = cost.currency.toUpperCase();
    if (cost.clusterId.length === 0 || !CURRENCY_RE.test(currency) || !MICROS_INT.test(cost.amountMicros)) continue;
    const perCurrency = costByCluster.get(cost.clusterId) ?? new Map<string, bigint>();
    // Direct costs win: only set when not already present for that currency.
    if (!perCurrency.has(currency)) perCurrency.set(currency, BigInt(cost.amountMicros));
    costByCluster.set(cost.clusterId, perCurrency);
  }
  if (input.curLines !== undefined && input.curClusterTagKey !== undefined && input.curClusterTagKey.length > 0) {
    const computeServices = new Set(
      (input.curComputeServices ?? DEFAULT_COMPUTE_SERVICES).map((service) => service.trim().toLowerCase()),
    );
    const derived = costsFromCur(input.curLines, input.curClusterTagKey, computeServices);
    for (const [clusterId, perCurrency] of derived) {
      const existing = costByCluster.get(clusterId) ?? new Map<string, bigint>();
      for (const [currency, micros] of perCurrency) {
        if (!existing.has(currency)) existing.set(currency, micros); // direct cost wins
      }
      costByCluster.set(clusterId, existing);
    }
  }

  // 3. Capacity by cluster.
  const capacityByCluster = new Map<string, ClusterCapacityInput>();
  for (const cap of input.capacity ?? []) {
    if (cap.clusterId.length > 0 && !capacityByCluster.has(cap.clusterId)) capacityByCluster.set(cap.clusterId, cap);
  }

  // 4. Emit clusters (union of clusters that have requests and clusters that have cost).
  const allClusterIds = new Set<string>([...clusterMap.keys(), ...costByCluster.keys()]);
  const clusters: ClusterAllocationInput[] = [...allClusterIds]
    .sort((a, b) => a.localeCompare(b, "en-US"))
    .map((clusterId) => {
      const namespaces: NamespaceRequests[] = [...(clusterMap.get(clusterId) ?? new Map<string, NamespaceAcc>()).entries()]
        .sort(([a], [b]) => a.localeCompare(b, "en-US"))
        .map(([namespace, acc]) => {
          const workloads: WorkloadRequests[] = [...acc.workloads.entries()]
            .sort(([a], [b]) => a.localeCompare(b, "en-US"))
            .map(([workload, wl]) => ({
              workload,
              workloadKind: wl.kind,
              cpuRequestMillicores: wl.cpuMem.cpu,
              memoryRequestBytes: wl.cpuMem.memory,
            }));
          return {
            namespace,
            cpuRequestMillicores: acc.cpuMem.cpu,
            memoryRequestBytes: acc.cpuMem.memory,
            workloads,
          };
        });

      const costPerCurrency = costByCluster.get(clusterId) ?? null;
      let nodeCostMicrosByCurrency: Record<string, string> | null = null;
      if (costPerCurrency !== null && costPerCurrency.size > 0) {
        nodeCostMicrosByCurrency = {};
        for (const currency of [...costPerCurrency.keys()].sort((a, b) => a.localeCompare(b, "en-US"))) {
          nodeCostMicrosByCurrency[currency] = (costPerCurrency.get(currency) as bigint).toString();
        }
      }

      const cap = capacityByCluster.get(clusterId);
      return {
        clusterId,
        nodeCostMicrosByCurrency,
        namespaces,
        capacity: cap === undefined ? undefined : { cpuMillicores: cap.cpuMillicores, memoryBytes: cap.memoryBytes },
      };
    });

  return { clusters };
}
