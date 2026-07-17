// Named "Issues" engine: collapses raw Kubernetes evidence into a small set of
// deduplicated, named toxic-combination issues, then prioritizes them by real
// signal rather than raw CVE count. Two honesty-preserving ideas set this apart
// from a flat findings list:
//   * Reachability is "confirmed" only when an external network flow to the
//     workload was actually observed; otherwise it is "theoretical".
//   * Priority is boosted by observed runtime activity and confirmed
//     reachability, so a confirmed-reachable, runtime-active HIGH ranks above an
//     unreachable, dormant CRITICAL — the opposite of alert-by-severity-count.
// Every issue keeps the cited factors it was built from; nothing is synthesized.

export type IssueSeverity = "critical" | "high" | "medium" | "low";
export type IssueReachability = "confirmed" | "theoretical" | "not_exposed";
export type VulnSeverity = "critical" | "high" | "medium" | "low";

export interface IssueWorkloadRef {
  readonly namespace: string | null;
  readonly name: string;
}

export interface IssueVulnInput {
  readonly workload: IssueWorkloadRef;
  readonly severity: VulnSeverity;
  readonly cveId: string | null;
  readonly title: string;
  readonly fixedVersion: string | null;
  readonly packageName: string | null;
}

export interface IssuePostureInput {
  readonly workload: IssueWorkloadRef;
  readonly controlId: string;
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly message: string;
}

export interface IssueExposureInput {
  readonly workload: IssueWorkloadRef;
  readonly kind: "internet" | "load_balancer" | "ingress" | "service";
  readonly evidence: string;
}

export interface IssueFlowInput {
  readonly workload: IssueWorkloadRef;
  readonly fromExternal: boolean;
  readonly verdict: "forwarded" | "dropped" | "error" | "audit" | "unknown";
  readonly observedAt: string | null;
}

export interface IssueRuntimeInput {
  readonly workload: IssueWorkloadRef;
  readonly rule: string;
  readonly priority: string;
  readonly observedAt: string | null;
}

export interface IssueFactor {
  readonly kind: "vulnerability" | "exposure" | "reachability" | "privilege" | "identity" | "runtime";
  readonly detail: string;
}

export interface KubernetesIssue {
  readonly id: string;
  readonly ruleId: string;
  readonly title: string;
  readonly severity: IssueSeverity;
  readonly priority: number;
  readonly workload: string;
  readonly reachability: IssueReachability;
  readonly runtimeObserved: boolean;
  readonly factors: readonly IssueFactor[];
  readonly recommendation: string;
}

export interface KubernetesIssueReport {
  readonly schema: "sutra.kubernetes-issues.v1";
  readonly issues: readonly KubernetesIssue[];
  readonly totals: Readonly<Record<IssueSeverity, number>> & {
    readonly issues: number;
    readonly confirmedReachable: number;
    readonly runtimeObserved: number;
  };
  readonly disclaimer: string;
}

const SEVERITY_WEIGHT: Readonly<Record<IssueSeverity, number>> = {
  critical: 100, high: 70, medium: 40, low: 15,
};
const SEVERITY_RANK: Readonly<Record<IssueSeverity, number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
};
const VULN_RANK: Readonly<Record<VulnSeverity, number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

const CONFIRMED_REACHABLE_BOOST = 30;
const RUNTIME_BOOST = 25;
const PRIVILEGE_BOOST = 8;
const IDENTITY_BOOST = 8;

const PRIVILEGE_CONTROLS = new Set([
  "K8S-WORKLOAD-NO-PRIVILEGED",
  "K8S-WORKLOAD-NO-PRIVILEGE-ESCALATION",
  "K8S-WORKLOAD-HOST-NAMESPACES",
  "K8S-WORKLOAD-HOST-PATH",
  "K8S-WORKLOAD-RUN-AS-NON-ROOT",
  "K8S-WORKLOAD-CAPABILITIES",
]);
const IDENTITY_CONTROLS = new Set(["K8S-RBAC-WILDCARDS", "K8S-RBAC-ESCALATION"]);

const ISSUE_DISCLAIMER =
  "Issues are deduplicated toxic combinations built only from cited evidence. " +
  "Reachability is confirmed only from an observed external flow; priority is " +
  "boosted by observed runtime activity and confirmed reachability, and is a " +
  "triage aid, not proof of exploitability.";

function workloadKey(ref: IssueWorkloadRef): string {
  return `${ref.namespace ?? "-"}/${ref.name}`;
}

interface WorkloadSignals {
  readonly key: string;
  worstVuln: VulnSeverity | null;
  topVuln: IssueVulnInput | null;
  privileged: IssuePostureInput | null;
  identity: IssuePostureInput | null;
  exposure: IssueExposureInput | null;
  reachableFromExternal: IssueFlowInput | null;
  runtime: IssueRuntimeInput | null;
}

