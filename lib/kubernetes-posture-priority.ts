// Context-ranked Kubernetes posture (KSPM prioritization). Standard KSPM tools
// return a flat list of control PASS/FAIL results and a CIS score; an operator
// then stares at dozens of failures with no idea which ones actually matter.
// This engine fuses the per-subject control results Sutra already produces into a
// risk-ranked view: it groups failures by workload/role, derives the toxic
// COMBINATIONS that make a misconfiguration dangerous (internet-exposed AND
// privileged AND over-permissioned), classifies each workload against the
// Kubernetes Pod Security Standards, maps every control to CIS / NSA-CISA / SOC 2
// readiness references, and attaches a concrete remediation. It is pure and
// deterministic, preserves the honest tri-state (an UNKNOWN control is never
// scored as a pass), and never invents evidence — a risk factor is asserted only
// from a control that actually FAILED with cited evidence.
import { mappingsForKubernetesControl } from "./kubernetes-compliance-catalog.ts";
import type { KubernetesControlResult, KubernetesPostureReport } from "./kubernetes-posture.ts";

export type PostureRiskFactor =
  | "internet-exposed"
  | "privileged"
  | "over-permissioned"
  | "unhardened"
  | "no-network-isolation";

// Highest Pod Security Standards level a workload can honestly claim from its
// collected evidence. "unknown" when the relevant evidence was not collected —
// never silently upgraded to restricted.
export type PodSecurityStandard = "restricted" | "baseline" | "privileged" | "unknown";

const SEVERITY_WEIGHT: Readonly<Record<KubernetesControlResult["severity"], number>> = {
  CRITICAL: 400, HIGH: 300, MEDIUM: 200, LOW: 100,
};
const SEVERITY_RANK: Readonly<Record<KubernetesControlResult["severity"], number>> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

// Which failing controls establish which risk factor.
const EXPOSURE_CONTROLS = new Set(["K8S-SERVICE-EXPOSURE", "K8S-INGRESS-TLS"]);
const PRIVILEGED_CONTROLS = new Set([
  "K8S-WORKLOAD-NO-PRIVILEGED", "K8S-WORKLOAD-HOST-NAMESPACES", "K8S-WORKLOAD-HOST-PATH", "K8S-WORKLOAD-CAPABILITIES",
]);
const OVER_PERMISSIONED_CONTROLS = new Set(["K8S-RBAC-WILDCARDS", "K8S-RBAC-ESCALATION"]);
const UNHARDENED_CONTROLS = new Set([
  "K8S-WORKLOAD-RUN-AS-NON-ROOT", "K8S-WORKLOAD-SECCOMP", "K8S-WORKLOAD-NO-PRIVILEGE-ESCALATION",
]);
const NETWORK_ISOLATION_CONTROLS = new Set(["K8S-NAMESPACE-NETWORK-POLICY"]);

// Pod Security Standards classification inputs: a baseline violation forces
// "privileged"; a restricted-only violation caps at "baseline".
const BASELINE_VIOLATION_CONTROLS = PRIVILEGED_CONTROLS;
const RESTRICTED_VIOLATION_CONTROLS = UNHARDENED_CONTROLS;

// Toxic-combination bands. Each band strictly dominates the residual severity
// (< 500), so ordering is exactly the intended precedence: an exposed + privileged
// workload outranks any single-issue workload regardless of that issue's severity.
const EXPOSED_PRIVILEGED = 4000; // internet-reachable AND privileged: the classic breakout path
const EXPOSED_OVERPERMISSIONED = 3000; // internet-reachable AND cluster-powerful RBAC
const PRIVILEGED_OVERPERMISSIONED = 1500; // privileged AND powerful RBAC (lateral movement)

const REMEDIATION_HINT: Readonly<Record<string, string>> = {
  "K8S-WORKLOAD-RUN-AS-NON-ROOT": "Set securityContext.runAsNonRoot: true (and a non-zero runAsUser).",
  "K8S-WORKLOAD-NO-PRIVILEGED": "Remove securityContext.privileged: true from every container.",
  "K8S-WORKLOAD-NO-PRIVILEGE-ESCALATION": "Set securityContext.allowPrivilegeEscalation: false.",
  "K8S-WORKLOAD-CAPABILITIES": "Drop ALL Linux capabilities and add back only what the workload needs.",
  "K8S-WORKLOAD-SECCOMP": "Set securityContext.seccompProfile.type: RuntimeDefault.",
  "K8S-WORKLOAD-HOST-NAMESPACES": "Remove hostNetwork/hostPID/hostIPC from the pod spec.",
  "K8S-WORKLOAD-HOST-PATH": "Replace hostPath volumes with a scoped volume type (PVC, emptyDir, projected).",
  "K8S-IMAGE-DIGEST": "Pin images to an immutable sha256 digest instead of a mutable tag.",
  "K8S-IMAGE-NO-LATEST": "Replace the :latest tag with a pinned version or digest.",
  "K8S-WORKLOAD-RESOURCES": "Set CPU/memory requests and limits on every container.",
  "K8S-WORKLOAD-PROBES": "Add liveness and readiness probes to every container.",
  "K8S-SERVICE-EXPOSURE": "Confirm the Service must be externally reachable; prefer ClusterIP + an ingress with policy.",
  "K8S-INGRESS-TLS": "Terminate the Ingress with TLS and redirect plaintext.",
  "K8S-RBAC-WILDCARDS": "Replace wildcard verbs/resources/apiGroups with an explicit least-privilege list.",
  "K8S-RBAC-ESCALATION": "Remove escalate/bind/impersonate and secret-wide grants from the role.",
  "K8S-NAMESPACE-POD-SECURITY": "Label the namespace with a Pod Security Admission enforce level (baseline/restricted).",
  "K8S-NAMESPACE-NETWORK-POLICY": "Add a default-deny NetworkPolicy and explicit allow rules for the namespace.",
};

