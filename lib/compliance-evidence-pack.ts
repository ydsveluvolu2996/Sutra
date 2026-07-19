// Unified compliance evidence pack: a single, deterministic artifact that binds
// together the AWS baseline assessment (with governed exceptions applied), the
// Kubernetes readiness report, and the cross-framework readiness — with one
// merged provenance block naming every underlying snapshot/scan and catalog
// version. It is a pure assembler: it embeds already-computed, already-honest
// reports verbatim (so the "no evidence -> UNKNOWN/NOT_COLLECTED, never PASS"
// invariant is preserved end to end) and adds a roll-up summary. It takes no
// wall-clock input and computes no hash — the API layer stamps the canonical
// bytes with a report SHA-256 and an attestation envelope so the deterministic
// core stays reproducible and testable.
import type { ComplianceAssessmentWithExceptions } from "./compliance-exception-types.ts";
import type { FrameworkReadiness, ReadinessState } from "./compliance-frameworks.ts";
import type {
  KubernetesComplianceReadinessReport,
  KubernetesReadinessControlState,
} from "./kubernetes-compliance-readiness.ts";

export interface ComplianceEvidencePackProvenance {
  readonly awsSnapshotId: string | null;
  readonly awsSnapshotSha256: string | null;
  readonly awsSnapshotCollectedAt: string | null;
  readonly awsCoverageState: "complete" | "partial" | null;
  readonly kubernetesCollectedAt: string | null;
  readonly kubernetesScanSha256: string | null;
  readonly awsCatalog: { readonly key: string; readonly version: string };
}

export interface ComplianceEvidencePackSummary {
  readonly awsScorePercent: number | null;
  readonly aws: {
    readonly total: number;
    readonly pass: number;
    readonly fail: number;
    readonly unknown: number;
    readonly notApplicable: number;
    readonly excepted: number;
  };
  /** Distinct Kubernetes control ids rolled up to their worst observed state. */
  readonly kubernetes: Readonly<Record<KubernetesReadinessControlState, number>>;
  readonly frameworkCount: number;
}

export interface ComplianceEvidencePack {
  readonly schema: "sutra.compliance-evidence-pack.v1";
  readonly summary: ComplianceEvidencePackSummary;
  readonly aws: ComplianceAssessmentWithExceptions;
  readonly kubernetes: KubernetesComplianceReadinessReport;
  readonly frameworks: readonly FrameworkReadiness[];
  readonly provenance: ComplianceEvidencePackProvenance;
  readonly disclaimer: string;
}

const PACK_DISCLAIMER =
  "This evidence pack is a point-in-time assembly of Sutra's AWS baseline " +
  "assessment, Kubernetes readiness, and cross-framework readiness over the " +
  "exact collected evidence named in the provenance block. Absence of evidence " +
  "is reported as UNKNOWN/NOT_COLLECTED and never as a pass. It is not a " +
  "certification, audit opinion, or proof of operating effectiveness; the " +
  "customer and its independent auditor determine applicability.";

// Worst-state wins so a control that fails under any framework mapping is not
// masked by a pass elsewhere. Ranked FAIL > UNKNOWN > NOT_COLLECTED > PASS.
const K8S_STATE_RANK: Readonly<Record<KubernetesReadinessControlState, number>> = {
  FAIL: 0, UNKNOWN: 1, NOT_COLLECTED: 2, PASS: 3,
};

function rollupKubernetes(
  readiness: KubernetesComplianceReadinessReport,
): Readonly<Record<KubernetesReadinessControlState, number>> {
  const worstByControl = new Map<string, KubernetesReadinessControlState>();
  for (const framework of readiness.frameworks) {
    for (const control of framework.controls) {
      const current = worstByControl.get(control.controlId);
      if (current === undefined || K8S_STATE_RANK[control.state] < K8S_STATE_RANK[current]) {
        worstByControl.set(control.controlId, control.state);
      }
    }
  }
  const counts: Record<KubernetesReadinessControlState, number> = { PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_COLLECTED: 0 };
  for (const state of worstByControl.values()) counts[state] += 1;
  return counts;
}

export function buildComplianceEvidencePack(input: {
  readonly aws: ComplianceAssessmentWithExceptions;
  readonly kubernetes: KubernetesComplianceReadinessReport;
  readonly frameworks: readonly FrameworkReadiness[];
  readonly kubernetesScanSha256?: string | null;
}): ComplianceEvidencePack {
  const { aws, kubernetes, frameworks } = input;
  // Frameworks are embedded in a deterministic order regardless of input order.
  const orderedFrameworks = [...frameworks].sort((left, right) =>
    left.framework.id.localeCompare(right.framework.id, "en-US"));

  const summary: ComplianceEvidencePackSummary = {
    awsScorePercent: aws.summary.scorePercent,
    aws: {
      total: aws.summary.total,
      pass: aws.summary.pass,
      fail: aws.summary.fail,
      unknown: aws.summary.unknown,
      notApplicable: aws.summary.notApplicable,
      excepted: aws.summary.excepted,
    },
    kubernetes: rollupKubernetes(kubernetes),
    frameworkCount: orderedFrameworks.length,
  };

  return {
    schema: "sutra.compliance-evidence-pack.v1",
    summary,
    aws,
    kubernetes,
    frameworks: orderedFrameworks,
    provenance: {
      awsSnapshotId: aws.provenance.snapshotId,
      awsSnapshotSha256: aws.provenance.snapshotSha256,
      awsSnapshotCollectedAt: aws.provenance.snapshotCollectedAt,
      awsCoverageState: aws.provenance.snapshotCoverageState,
      kubernetesCollectedAt: kubernetes.collectedAt,
      kubernetesScanSha256: input.kubernetesScanSha256 ?? null,
      awsCatalog: { key: aws.catalog.key, version: aws.catalog.version },
    },
    disclaimer: PACK_DISCLAIMER,
  };
}

// Re-exported for callers that need the framework state union alongside the pack.
export type { ReadinessState };
