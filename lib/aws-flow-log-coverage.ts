/**
 * VPC Flow Log COVERAGE — which VPCs have network logging, and which are blind.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 * `ec2:DescribeFlowLogs` returns flow log CONFIGURATION, not flow records. The
 * records live in a CloudWatch Logs group or an S3 bucket and need separate
 * permissions (`logs:FilterLogEvents` / `s3:GetObject`) that Sutra's customer
 * role does NOT hold. So this engine answers "is this VPC observable?" — it does
 * not answer "what talked to what".
 *
 * Shipped first deliberately, because it is the question with an actionable
 * answer. A VPC with no flow log is a permanent investigative blind spot: when
 * something happens there the evidence does not exist and cannot be recovered
 * retroactively. It also covers customers on the VPC CNI, who get nothing from
 * the Hubble path because Hubble requires Cilium.
 *
 * Flow RECORD ingestion is a separate, larger piece needing new permissions and
 * a data-volume decision. This engine states its own boundary rather than letting
 * "coverage" be read as "visibility".
 */

export type FlowLogDestination = "cloud-watch-logs" | "s3" | "kinesis-data-firehose" | "unknown";
export type FlowLogTrafficType = "ACCEPT" | "REJECT" | "ALL" | "unknown";

/** One flow log as DescribeFlowLogs reports it, normalized. */
export interface FlowLogConfig {
  readonly flowLogId: string;
  /** The VPC, subnet or ENI this log covers. */
  readonly resourceId: string;
  readonly destination: FlowLogDestination;
  readonly trafficType: FlowLogTrafficType;
  /** ACTIVE is the only state that produces records. */
  readonly status: string;
  readonly region: string;
}

export interface VpcUnderReview {
  readonly vpcId: string;
  readonly region: string;
  readonly isDefault: boolean;
  readonly subnetIds: readonly string[];
}

export type CoverageLevel =
  /** An ACTIVE log covering the VPC itself — the strongest form. */
  | "vpc"
  /** No VPC-level log, but every subnet is covered individually. */
  | "all-subnets"
  /** Some subnets covered, some not — partial, and easy to misread as covered. */
  | "partial-subnets"
  /** A log exists but is not ACTIVE, so it produces nothing. */
  | "configured-inactive"
  | "none";

export interface VpcCoverage {
  readonly vpcId: string;
  readonly region: string;
  readonly isDefault: boolean;
  readonly level: CoverageLevel;
  /** True only for `vpc` and `all-subnets`. */
  readonly observable: boolean;
  readonly trafficType: FlowLogTrafficType;
  /**
   * REJECT-only logging is a real trap: it looks like coverage but cannot answer
   * "what did the attacker successfully reach", which is the question that
   * matters during an investigation.
   */
  readonly acceptedTrafficRecorded: boolean;
  readonly coveredSubnets: number;
  readonly totalSubnets: number;
  readonly flowLogIds: readonly string[];
  readonly gapReason: string | null;
}

export interface FlowLogCoverageReport {
  readonly schema: "sutra.aws-flow-log-coverage.v1";
  readonly vpcs: readonly VpcCoverage[];
  readonly summary: {
    readonly total: number;
    readonly observable: number;
    readonly blind: number;
    readonly partial: number;
    readonly inactive: number;
    /** Observable but REJECT-only — coverage that cannot answer the key question. */
    readonly rejectOnly: number;
  };
  readonly claimBoundary: "FLOW_LOG_CONFIGURATION_ONLY_NOT_FLOW_RECORDS";
  readonly disclaimer: string;
}

const DISCLAIMER =
  "Coverage is derived from ec2:DescribeFlowLogs configuration only. Sutra does "
  + "not read the flow records themselves — those live in CloudWatch Logs or S3 "
  + "and need permissions this role does not hold. An observable VPC means the "
  + "evidence is being recorded, NOT that Sutra has analysed it. A blind VPC is "
  + "the actionable finding: its traffic history does not exist and cannot be "
  + "recovered after the fact.";

