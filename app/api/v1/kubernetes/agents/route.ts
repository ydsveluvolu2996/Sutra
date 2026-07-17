import { KubernetesAgentRepository } from "../../../../../db/kubernetes-agent-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("Agent deployment-health query rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId"].includes(key))) invalid();
    const connectionId = url.searchParams.get("connectionId");
    const clusterId = url.searchParams.get("clusterId");
    if (
      connectionId === null || !CONNECTION_ID.test(connectionId) ||
      clusterId === null || !CLUSTER_ID.test(clusterId)
    ) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const agents = await new KubernetesAgentRepository().listDeploymentHealth({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
      clusterId,
    });
    return jsonResponse({
      schemaVersion: "sutra.kubernetes-agent-deployment-health.v1",
      clusterId,
      agents,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
