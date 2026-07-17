import { HubbleFlowRepository } from "../../../../../db/hubble-flow-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never { throw Object.assign(new Error("Network flow query rejected"), { code: "INVALID_INPUT" }) }

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId", "limit"].includes(key))) invalid();
    const connectionId = url.searchParams.get("connectionId");
    const clusterId = url.searchParams.get("clusterId");
    const limitText = url.searchParams.get("limit") ?? "500";
    if (connectionId === null || !CONNECTION_ID.test(connectionId) || clusterId === null ||
      !CLUSTER_ID.test(clusterId) || !/^\d{1,3}$/u.test(limitText)) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const workspace = await new HubbleFlowRepository().workspace({
      orgId: authenticated.subject.orgId, customerId: connection.customerId, clusterId,
    }, Number(limitText));
    return jsonResponse({ schemaVersion: "sutra.hubble-workspace.v1", clusterId, ...workspace });
  } catch (error) { return errorResponse(error) }
}
