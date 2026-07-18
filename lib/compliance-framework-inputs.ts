// Adapters that turn Sutra's own control evaluations into the framework-readiness
// engine's input (`CollectedControlResult[]`). Two honest rules:
//   * Only real evaluated states cross over. AWS NOT_APPLICABLE/EXCEPTED and K8s
//     NOT_COLLECTED are dropped, NOT coerced to PASS — so a framework control they
//     map to reports NOT_COLLECTED (unknown), never a fabricated pass.
//   * A Sutra control id that appears more than once (e.g. the same K8s control in
//     several K8s frameworks) is collapsed to a single result, first evaluated
//     state wins; the readiness engine re-resolves conflicts conservatively anyway.
import type { ComplianceAssessment, ComplianceStatus } from "./compliance-engine.ts";
import type { CollectedControlResult, CollectedControlState } from "./compliance-frameworks.ts";

const VALID_K8S_STATES = new Set<CollectedControlState>(["PASS", "FAIL", "UNKNOWN"]);

/** The minimal shape of a stored Kubernetes control finding this adapter reads. */
export interface KubernetesControlFindingLike {
  readonly controlId: string;
  readonly state: string;
}

// PASS/FAIL/UNKNOWN carry through; NOT_APPLICABLE and EXCEPTED are not an evaluated
// pass/fail of the control itself, so they are dropped (-> NOT_COLLECTED downstream).
const AWS_STATE: Readonly<Record<ComplianceStatus, CollectedControlState | null>> = {
  PASS: "PASS",
  FAIL: "FAIL",
  UNKNOWN: "UNKNOWN",
  NOT_APPLICABLE: null,
  EXCEPTED: null,
};

/** AWS baseline assessment -> collected results keyed by Sutra AWS control id. */
export function awsCollectedControlResults(assessment: ComplianceAssessment): CollectedControlResult[] {
  return assessment.results.flatMap((result) => {
    const state = AWS_STATE[result.status];
    return state === null ? [] : [{ controlId: result.controlKey, state }];
  });
}

/**
 * Stored Kubernetes control findings -> collected results keyed by Sutra K8s
 * control id. Findings are per-subject (many rows per control); they are passed
 * through as-is and the readiness engine collapses them conservatively
 * (UNKNOWN > FAIL > PASS). Only PASS/FAIL/UNKNOWN cross over — any other state is
 * dropped rather than guessed.
 */
export function kubernetesCollectedControlResults(
  findings: readonly KubernetesControlFindingLike[],
): CollectedControlResult[] {
  return findings.flatMap((finding) =>
    VALID_K8S_STATES.has(finding.state as CollectedControlState)
      ? [{ controlId: finding.controlId, state: finding.state as CollectedControlState }]
      : [],
  );
}
