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
 * evidence. That closed the executor-not-live-validated gap and nothing more — the
 * remaining gaps are still open, so canExecute stays false.
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
  canExecute: false,
  canPlan: true,
  gaps: [
    {
      id: "scanner-container",
      summary:
        "No scanner container image exists. The ECR repository is provisioned but empty, "
        + "so there is nothing to mount a volume and run the scanners.",
      owner: "engineering",
    },
    {
      id: "orchestrator-principal-unset",
      summary:
        "SutraAgentlessOrchestratorRole trusts only the account root, which grants nothing on "
        + "its own. Until a control-plane principal is given explicit sts:AssumeRole, nothing "
        + "can drive a scan. NOTE: the 2026-07-29 live validation ran as an ADMIN identity, so "
        + "it proves the AWS response shapes but NOT that this far narrower role plus "
        + "agentlessSnapshotSessionPolicy can make the same calls. Re-run the validation as the "
        + "orchestrator role once the principal is set.",
      owner: "operator",
    },
  ],
  summary:
    "Plans can be computed and reviewed today; nothing can be executed. The AWS calls "
    + "themselves are now validated against a live account (2026-07-29), so what remains is a "
    + "scanner image and an orchestrator principal — not unknown API behaviour. A plan creates "
    + "no snapshot and costs nothing. An empty findings list therefore means NO SCAN HAS RUN — "
    + "it is not evidence that a volume is clean.",
};

/** True when every listed gap is closed. Kept as a function so callers cannot forget one. */
export function isAgentlessExecutionReady(readiness: AgentlessScanReadiness = AGENTLESS_SCAN_EXECUTION_READINESS): boolean {
  return readiness.canExecute && readiness.gaps.length === 0;
}
