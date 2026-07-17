import { KubernetesAgentRepository } from "../../../../../db/kubernetes-agent-repository";
import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildKubernetesFleetHealth } from "../../../../../lib/kubernetes-fleet-health";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(new Error("Fleet health query rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const [clusters, agents] = await Promise.all([
      new KubernetesRepository().listClusters(scope),
      new KubernetesAgentRepository().listConnectionAgentHealth({
        ...scope,
        connectionId,
      }),
    ]);
    return jsonResponse(buildKubernetesFleetHealth({ clusters, agents }));
  } catch (error) {
    return errorResponse(error);
  }
}
