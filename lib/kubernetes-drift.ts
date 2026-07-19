// Drift detection: compares a workload's security-relevant spec between the two
// most recent scans and reports where it changed — the running workload no
// longer matches its previously-observed (admitted) state. It flags image
// changes and security regressions (privileged, non-root lost, host access,
// added capabilities). Purely a diff of retained evidence; a regression only
// counts when the prior scan actually recorded the safer value.

export type DriftSeverity = "critical" | "high" | "medium" | "low";
export type DriftKind =
  | "workload-added" | "workload-removed" | "image-changed"
  | "privileged-enabled" | "privilege-escalation-enabled" | "run-as-non-root-lost"
  | "host-network-enabled" | "host-pid-enabled" | "host-ipc-enabled"
  | "host-path-added" | "capabilities-added";

export interface DriftContainer {
  readonly name: string;
  readonly image: string | null;
  readonly privileged: boolean | null;
  readonly allowPrivilegeEscalation: boolean | null;
  readonly runAsNonRoot: boolean | null;
  readonly capabilitiesAdd: readonly string[] | null;
}

export interface DriftWorkload {
  readonly namespace: string;
  readonly name: string;
  readonly workloadKind: string;
  readonly hostNetwork: boolean | null;
  readonly hostPid: boolean | null;
  readonly hostIpc: boolean | null;
  readonly hasHostPath: boolean | null;
  readonly runAsNonRoot: boolean | null;
  readonly containers: readonly DriftContainer[];
}

export interface DriftChange {
  readonly workload: string;
  readonly workloadKind: string;
  readonly container: string | null;
  readonly kind: DriftKind;
  readonly severity: DriftSeverity;
  readonly detail: string;
  readonly from: string;
  readonly to: string;
}

export interface DriftReport {
  readonly schema: "sutra.kubernetes-drift.v1";
  readonly hasPrevious: boolean;
  readonly changes: readonly DriftChange[];
  readonly summary: Readonly<Record<DriftSeverity, number>> & {
    readonly changes: number;
    readonly workloadsDrifted: number;
  };
  readonly disclaimer: string;
}

const SEVERITY_RANK: Readonly<Record<DriftSeverity, number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

const DRIFT_DISCLAIMER =
  "Drift compares a workload's spec in the two most recent scans. A security " +
  "regression is reported only when the earlier scan recorded the safer value; " +
  "an image change is reported when the container image reference differs. " +
  "Added or removed workloads are informational, not regressions.";

function workloadKey(workload: { namespace: string; name: string; workloadKind: string }): string {
  return `${workload.workloadKind}/${workload.namespace}/${workload.name}`;
}
function tri(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}
// A "gained" bad flag: previously not-true (false/unknown) and now true.
function gainedBadFlag(previous: boolean | null, current: boolean | null): boolean {
  return previous !== true && current === true;
}
// A "lost" good flag: previously true and now not-true.
function lostGoodFlag(previous: boolean | null, current: boolean | null): boolean {
  return previous === true && current !== true;
}

export function buildWorkloadDrift(input: {
  readonly current: readonly DriftWorkload[];
  readonly previous: readonly DriftWorkload[] | null;
}): DriftReport {
  const hasPrevious = input.previous !== null;
  const changes: DriftChange[] = [];
  const previousByKey = new Map((input.previous ?? []).map((workload) => [workloadKey(workload), workload]));
  const currentByKey = new Map(input.current.map((workload) => [workloadKey(workload), workload]));

  if (hasPrevious) {
    for (const workload of input.current) {
      const key = workloadKey(workload);
      const prior = previousByKey.get(key);
      if (prior === undefined) {
        changes.push({ workload: key, workloadKind: workload.workloadKind, container: null, kind: "workload-added", severity: "low", detail: "Workload appeared since the previous scan", from: "absent", to: "present" });
        continue;
      }
      const push = (kind: DriftKind, severity: DriftSeverity, detail: string, from: string, to: string, container: string | null = null) =>
        changes.push({ workload: key, workloadKind: workload.workloadKind, container, kind, severity, detail, from, to });

      if (gainedBadFlag(prior.hostNetwork, workload.hostNetwork)) push("host-network-enabled", "high", "Host network namespace enabled", tri(prior.hostNetwork), tri(workload.hostNetwork));
      if (gainedBadFlag(prior.hostPid, workload.hostPid)) push("host-pid-enabled", "high", "Host PID namespace enabled", tri(prior.hostPid), tri(workload.hostPid));
      if (gainedBadFlag(prior.hostIpc, workload.hostIpc)) push("host-ipc-enabled", "high", "Host IPC namespace enabled", tri(prior.hostIpc), tri(workload.hostIpc));
      if (gainedBadFlag(prior.hasHostPath, workload.hasHostPath)) push("host-path-added", "high", "Host filesystem mount added", tri(prior.hasHostPath), tri(workload.hasHostPath));
      if (lostGoodFlag(prior.runAsNonRoot, workload.runAsNonRoot)) push("run-as-non-root-lost", "high", "Pod-level run-as-non-root guarantee lost", tri(prior.runAsNonRoot), tri(workload.runAsNonRoot));

      const priorContainers = new Map(prior.containers.map((container) => [container.name, container]));
      for (const container of workload.containers) {
        const priorContainer = priorContainers.get(container.name);
        if (priorContainer === undefined) continue;
        if (priorContainer.image !== container.image && container.image !== null) {
          push("image-changed", "medium", "Container image reference changed", priorContainer.image ?? "unknown", container.image, container.name);
        }
        if (gainedBadFlag(priorContainer.privileged, container.privileged)) push("privileged-enabled", "critical", "Container became privileged", tri(priorContainer.privileged), tri(container.privileged), container.name);
        if (gainedBadFlag(priorContainer.allowPrivilegeEscalation, container.allowPrivilegeEscalation)) push("privilege-escalation-enabled", "high", "Privilege escalation allowed", tri(priorContainer.allowPrivilegeEscalation), tri(container.allowPrivilegeEscalation), container.name);
        if (lostGoodFlag(priorContainer.runAsNonRoot, container.runAsNonRoot)) push("run-as-non-root-lost", "high", "Container run-as-non-root guarantee lost", tri(priorContainer.runAsNonRoot), tri(container.runAsNonRoot), container.name);
        const priorCaps = new Set(priorContainer.capabilitiesAdd ?? []);
        const gainedCaps = (container.capabilitiesAdd ?? []).filter((cap) => !priorCaps.has(cap));
        if (gainedCaps.length > 0) push("capabilities-added", "medium", `Linux capabilities added: ${gainedCaps.join(", ")}`, [...priorCaps].join(", ") || "none", (container.capabilitiesAdd ?? []).join(", "), container.name);
      }
    }
    for (const workload of input.previous ?? []) {
      const key = workloadKey(workload);
      if (!currentByKey.has(key)) {
        changes.push({ workload: key, workloadKind: workload.workloadKind, container: null, kind: "workload-removed", severity: "low", detail: "Workload removed since the previous scan", from: "present", to: "absent" });
      }
    }
  }

  changes.sort((left, right) =>
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    left.workload.localeCompare(right.workload, "en-US") ||
    left.kind.localeCompare(right.kind, "en-US"));

  const summary = { critical: 0, high: 0, medium: 0, low: 0, changes: changes.length, workloadsDrifted: new Set(changes.map((change) => change.workload)).size };
  for (const change of changes) summary[change.severity] += 1;

  return { schema: "sutra.kubernetes-drift.v1", hasPrevious, changes, summary, disclaimer: DRIFT_DISCLAIMER };
}
