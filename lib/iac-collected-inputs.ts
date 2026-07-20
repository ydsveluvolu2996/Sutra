// Adapter: already-COLLECTED Kubernetes workload specs (the normalized evidence
// the cluster collector stored, KubernetesWorkloadEvidence) -> the IacResource[]
// the committed IaC misconfiguration scanner consumes. This is the real-ingest
// counterpart to the paste path (lib/iac-scan-input -> lib/iac-normalizer): the
// paste flow maps raw manifest JSON, this flow maps evidence Sutra already has.
//
// It carries the same honesty contract as the normalizer and the scanner:
//   * Only fields actually present in the collected evidence are mapped. The
//     evidence uses a TriState (true | false | null) for every security-context
//     signal, where null means "the collector did not observe this". A null (or a
//     workload with no evidence for a field) is left OUT of the resource config,
//     so the downstream scanner records it as 'field-absent' (an explicit
//     unknown) rather than a manufactured pass or fail. Nothing is assumed secure
//     or insecure from a missing value.
//   * Aggregation across a workload's containers mirrors the manifest normalizer:
//     a positive-risk flag (privileged) is true when ANY container is explicitly
//     true and false only when EVERY container is explicitly false; a
//     positive-requirement flag (run-as-non-root, resource-limits) is false when
//     ANY container explicitly fails it and true only when EVERY container
//     explicitly satisfies it. Otherwise the flag stays absent (unknown).
//   * When no workload specs are collected the resource list is empty AND the
//     returned coverage reports workloads: 0, so the caller can render an explicit
//     zero-coverage state instead of a misleading empty clean pass.
//
// It maps only the four workload fields the scanner's kubernetes_pod rules model
// (host_network, privileged, run_as_non_root, has_resource_limits). Other
// collected signals the scanner does not yet model (hostPid, hostIpc, hostPath,
// capabilities, privilege-escalation) are deliberately not synthesized into
// config, so they surface honestly as field-absent in scanner coverage rather
// than implying evaluation that does not happen.

import type { IacResource } from "./iac-misconfiguration.ts";
import type { KubernetesWorkloadEvidence } from "./kubernetes-posture.ts";

type TriState = boolean | null;

export interface CollectedClusterWorkloads {
  readonly clusterId: string;
  readonly clusterName: string;
  /** ISO timestamp of the latest complete collection, or null when the cluster has none. */
  readonly collectedAt: string | null;
  readonly workloads: readonly KubernetesWorkloadEvidence[];
}

export interface CollectedClusterCoverage {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly collectedAt: string | null;
  readonly workloads: number;
}

export interface CollectedIacCoverage {
  /** Clusters considered for the connection. */
  readonly clusters: number;
  /** Of those, clusters that have a completed collection to read from. */
  readonly clustersWithScan: number;
  /** Workload specs mapped into scanner resources (0 => explicit zero-coverage). */
  readonly workloads: number;
  readonly clusterBreakdown: readonly CollectedClusterCoverage[];
}

export interface CollectedIacInput {
  readonly resources: readonly IacResource[];
  readonly coverage: CollectedIacCoverage;
}

// Positive-risk aggregation (privileged): true needs at least one explicit true;
// false needs every container to declare false; otherwise absent (unknown).
function aggregateRisk(values: readonly TriState[]): boolean | undefined {
  if (values.some((value) => value === true)) return true;
  if (values.length > 0 && values.every((value) => value === false)) return false;
  return undefined;
}

// Positive-requirement aggregation (run_as_non_root, resource limits): false
// needs at least one explicit false; true needs every container to satisfy it;
// otherwise absent (unknown).
function aggregateRequirement(values: readonly TriState[]): boolean | undefined {
  if (values.some((value) => value === false)) return false;
  if (values.length > 0 && values.every((value) => value === true)) return true;
  return undefined;
}

// A container "has resource limits" (the scanner reads a non-empty
// resources.limits) when the collector observed either a CPU or a memory limit;
// it definitively lacks them only when both are observed absent; a null on the
// undecided side leaves the container's limit state unknown.
function containerLimitState(container: KubernetesWorkloadEvidence["containers"][number]): TriState {
  const cpu = container.hasCpuLimit;
  const memory = container.hasMemoryLimit;
  if (cpu === true || memory === true) return true;
  if (cpu === false && memory === false) return false;
  return null;
}

function workloadResource(clusterName: string, workload: KubernetesWorkloadEvidence): IacResource {
  const config: Record<string, unknown> = {};
  const containers = workload.containers;

  // host_network: mapped only when the collector observed it (TriState boolean).
  if (typeof workload.hostNetwork === "boolean") config.host_network = workload.hostNetwork;

  const privileged = aggregateRisk(containers.map((container) => container.privileged));
  if (privileged !== undefined) config.privileged = privileged;

  // run_as_non_root: a container's own signal wins; where the container did not
  // declare it, the pod-level signal applies (both TriState, null = unobserved).
  const runAsNonRoot = aggregateRequirement(
    containers.map((container) => container.runAsNonRoot ?? workload.runAsNonRoot),
  );
  if (runAsNonRoot !== undefined) config.run_as_non_root = runAsNonRoot;

  const hasResourceLimits = aggregateRequirement(containers.map(containerLimitState));
  if (hasResourceLimits !== undefined) config.has_resource_limits = hasResourceLimits;

  return {
    kind: "kubernetes_pod",
    name: `${workload.namespace}/${workload.name}`,
    config,
    sourceRef: { file: `${clusterName} · ${workload.workloadKind}` },
  };
}

export function buildCollectedIacInput(
  clusters: readonly CollectedClusterWorkloads[],
): CollectedIacInput {
  const resources: IacResource[] = [];
  const clusterBreakdown: CollectedClusterCoverage[] = [];
  let clustersWithScan = 0;

  for (const cluster of clusters) {
    if (cluster.collectedAt !== null) clustersWithScan += 1;
    for (const workload of cluster.workloads) {
      resources.push(workloadResource(cluster.clusterName, workload));
    }
    clusterBreakdown.push({
      clusterId: cluster.clusterId,
      clusterName: cluster.clusterName,
      collectedAt: cluster.collectedAt,
      workloads: cluster.workloads.length,
    });
  }

  return {
    resources,
    coverage: {
      clusters: clusters.length,
      clustersWithScan,
      workloads: resources.length,
      clusterBreakdown,
    },
  };
}
