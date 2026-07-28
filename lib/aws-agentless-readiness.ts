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
 * When the scanner container ships and its SDK calls are validated against a
 * live account, flip the two false flags here and the whole surface updates.
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
      id: "executor-not-live-validated",
      summary:
        "The AWS executor was written without ever calling AWS. It refuses to act until an "
        + "operator validates each EC2 call against a live account and constructs it with "
        + "liveValidated: true.",
      owner: "operator",
    },
    {
      id: "orchestrator-principal-unset",
      summary:
        "SutraAgentlessOrchestratorRole trusts only the account root, which grants nothing on "
        + "its own. Until a control-plane principal is given explicit sts:AssumeRole, nothing "
        + "can drive a scan.",
      owner: "operator",
    },
  ],
  summary:
    "Plans can be computed and reviewed today; nothing can be executed. A plan creates no "
    + "snapshot and costs nothing. An empty findings list therefore means NO SCAN HAS RUN — "
    + "it is not evidence that a volume is clean.",
};

/** True when every listed gap is closed. Kept as a function so callers cannot forget one. */
export function isAgentlessExecutionReady(readiness: AgentlessScanReadiness = AGENTLESS_SCAN_EXECUTION_READINESS): boolean {
  return readiness.canExecute && readiness.gaps.length === 0;
}