function ensure(map: Map<string, WorkloadSignals>, ref: IssueWorkloadRef): WorkloadSignals {
  const key = workloadKey(ref);
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created: WorkloadSignals = {
    key, worstVuln: null, topVuln: null, privileged: null, identity: null,
    exposure: null, reachableFromExternal: null, runtime: null,
  };
  map.set(key, created);
  return created;
}

function reachabilityOf(signals: WorkloadSignals): IssueReachability {
  if (signals.reachableFromExternal !== null) return "confirmed";
  if (signals.exposure !== null) return "theoretical";
  return "not_exposed";
}

function priorityOf(input: {
  readonly severity: IssueSeverity;
  readonly reachability: IssueReachability;
  readonly runtimeObserved: boolean;
  readonly privileged: boolean;
  readonly identity: boolean;
}): number {
  return SEVERITY_WEIGHT[input.severity] +
    (input.reachability === "confirmed" ? CONFIRMED_REACHABLE_BOOST : 0) +
    (input.runtimeObserved ? RUNTIME_BOOST : 0) +
    (input.privileged ? PRIVILEGE_BOOST : 0) +
    (input.identity ? IDENTITY_BOOST : 0);
}

function reachabilityFactor(signals: WorkloadSignals): IssueFactor {
  if (signals.reachableFromExternal !== null) {
    return {
      kind: "reachability",
      detail: `Confirmed reachable: external traffic forwarded to this workload${signals.reachableFromExternal.observedAt ? ` (observed ${signals.reachableFromExternal.observedAt})` : ""}`,
    };
  }
  return { kind: "reachability", detail: "Theoretical exposure only; no external flow has been observed" };
}