export interface PostureFrameworkRefs {
  readonly cis: readonly string[];
  readonly nsaCisa: readonly string[];
  readonly soc2: readonly string[];
}

export interface PrioritizedPostureFinding {
  readonly controlId: string;
  readonly subject: string;
  readonly severity: KubernetesControlResult["severity"];
  readonly state: "FAIL" | "UNKNOWN";
  readonly message: string;
  readonly evidence: readonly string[];
  readonly riskFactors: readonly PostureRiskFactor[];
  readonly frameworks: PostureFrameworkRefs;
  readonly remediationHint: string;
  readonly priorityScore: number;
  readonly priorityRank: number;
}

export interface PostureSubjectRollup {
  readonly subject: string;
  readonly podSecurityStandard: PodSecurityStandard;
  readonly riskFactors: readonly PostureRiskFactor[];
  readonly failCount: number;
  readonly unknownCount: number;
  readonly worstSeverity: KubernetesControlResult["severity"] | null;
  readonly priorityScore: number;
}

export interface KubernetesPosturePriorityReport {
  readonly schema: "sutra.kubernetes-posture-priority.v1";
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly findings: readonly PrioritizedPostureFinding[];
  readonly workloads: readonly PostureSubjectRollup[];
  readonly summary: {
    readonly evaluated: number;
    readonly failing: number;
    readonly unknown: number;
    readonly podSecurityStandards: Readonly<Record<PodSecurityStandard, number>>;
    readonly topRiskWorkloads: number;
  };
  readonly disclaimer: string;
}

const DISCLAIMER =
  "Prioritization ranks the control results Sutra actually collected by fusing each finding with the " +
  "workload's observed exposure, privilege and RBAC power; a risk factor is asserted only from a control " +
  "that FAILED with cited evidence, and an UNKNOWN control is never scored as a pass. Pod Security Standard " +
  "levels and CIS/NSA/SOC 2 references are informative readiness relationships, not a certification.";

function frameworkRefs(controlId: string): PostureFrameworkRefs {
  const mappings = mappingsForKubernetesControl(controlId);
  const refs = (key: string): readonly string[] =>
    mappings.filter((mapping) => mapping.framework === key).flatMap((mapping) => mapping.references);
  return {
    cis: refs("cis-kubernetes-readiness"),
    nsaCisa: refs("nsa-cisa-kubernetes-hardening"),
    soc2: refs("soc-2-readiness"),
  };
}

function podSecurityStandard(controls: readonly KubernetesControlResult[]): PodSecurityStandard {
  const relevant = controls.filter(
    (control) => BASELINE_VIOLATION_CONTROLS.has(control.controlId) || RESTRICTED_VIOLATION_CONTROLS.has(control.controlId),
  );
  if (relevant.length === 0) return "unknown";
  if (relevant.some((control) => BASELINE_VIOLATION_CONTROLS.has(control.controlId) && control.state === "FAIL")) {
    return "privileged"; // violates baseline → only the privileged profile permits it
  }
  if (relevant.some((control) => RESTRICTED_VIOLATION_CONTROLS.has(control.controlId) && control.state === "FAIL")) {
    return "baseline"; // meets baseline, fails a restricted requirement
  }
  // No failing baseline/restricted control. Only claim "restricted" when every
  // relevant control actually passed; a single UNKNOWN keeps it honest.
  if (relevant.every((control) => control.state === "PASS")) return "restricted";
  return "unknown";
}

function riskFactorsFor(failing: readonly KubernetesControlResult[]): PostureRiskFactor[] {
  const factors = new Set<PostureRiskFactor>();
  for (const control of failing) {
    if (EXPOSURE_CONTROLS.has(control.controlId)) factors.add("internet-exposed");
    if (PRIVILEGED_CONTROLS.has(control.controlId)) factors.add("privileged");
    if (OVER_PERMISSIONED_CONTROLS.has(control.controlId)) factors.add("over-permissioned");
    if (UNHARDENED_CONTROLS.has(control.controlId)) factors.add("unhardened");
    if (NETWORK_ISOLATION_CONTROLS.has(control.controlId)) factors.add("no-network-isolation");
  }
  return [...factors];
}

