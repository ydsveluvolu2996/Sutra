import {
  KUBERNETES_COMPLIANCE_CONTROLS,
  KUBERNETES_COMPLIANCE_FRAMEWORKS,
  type KubernetesComplianceFramework,
  type KubernetesComplianceFrameworkKey,
} from "./kubernetes-compliance-catalog.ts";

export type KubernetesReadinessControlState = "PASS" | "FAIL" | "UNKNOWN" | "NOT_COLLECTED";

export type KubernetesReadinessSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface KubernetesReadinessEvidenceInput {
  readonly controlId: string;
  readonly state: "PASS" | "FAIL" | "UNKNOWN";
  readonly severity: KubernetesReadinessSeverity;
  readonly subject: string;
  /** Cited observations from the posture engine; preserved for the audit trail. */
  readonly evidence?: readonly string[];
}

export interface KubernetesReadinessFailedSubject {
  readonly subject: string;
  readonly severity: KubernetesReadinessSeverity;
  readonly evidence: readonly string[];
}

export interface KubernetesReadinessControl {
  readonly controlId: string;
  readonly title: string;
  readonly references: readonly string[];
  readonly mappingNote: string;
  readonly state: KubernetesReadinessControlState;
  /** Highest severity among failing findings for this control; null when none fail. */
  readonly severity: KubernetesReadinessSeverity | null;
  readonly remediation: string;
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly failedSubjects: readonly string[];
  /** Per-failed-subject cited evidence — the auditor's drill-down trail. */
  readonly failedSubjectEvidence: readonly KubernetesReadinessFailedSubject[];
}

export interface KubernetesReadinessFramework {
  readonly framework: KubernetesComplianceFramework;
  readonly controls: readonly KubernetesReadinessControl[];
  readonly summary: Readonly<Record<KubernetesReadinessControlState, number>>;
}

export interface KubernetesComplianceReadinessReport {
  readonly schema: "sutra.kubernetes-compliance-readiness.v1";
  readonly collectedAt: string | null;
  readonly frameworks: readonly KubernetesReadinessFramework[];
  readonly unmappedControlIds: readonly string[];
  readonly disclaimer: string;
}

const READINESS_DISCLAIMER =
  "Readiness mapping over collected point-in-time evidence only; " +
  "not a certification, audit opinion, or proof of operating effectiveness.";

const MAXIMUM_FAILED_SUBJECTS = 10;

const SEVERITY_RANK: Readonly<Record<KubernetesReadinessSeverity, number>> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

// Deterministic remediation guidance keyed on the control id family, mirroring
// the guidance the posture projection surfaces. Kept here so the readiness
// report (and any exported evidence pack) carries a fix for every failing
// control without depending on the UI layer.
function remediationForControl(controlId: string): string {
  if (controlId.includes("RBAC")) return "Grant only the exact verbs and resources required; remove wildcard, bind, escalate and impersonate grants.";
  if (controlId.includes("PRIVILEG") || controlId.includes("HOST")) return "Harden the pod security context; remove privileged mode, host namespaces, hostPath mounts and privilege escalation that is not explicitly required.";
  if (controlId.includes("IMAGE")) return "Pin workloads to an immutable image digest and validate images through the approved registry pipeline.";
  if (controlId.includes("SECCOMP") || controlId.includes("CAPABILIT")) return "Set a RuntimeDefault (or Localhost) seccomp profile and drop ALL Linux capabilities, adding back only those required.";
  if (controlId.includes("NETWORK") || controlId.includes("SERVICE") || controlId.includes("INGRESS")) return "Restrict exposure and apply a NetworkPolicy proven to select the workload; require TLS on every ingress host.";
  if (controlId.includes("NAMESPACE") || controlId.includes("POD-SECURITY")) return "Set the namespace Pod Security Admission enforce label to restricted.";
  if (controlId.includes("RESOURCE") || controlId.includes("PROBE")) return "Declare reviewed CPU/memory requests and limits and liveness/readiness probes for every container.";
  return "Review the cited evidence, apply the least-privilege Kubernetes configuration, and rescan to confirm the result.";
}