export function buildKubernetesIssues(input: {
  readonly vulnerabilities: readonly IssueVulnInput[];
  readonly posture: readonly IssuePostureInput[];
  readonly exposures: readonly IssueExposureInput[];
  readonly flows: readonly IssueFlowInput[];
  readonly runtime: readonly IssueRuntimeInput[];
}): KubernetesIssueReport {
  const map = new Map<string, WorkloadSignals>();

  for (const vuln of input.vulnerabilities) {
    const signals = ensure(map, vuln.workload);
    if (signals.worstVuln === null || VULN_RANK[vuln.severity] < VULN_RANK[signals.worstVuln]) {
      signals.worstVuln = vuln.severity;
      signals.topVuln = vuln;
    }
  }
  for (const control of input.posture) {
    const signals = ensure(map, control.workload);
    if (PRIVILEGE_CONTROLS.has(control.controlId) && signals.privileged === null) signals.privileged = control;
    if (IDENTITY_CONTROLS.has(control.controlId) && signals.identity === null) signals.identity = control;
  }
  for (const exposure of input.exposures) {
    const signals = ensure(map, exposure.workload);
    // Prefer the most external exposure kind for the workload.
    const rank = (kind: IssueExposureInput["kind"]) =>
      ({ internet: 0, load_balancer: 1, ingress: 2, service: 3 })[kind];
    if (signals.exposure === null || rank(exposure.kind) < rank(signals.exposure.kind)) {
      signals.exposure = exposure;
    }
  }
  for (const flow of input.flows) {
    if (!flow.fromExternal || flow.verdict !== "forwarded") continue;
    const signals = ensure(map, flow.workload);
    if (signals.reachableFromExternal === null) signals.reachableFromExternal = flow;
  }
  for (const event of input.runtime) {
    const signals = ensure(map, event.workload);
    if (signals.runtime === null) signals.runtime = event;
  }

  const issues: KubernetesIssue[] = [];
  const emit = (signals: WorkloadSignals, issue: Omit<KubernetesIssue, "id" | "workload" | "reachability" | "runtimeObserved" | "priority"> & { readonly severity: IssueSeverity }) => {
    const reachability = reachabilityOf(signals);
    const runtimeObserved = signals.runtime !== null;
    issues.push({
      ...issue,
      id: `${signals.key}::${issue.ruleId}`,
      workload: signals.key,
      reachability,
      runtimeObserved,
      priority: priorityOf({
        severity: issue.severity,
        reachability,
        runtimeObserved,
        privileged: signals.privileged !== null,
        identity: signals.identity !== null,
      }),
    });
  };

  for (const signals of map.values()) {
    const exposure = signals.exposure;
    const privileged = signals.privileged;
    const identity = signals.identity;
    const runtimeEvent = signals.runtime;
    const highOrCritical = signals.worstVuln === "critical" || signals.worstVuln === "high";
    const vulnFactor = signals.topVuln === null ? null : ({
      kind: "vulnerability" as const,
      detail: `${(signals.topVuln.cveId ?? signals.topVuln.title)} (${signals.worstVuln})`,
    });
    const runtimeFactor = runtimeEvent === null ? null : ({
      kind: "runtime" as const,
      detail: `Falco rule "${runtimeEvent.rule}" (${runtimeEvent.priority})`,
    });
    const vulnFix = signals.topVuln?.fixedVersion
      ? `Upgrade ${signals.topVuln.packageName ?? "the affected package"} to ${signals.topVuln.fixedVersion} or later, then rescan.`
      : "Review the scanner evidence and vendor advisory, then rescan.";

    // R1: exposed + high/critical vulnerability
    if (exposure !== null && highOrCritical && signals.topVuln !== null && vulnFactor !== null) {
      emit(signals, {
        ruleId: "exposed-vulnerable-workload",
        title: `Internet-reachable workload with a ${signals.worstVuln} vulnerability`,
        severity: signals.worstVuln === "critical" ? "critical" : "high",
        factors: [
          { kind: "exposure", detail: exposure.evidence },
          reachabilityFactor(signals),
          vulnFactor,
          ...(runtimeFactor ? [runtimeFactor] : []),
        ],
        recommendation: `Restrict exposure or patch first: ${vulnFix}`,
      });
    }
    // R2: exposed + privileged
    if (exposure !== null && privileged !== null) {
      emit(signals, {
        ruleId: "exposed-privileged-workload",
        title: "Privileged workload reachable from outside the cluster",
        severity: signals.reachableFromExternal !== null ? "critical" : "high",
        factors: [
          { kind: "exposure", detail: exposure.evidence },
          reachabilityFactor(signals),
          { kind: "privilege", detail: privileged.message },
        ],
        recommendation: "Drop the privileged security context or remove external exposure; a reachable privileged pod is a direct escalation target.",
      });
    }
    // R3: exposed + powerful identity
    if (exposure !== null && identity !== null) {
      emit(signals, {
        ruleId: "exposed-overpermissioned-identity",
        title: "Over-permissioned identity on a reachable workload",
        severity: "high",
        factors: [
          { kind: "exposure", detail: exposure.evidence },
          reachabilityFactor(signals),
          { kind: "identity", detail: identity.message },
        ],
        recommendation: "Scope the workload's RBAC to least privilege; a reachable pod with wildcard or escalation rights widens blast radius.",
      });
    }
    // R4: runtime activity + high/critical vulnerability
    if (runtimeEvent !== null && highOrCritical && signals.topVuln !== null && vulnFactor !== null && runtimeFactor !== null) {
      emit(signals, {
        ruleId: "runtime-active-vulnerable-workload",
        title: `Runtime activity on a workload with a ${signals.worstVuln} vulnerability`,
        severity: signals.worstVuln === "critical" ? "critical" : "high",
        factors: [runtimeFactor, vulnFactor, ...(exposure !== null ? [reachabilityFactor(signals)] : [])],
        recommendation: `Investigate the runtime event and patch: ${vulnFix}`,
      });
    }
    // R5: runtime activity + privileged
    if (runtimeEvent !== null && privileged !== null && runtimeFactor !== null) {
      emit(signals, {
        ruleId: "runtime-active-privileged-workload",
        title: "Runtime activity on a privileged workload",
        severity: "high",
        factors: [runtimeFactor, { kind: "privilege", detail: privileged.message }],
        recommendation: "Triage the runtime event with elevated urgency; a privileged pod magnifies the impact of any compromise.",
      });
    }
    // R6: critical vulnerability not already captured by an exposure/runtime issue
    if (signals.worstVuln === "critical" && exposure === null && runtimeEvent === null && signals.topVuln !== null && vulnFactor !== null) {
      emit(signals, {
        ruleId: "critical-vulnerability",
        title: "Critical vulnerability on a workload",
        severity: "critical",
        factors: [vulnFactor, { kind: "reachability", detail: "Not externally exposed and no runtime activity observed" }],
        recommendation: vulnFix,
      });
    }
  }

  issues.sort((left, right) =>
    right.priority - left.priority ||
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    left.workload.localeCompare(right.workload, "en-US") ||
    left.ruleId.localeCompare(right.ruleId, "en-US"));

  const totals = {
    critical: 0, high: 0, medium: 0, low: 0,
    issues: issues.length,
    confirmedReachable: issues.filter((issue) => issue.reachability === "confirmed").length,
    runtimeObserved: issues.filter((issue) => issue.runtimeObserved).length,
  };
  for (const issue of issues) totals[issue.severity] += 1;

  return { schema: "sutra.kubernetes-issues.v1", issues, totals, disclaimer: ISSUE_DISCLAIMER };
}
