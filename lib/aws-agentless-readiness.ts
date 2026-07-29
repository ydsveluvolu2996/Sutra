/**
 * What agentless scanning can and cannot do right now, stated as data.
 *
 * This exists so the answer lives in ONE place and reaches the UI and the API
 * unchanged. The failure mode it prevents is specific: a findings list that is
 * empty because no scan has ever run looks identical to a findings list that is
 * empty because nothing is wrong — and the second reading is the flattering one.
 * Every response carries this object so the distinction is never left to
 * inference.
 *
 * Live validation status, 2026-07-29: every EC2 response shape the executor depends
 * on was confirmed against a real account (CreateSnapshot/CopySnapshot/CreateVolume
 * all return their id at the top level; snapshot State is lowercase; OwnerId is
 * present on both CreateSnapshot and DescribeSnapshots; tag-on-create satisfies the
 * aws:RequestTag condition; the scan CMK works for both encrypt-on-copy and
 * decrypt-on-create-volume). See docs/agentless-snapshot-scanning-design.md for the
 * evidence. That closed the executor-not-live-validated gap and nothing more.
 *
 * Also 2026-07-29: the scanner image was built and pushed to ECR, the orchestrator
 * role was given a real trust policy AND moved to the /sutra/ path (the control-plane
 * instance role explicitly denies assuming anything outside it, so the trust policy
 * alone left the assume at explicitDeny), and execution was wired through the
 * collector — the only process that holds an AWS SDK. Along the way AWS settled the
 * compute question by refusing CAP_SYS_ADMIN on Fargate, which mounting requires, so
 * the model is one short-lived EC2 instance per scan.
 *
 * canExecute is therefore true: the CODE path is complete. That is a narrower claim
 * than it sounds and must not be read as more:
 *   * Whether a scan can run is a CONFIGURATION question, answered separately by
 *     resolveAgentlessExecutorConfig, which names every unset setting.
 *   * SUTRA_AGENTLESS_LIVE_VALIDATED is an OPERATOR attestation. No code here may set
 *     it, and it is not set today.
 *   * NOTHING has executed end to end against a live account. The individual EC2 call
 *     shapes were validated as an admin identity; the assembled path has not run.
 * An empty findings list still means NO SCAN HAS RUN.
 */

export interface AgentlessReadinessGap {
  /** Short machine-readable id for the missing piece. */
  readonly id: string;
  /** What is missing, in the operator's terms. */
  readonly summary: string;
  /** Who can close it. Some gaps are code; some need AWS access we do not have. */
  readonly owner: "engineering" | "operator";
}

export interface AgentlessScanReadiness {
  readonly schema: "sutra.aws-agentless-readiness.v1";
  /** True only when a plan can actually be applied end to end. */
  readonly canExecute: boolean;
  /** True when a plan can be computed and reviewed (free, no AWS calls). */
  readonly canPlan: boolean;
  readonly gaps: readonly AgentlessReadinessGap[];
  readonly summary: string;
}

export const AGENTLESS_SCAN_EXECUTION_READINESS: AgentlessScanReadiness = {
  schema: "sutra.aws-agentless-readiness.v1",
  canExecute: true,
  canPlan: true,
  // Both code gaps are closed: the compute model is an EC2 instance per scan (Fargate
  // rejects the CAP_SYS_ADMIN that mounting needs), and execution is wired through the
  // collector, which is the only process holding an AWS SDK. What remains is operator
  // configuration, and that is reported separately by resolveAgentlessExecutorConfig
  // with the exact list of unset names — so it does not belong here as prose.
  gaps: [],
  summary:
    "The execution path is complete in code: an EC2 instance per scan, driven by the "
    + "collector, with the customer session ceilinged by agentlessSnapshotSessionPolicy. "
    + "Whether a scan can actually run is now a CONFIGURATION question, answered by "
    + "resolveAgentlessExecutorConfig, which names every unset setting — and by the operator "
    + "attestation SUTRA_AGENTLESS_LIVE_VALIDATED, which no code may set for itself. NOTHING "
    + "here has executed against a live account end to end. A plan creates no snapshot and "
    + "costs nothing, and an empty findings list still means NO SCAN HAS RUN — it is never "
    + "evidence that a volume is clean.",
};

/** True when every listed gap is closed. Kept as a function so callers cannot forget one. */
export function isAgentlessExecutionReady(readiness: AgentlessScanReadiness = AGENTLESS_SCAN_EXECUTION_READINESS): boolean {
  return readiness.canExecute && readiness.gaps.length === 0;
}