/** Only ACTIVE logs record anything; anything else is configuration theatre. */
function isActive(config: FlowLogConfig): boolean {
  return config.status.toUpperCase() === "ACTIVE";
}

export function buildFlowLogCoverage(input: {
  readonly vpcs: readonly VpcUnderReview[];
  readonly flowLogs: readonly FlowLogConfig[];
}): FlowLogCoverageReport {
  const byResource = new Map<string, FlowLogConfig[]>();
  for (const log of input.flowLogs) {
    const existing = byResource.get(log.resourceId) ?? [];
    existing.push(log);
    byResource.set(log.resourceId, existing);
  }

  const vpcs: VpcCoverage[] = input.vpcs
    .map((vpc): VpcCoverage => {
      const vpcLogs = byResource.get(vpc.vpcId) ?? [];
      const activeVpcLogs = vpcLogs.filter(isActive);
      const subnetLogs = vpc.subnetIds.map((subnetId) => ({
        subnetId,
        all: byResource.get(subnetId) ?? [],
        active: (byResource.get(subnetId) ?? []).filter(isActive),
      }));
      const coveredSubnets = subnetLogs.filter((entry) => entry.active.length > 0).length;

      const contributing = activeVpcLogs.length > 0
        ? activeVpcLogs
        : subnetLogs.flatMap((entry) => entry.active);
      // Widest traffic type wins: ALL beats ACCEPT beats REJECT for observability.
      const types = new Set(contributing.map((log) => log.trafficType));
      const trafficType: FlowLogTrafficType = types.has("ALL")
        ? "ALL"
        : types.has("ACCEPT") ? "ACCEPT" : types.has("REJECT") ? "REJECT" : "unknown";

      let level: CoverageLevel;
      let gapReason: string | null = null;
      if (activeVpcLogs.length > 0) {
        level = "vpc";
      } else if (vpc.subnetIds.length > 0 && coveredSubnets === vpc.subnetIds.length) {
        level = "all-subnets";
      } else if (coveredSubnets > 0) {
        level = "partial-subnets";
        gapReason = `${vpc.subnetIds.length - coveredSubnets} of ${vpc.subnetIds.length} subnets have no active flow log`;
      } else if (vpcLogs.length > 0 || subnetLogs.some((entry) => entry.all.length > 0)) {
        level = "configured-inactive";
        gapReason = "a flow log exists but is not ACTIVE, so no records are produced";
      } else {
        level = "none";
        gapReason = "no flow log covers this VPC or any of its subnets";
      }

      const observable = level === "vpc" || level === "all-subnets";
      return {
        vpcId: vpc.vpcId,
        region: vpc.region,
        isDefault: vpc.isDefault,
        level,
        observable,
        trafficType,
        acceptedTrafficRecorded: trafficType === "ALL" || trafficType === "ACCEPT",
        coveredSubnets,
        totalSubnets: vpc.subnetIds.length,
        flowLogIds: [...contributing.map((log) => log.flowLogId)].sort((a, b) => a.localeCompare(b, "en-US")),
        gapReason,
      };
    })
    .sort((left, right) =>
      left.region.localeCompare(right.region, "en-US") || left.vpcId.localeCompare(right.vpcId, "en-US"));

  return {
    schema: "sutra.aws-flow-log-coverage.v1",
    vpcs,
    summary: {
      total: vpcs.length,
      observable: vpcs.filter((vpc) => vpc.observable).length,
      blind: vpcs.filter((vpc) => vpc.level === "none").length,
      partial: vpcs.filter((vpc) => vpc.level === "partial-subnets").length,
      inactive: vpcs.filter((vpc) => vpc.level === "configured-inactive").length,
      rejectOnly: vpcs.filter((vpc) => vpc.observable && !vpc.acceptedTrafficRecorded).length,
    },
    claimBoundary: "FLOW_LOG_CONFIGURATION_ONLY_NOT_FLOW_RECORDS",
    disclaimer: DISCLAIMER,
  };
}
