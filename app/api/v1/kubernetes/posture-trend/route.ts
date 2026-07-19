import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildMspScorecard } from "../../../../../lib/kubernetes-posture-trend";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const MAX_CLUSTERS = 50;

function invalid(): never {
  throw Object.assign(new Error("Posture trend query rejected"), { code: "INVALID_INPUT" });
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
    const repository = new KubernetesRepository();
    const clusters = (await repository.listClusters(scope))
      .filter((cluster) => cluster.status === "active")
      .slice(0, MAX_CLUSTERS);
    const withPoints = await Promise.all(clusters.map(async (cluster) => ({
      clusterId: cluster.id,
      clusterName: cluster.name,
      points: await repository.listPostureTrend(scope, cluster.id),
    })));
    return jsonResponse(buildMspScorecard({ clusters: withPoints }));
  } catch (error) {
    return errorResponse(error);
  }
}
