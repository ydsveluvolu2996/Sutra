import { getConnectionForOrg, getPilotStateForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability } from "../../../../lib/api-auth";
import { buildFlowLogCoverage } from "../../../../lib/aws-flow-log-coverage";
import { buildFlowLogInputs } from "../../../../lib/aws-flow-log-inputs";
import { AWS_CUSTOMER_ROLE_TEMPLATE_VERSION } from "../../../../lib/aws-template-contract";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(new Error("Flow log coverage query rejected"), { code: "INVALID_INPUT" });
}

/**
 * VPC flow-log COVERAGE for one connection.
 *
 * Reports whether each VPC is observable, never what traffic occurred — the
 * records live in CloudWatch Logs or S3 and reading them needs permissions the
 * customer role deliberately does not hold. The engine's own `claimBoundary` and
 * `disclaimer` are returned verbatim so the UI cannot quietly restate coverage as
 * analysis.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();

    const actor = await requirePilotActor(request, "workspace:read");
    const connection = await getConnectionForOrg(actor.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    // Tenant comes from the session's connection record, never from the caller.
    assertSessionCapability(actor.authenticated, "connection:read", connection.customerId);

    const state = await getPilotStateForOrg(actor.orgId, connectionId);
    const inputs = buildFlowLogInputs(state.resources);
    const coverage = buildFlowLogCoverage(inputs);

    // An empty flow-log set has TWO possible meanings and this endpoint cannot
    // tell them apart from the snapshot alone:
    //   * the account genuinely has no flow logs (every VPC really is blind), or
    //   * the snapshot was collected by a role that predates the permission pack
    //     which granted ec2:DescribeFlowLogs, so nothing ever looked.
    //
    // Reporting either one as fact would be a guess, and guessing toward "no flow
    // logs exist" is the dangerous direction — it reads as a finding when it may
    // just be an unasked question. So absence is reported as unavailable evidence
    // with both readings stated, and the caller is told how to disambiguate.
    const evidence = inputs.flowLogsCollected
      ? { available: true as const }
      : {
        available: false as const,
        reason:
          "This snapshot contains no flow-log configuration. Either the account has no "
          + "flow logs at all — in which case every VPC below is genuinely unmonitored — or "
          + "the collection predates the IAM role that grants ec2:DescribeFlowLogs. To tell "
          + `these apart, confirm the role is deployed from template `
          + `${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION} and run a fresh collection. Until then the `
          + "verdicts below are not a clean bill of health.",
        disambiguateBy: `Redeploy the role from ${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}, then re-collect.`,
      };

    return jsonResponse({
      coverage,
      evidence,
      inputs: {
        vpcs: inputs.vpcs.length,
        flowLogs: inputs.flowLogs.length,
        subnets: inputs.vpcs.reduce((sum, vpc) => sum + vpc.subnetIds.length, 0),
      },
      scannedAt: state.activeSnapshot?.collectedAt ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
