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
 * Also 2026-07-29, and the reason canExecute is still false: the scanner image was
 * built and pushed to ECR, and the orchestrator role was given a real trust policy
 * — so the two gaps listed here previously are genuinely closed. Verifying them end
 * to end then surfaced a harder one. The scanner mounts a block device, mounting
 * needs CAP_SYS_ADMIN, and Fargate refuses that capability, so the compute this
 * stack provisions cannot host a scan at all. Two closed gaps and one larger open
 * one is a worse position than it looks on a count, which is exactly why these are
 * data rather than a number.
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
      id: "scanner-compute-model-unresolved",
      summary:
        "The scan compute model does not exist yet, and the one the stack provisions cannot "
        + "work. Mounting a block device requires CAP_SYS_ADMIN, and AWS rejects that outright "
        + "on Fargate — RegisterTaskDefinition with FARGATE plus SYS_ADMIN fails with "
        + "'SYS_ADMIN is not allowed on Fargate' (checked 2026-07-29; the same definition under "
        + "the EC2 launch type registers fine). ScanCluster is Fargate-only and there is no task "
        + "definition at all, so a scan has no host. Closing this is a decision about compute "
        + "(ECS on EC2 capacity, a per-scan EC2 instance, or reading snapshot blocks via the EBS "
        + "direct APIs and never mounting), not a missing line of glue.",
      owner: "engineering",
    },
    {
      id: "no-orchestrator-client-factory",
      summary:
        "Nothing constructs an Ec2AgentlessExecutor. customerClientFor and scanClientFor are "
        + "injected seams with no production implementation, so the apply path throws "
        + "NOT_CONFIGURED after the readiness gate rather than driving a scan.",
      owner: "engineering",
    },
  ],
  summary:
    "Plans can be computed and reviewed today; nothing can be executed. The AWS response "
    + "shapes are validated against a live account (2026-07-29), the scanner image is built and "
    + "in ECR, and the orchestrator role now trusts the control-plane principal — but there is "
    + "still no compute that can host a scan, because mounting needs CAP_SYS_ADMIN and Fargate "
    + "refuses it. A plan creates no snapshot and costs nothing. An empty findings list "
    + "therefore means NO SCAN HAS RUN — it is not evidence that a volume is clean.",
};

/** True when every listed gap is closed. Kept as a function so callers cannot forget one. */
export function isAgentlessExecutionReady(readiness: AgentlessScanReadiness = AGENTLESS_SCAN_EXECUTION_READINESS): boolean {
  return readiness.canExecute && readiness.gaps.length === 0;
}
