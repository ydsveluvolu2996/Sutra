/**
 * Adapter: collected AWS resources (PilotResource[]) -> flow-log coverage inputs.
 *
 * Pure and deterministic. It reshapes already-collected evidence and never invents
 * a flow log, because a fabricated one would turn a blind VPC into a covered one —
 * the exact direction this engine must never fail in.
 *
 * ── WHAT ABSENCE MEANS HERE ─────────────────────────────────────────────────
 * A snapshot collected before permission pack standard-2026-07.3 has no flow-log
 * resources at all, because `ec2:DescribeFlowLogs` was not granted. That is
 * indistinguishable, in the resource table alone, from an account that genuinely
 * has no flow logs — and those two states have opposite meanings. So this adapter
 * reports `flowLogsCollected` separately, and the caller must use it to decide
 * whether "0 flow logs" is a finding or simply unobserved.
 */

import type { JsonValue, PilotResource } from "./pilot-types.ts";
import type { FlowLogConfig, FlowLogDestination, FlowLogTrafficType, VpcUnderReview } from "./aws-flow-log-coverage.ts";

export interface FlowLogInputs {
  readonly vpcs: readonly VpcUnderReview[];
  readonly flowLogs: readonly FlowLogConfig[];
  /**
   * True when the snapshot contains at least one flow-log resource, i.e. the
   * collector actually ran DescribeFlowLogs. False means the permission was not
   * granted (pre-.3 role) OR the account has none — the caller must not read
   * false as "no gaps".
   */
  readonly flowLogsCollected: boolean;
}

/** The live collector prefixes types ("aws.ec2.vpc"); other sources use bare kinds. */
function kind(resourceType: string): string {
  return resourceType.replace(/^aws\.ec2\./u, "");
}

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeDestination(value: string | undefined): FlowLogDestination {
  switch (value) {
    case "cloud-watch-logs": return "cloud-watch-logs";
    case "s3": return "s3";
    case "kinesis-data-firehose": return "kinesis-data-firehose";
    default: return "unknown";
  }
}

function normalizeTrafficType(value: string | undefined): FlowLogTrafficType {
  switch (value?.toUpperCase()) {
    case "ACCEPT": return "ACCEPT";
    case "REJECT": return "REJECT";
    case "ALL": return "ALL";
    default: return "unknown";
  }
}

export function buildFlowLogInputs(resources: readonly PilotResource[]): FlowLogInputs {
  const of = (wanted: string): PilotResource[] =>
    resources.filter((resource) => kind(resource.resourceType) === wanted);

  // Subnet -> VPC, so a VPC can be asked "are all of your subnets covered?".
  const subnetsByVpc = new Map<string, string[]>();
  for (const subnet of of("subnet")) {
    const vpcId = str(subnet.configuration.vpcId);
    if (vpcId === undefined) continue;
    const existing = subnetsByVpc.get(vpcId) ?? [];
    existing.push(subnet.nativeId);
    subnetsByVpc.set(vpcId, existing);
  }

  const vpcs: VpcUnderReview[] = of("vpc").map((vpc) => ({
    vpcId: vpc.nativeId,
    region: vpc.region,
    isDefault: vpc.configuration.isDefault === true,
    // Sorted so the coverage report is stable across collections regardless of
    // the order the collector paginated subnets in.
    subnetIds: [...(subnetsByVpc.get(vpc.nativeId) ?? [])].sort((a, b) => a.localeCompare(b, "en-US")),
  }));

  const flowLogResources = of("flow-log");
  const flowLogs: FlowLogConfig[] = flowLogResources.flatMap((log) => {
    const resourceId = str(log.configuration.resourceId);
    // A flow log whose covered resource is unknown cannot be attributed to a VPC.
    // Dropping it is the safe direction: it can only make coverage look WORSE,
    // never better, so no VPC is wrongly reported as observable.
    if (resourceId === undefined) return [];
    return [{
      flowLogId: log.nativeId,
      resourceId,
      destination: normalizeDestination(str(log.configuration.logDestinationType)),
      trafficType: normalizeTrafficType(str(log.configuration.trafficType)),
      // FlowLogStatus is the field that decides whether records are produced.
      // DeliverLogsStatus can be FAILED while FlowLogStatus is ACTIVE (a broken
      // destination), which the engine treats as configured-but-not-delivering
      // only if the status it receives says so — so prefer the delivery status
      // when it is explicitly failing.
      status: str(log.configuration.deliverLogsStatus)?.toUpperCase() === "FAILED"
        ? "DELIVERY_FAILED"
        : str(log.configuration.flowLogStatus) ?? "unknown",
      region: log.region,
    }];
  });

  return { vpcs, flowLogs, flowLogsCollected: flowLogResources.length > 0 };
}
