import { getConnectionForOrg, getPilotStateForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability } from "../../../../lib/api-auth";
import { buildNetworkExposure } from "../../../../lib/aws-network-exposure";
import { buildNetworkExposureEvidence } from "../../../../lib/aws-network-exposure-inputs";
import { buildReachabilityLatency, type LatencySample } from "../../../../lib/reachability-latency";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(new Error("Network exposure query rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();

    const actor = await requirePilotActor(request, "workspace:read");
    const connection = await getConnectionForOrg(actor.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(actor.authenticated, "connection:read", connection.customerId);

    const state = await getPilotStateForOrg(actor.orgId, connectionId);
    const evidence = buildNetworkExposureEvidence(state.resources, { tenant: connection.customerId });
    const exposure = buildNetworkExposure(evidence);

    // Latency samples come from a CloudWatch/APM collector that is not wired yet,
    // so there are none: the overlay reports every endpoint as UNKNOWN rather than
    // inventing timings. The shape is returned so the UI can render the honest
    // "no samples collected" state and light up once the collector lands.
    const latencySamples: readonly LatencySample[] = [];
    const latency = buildReachabilityLatency(latencySamples);

    return jsonResponse({
      exposure,
      latency,
      inputs: {
        networkInterfaces: exposure.summary.resources,
        securityGroups: Object.keys(evidence.securityGroups).length,
        subnets: Object.keys(evidence.subnets).length,
        routeTables: Object.keys(evidence.routeTables).length,
        internetGateways: evidence.internetGateways.length,
        loadBalancers: evidence.loadBalancers.length,
        dnsRecords: evidence.dnsRecords?.length ?? 0,
        latencySamples: latencySamples.length,
      },
      scannedAt: state.activeSnapshot?.collectedAt ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