function combinationBonus(factors: ReadonlySet<PostureRiskFactor>): number {
  let bonus = 0;
  if (factors.has("internet-exposed") && factors.has("privileged")) bonus += EXPOSED_PRIVILEGED;
  if (factors.has("internet-exposed") && factors.has("over-permissioned")) bonus += EXPOSED_OVERPERMISSIONED;
  if (factors.has("privileged") && factors.has("over-permissioned")) bonus += PRIVILEGED_OVERPERMISSIONED;
  return bonus;
}

export function prioritizeKubernetesPosture(report: KubernetesPostureReport): KubernetesPosturePriorityReport {
  const bySubject = new Map<string, KubernetesControlResult[]>();
  for (const result of report.results) {
    const existing = bySubject.get(result.subject);
    if (existing === undefined) bySubject.set(result.subject, [result]);
    else existing.push(result);
  }

  const subjectContext = new Map<string, { factors: PostureRiskFactor[]; bonus: number; pss: PodSecurityStandard }>();
  const workloads: PostureSubjectRollup[] = [];
  for (const [subject, controls] of bySubject) {
    const failing = controls.filter((control) => control.state === "FAIL");
    const unknown = controls.filter((control) => control.state === "UNKNOWN");
    const factors = riskFactorsFor(failing);
    const factorSet = new Set(factors);
    const bonus = combinationBonus(factorSet);
    const pss = podSecurityStandard(controls);
    subjectContext.set(subject, { factors, bonus, pss });
    const worstSeverity = failing.length === 0
      ? null
      : failing.reduce<KubernetesControlResult["severity"]>(
        (worst, control) => (SEVERITY_RANK[control.severity] < SEVERITY_RANK[worst] ? control.severity : worst),
        "LOW",
      );
    const priorityScore = failing.length === 0 && unknown.length === 0
      ? 0
      : bonus + Math.max(0, ...failing.map((control) => SEVERITY_WEIGHT[control.severity]));
    workloads.push({
      subject, podSecurityStandard: pss, riskFactors: factors,
      failCount: failing.length, unknownCount: unknown.length, worstSeverity, priorityScore,
    });
  }

  const graded = report.results
    .filter((control) => control.state === "FAIL" || control.state === "UNKNOWN")
    .map((control) => {
      const context = subjectContext.get(control.subject);
      const factors = context?.factors ?? [];
      const bonus = context?.bonus ?? 0;
      // A finding inherits its subject's combination bonus so a MEDIUM control on
      // an exposed+privileged workload outranks a HIGH control on an isolated one.
      const priorityScore = SEVERITY_WEIGHT[control.severity] + (control.state === "FAIL" ? bonus : 0);
      return {
        controlId: control.controlId,
        subject: control.subject,
        severity: control.severity,
        state: control.state as "FAIL" | "UNKNOWN",
        message: control.message,
        evidence: control.evidence,
        riskFactors: factors,
        frameworks: frameworkRefs(control.controlId),
        remediationHint: REMEDIATION_HINT[control.controlId] ?? "Review the control evidence and apply the least-privilege configuration.",
        priorityScore,
        priorityRank: 0,
      };
    });

  graded.sort((left, right) =>
    right.priorityScore - left.priorityScore ||
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    (left.state === right.state ? 0 : left.state === "FAIL" ? -1 : 1) ||
    left.subject.localeCompare(right.subject, "en-US") ||
    left.controlId.localeCompare(right.controlId, "en-US"));
  const findings = graded.map((finding, index) => ({ ...finding, priorityRank: index + 1 }));

  workloads.sort((left, right) =>
    right.priorityScore - left.priorityScore ||
    left.subject.localeCompare(right.subject, "en-US"));

  const podSecurityStandards: Record<PodSecurityStandard, number> = { restricted: 0, baseline: 0, privileged: 0, unknown: 0 };
  for (const workload of workloads) podSecurityStandards[workload.podSecurityStandard] += 1;

  return {
    schema: "sutra.kubernetes-posture-priority.v1",
    clusterId: report.clusterId,
    collectedAt: report.collectedAt,
    findings,
    workloads,
    summary: {
      evaluated: report.results.length,
      failing: report.results.filter((control) => control.state === "FAIL").length,
      unknown: report.results.filter((control) => control.state === "UNKNOWN").length,
      podSecurityStandards,
      topRiskWorkloads: workloads.filter((workload) => workload.priorityScore >= PRIVILEGED_OVERPERMISSIONED).length,
    },
    disclaimer: DISCLAIMER,
  };
}
