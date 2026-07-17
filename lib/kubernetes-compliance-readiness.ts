import {
  KUBERNETES_COMPLIANCE_CONTROLS,
  KUBERNETES_COMPLIANCE_FRAMEWORKS,
  type KubernetesComplianceFramework,
  type KubernetesComplianceFrameworkKey,
} from "./kubernetes-compliance-catalog.ts";

export type KubernetesReadinessControlState = "PASS" | "FAIL" | "UNKNOWN" | "NOT_COLLECTED";

export interface KubernetesReadinessEvidenceInput {
  readonly controlId: string;
  readonly state: "PASS" | "FAIL" | "UNKNOWN";
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly subject: string;
}

export interface KubernetesReadinessControl {
  readonly controlId: string;
  readonly title: string;
  readonly references: readonly string[];
  readonly mappingNote: string;
  readonly state: KubernetesReadinessControlState;
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly failedSubjects: readonly string[];
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
      const failCount = results.filter((result) => result.state === "FAIL").length;
      const unknownCount = results.filter((result) => result.state === "UNKNOWN").length;
      controls.push({
        controlId: control.controlId,
        title: control.title,
        references: mapping.references,
        mappingNote: mapping.note,
        state: controlState({ passCount, failCount, unknownCount }),
        passCount,
        failCount,
        unknownCount,
        failedSubjects: [...new Set(
          results.filter((result) => result.state === "FAIL").map((result) => result.subject),
        )].slice(0, MAXIMUM_FAILED_SUBJECTS),
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