function highestSeverity(severities: readonly KubernetesReadinessSeverity[]): KubernetesReadinessSeverity | null {
  return severities.length === 0
    ? null
    : [...severities].sort((left, right) => SEVERITY_RANK[left] - SEVERITY_RANK[right])[0];
}

const EXTERNAL_FRAMEWORK_KEYS: readonly Exclude<
  KubernetesComplianceFrameworkKey,
  "sutra-kubernetes-baseline"
>[] = ["cis-kubernetes-readiness", "nsa-cisa-kubernetes-hardening", "soc-2-readiness"];

function controlState(input: {
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
}): KubernetesReadinessControlState {
  if (input.passCount + input.failCount + input.unknownCount === 0) return "NOT_COLLECTED";
  if (input.failCount > 0) return "FAIL";
  if (input.unknownCount > 0) return "UNKNOWN";
  return "PASS";
}

export function buildKubernetesComplianceReadinessReport(input: {
  readonly findings: readonly KubernetesReadinessEvidenceInput[];
  readonly collectedAt: string | null;
}): KubernetesComplianceReadinessReport {
  const catalogControlIds = new Set(
    KUBERNETES_COMPLIANCE_CONTROLS.map((control) => control.controlId),
  );
  const byControl = new Map<string, KubernetesReadinessEvidenceInput[]>();
  const unmapped = new Set<string>();
  for (const finding of input.findings) {
    if (!catalogControlIds.has(finding.controlId)) {
      unmapped.add(finding.controlId);
      continue;
    }
    const existing = byControl.get(finding.controlId);
    if (existing === undefined) byControl.set(finding.controlId, [finding]);
    else existing.push(finding);
  }

  const frameworks = EXTERNAL_FRAMEWORK_KEYS.map((frameworkKey) => {
    const framework = KUBERNETES_COMPLIANCE_FRAMEWORKS.find(
      (candidate) => candidate.key === frameworkKey,
    );
    if (framework === undefined) {
      throw new Error(`Kubernetes compliance framework ${frameworkKey} is not in the catalog`);
    }
    const controls: KubernetesReadinessControl[] = [];
    for (const control of KUBERNETES_COMPLIANCE_CONTROLS) {
      const mapping = control.mappings.find((candidate) => candidate.framework === frameworkKey);
      if (mapping === undefined) continue;
      const results = byControl.get(control.controlId) ?? [];
      const passCount = results.filter((result) => result.state === "PASS").length;
      const failed = results.filter((result) => result.state === "FAIL");
      const failCount = failed.length;
      const unknownCount = results.filter((result) => result.state === "UNKNOWN").length;
      const failedSubjectEvidence: KubernetesReadinessFailedSubject[] = [];
      const seenSubjects = new Set<string>();
      for (const result of failed) {
        if (seenSubjects.has(result.subject) || failedSubjectEvidence.length >= MAXIMUM_FAILED_SUBJECTS) continue;
        seenSubjects.add(result.subject);
        failedSubjectEvidence.push({
          subject: result.subject,
          severity: result.severity,
          evidence: [...(result.evidence ?? [])].sort((left, right) => left.localeCompare(right, "en-US")),
        });
      }
      controls.push({
        controlId: control.controlId,
        title: control.title,
        references: mapping.references,
        mappingNote: mapping.note,
        state: controlState({ passCount, failCount, unknownCount }),
        severity: highestSeverity(failed.map((result) => result.severity)),
        remediation: remediationForControl(control.controlId),
        passCount,
        failCount,
        unknownCount,
        failedSubjects: failedSubjectEvidence.map((entry) => entry.subject),
        failedSubjectEvidence,
      });
    }
    const summary: Record<KubernetesReadinessControlState, number> = {
      PASS: 0,
      FAIL: 0,
      UNKNOWN: 0,
      NOT_COLLECTED: 0,
    };
    for (const control of controls) summary[control.state] += 1;
    return { framework, controls, summary };
  });

  return {
    schema: "sutra.kubernetes-compliance-readiness.v1",
    collectedAt: input.collectedAt,
    frameworks,
    unmappedControlIds: [...unmapped].sort((left, right) => left.localeCompare(right, "en-US")),
    disclaimer: READINESS_DISCLAIMER,
  };
}
