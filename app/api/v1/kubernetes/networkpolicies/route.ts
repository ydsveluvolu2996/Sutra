import { HubbleFlowRepository } from "../../../../../db/hubble-flow-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildNetworkPolicies } from "../../../../../lib/kubernetes-networkpolicy-generator";
import { hubbleFlowsToPolicyInputs } from "../../../../../lib/networkpolicy-flow-inputs";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("Network policy generation request rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId"].includes(key))) invalid();
    const connectionId = url.searchParams.get("connectionId");
    const clusterId = url.searchParams.get("clusterId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId) || clusterId === null || !CLUSTER_ID.test(clusterId)) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    // Generate least-privilege policies from the flows actually observed for this
    // cluster. The generator only reproduces observed connectivity and marks every
    // policy INCOMPLETE — flow absence is not proof a connection is unused.
    const workspace = await new HubbleFlowRepository().workspace({
      orgId: authenticated.subject.orgId, customerId: connection.customerId, clusterId,
    });
    const inputs = hubbleFlowsToPolicyInputs(workspace.flows);
    const result = buildNetworkPolicies({ ...inputs, tenant: connection.customerId });
    return jsonResponse({
      ...result,
      clusterId,
      flowsObserved: workspace.flows.length,
      configured: workspace.flows.length > 0,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
