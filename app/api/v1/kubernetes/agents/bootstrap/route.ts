import { KubernetesAgentRepository } from "../../../../../../db/kubernetes-agent-repository";
import { getConnectionForOrg } from "../../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, 4096);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("Invalid bootstrap request"), { code: "INVALID_INPUT" });
    }
    const input = body as Record<string, unknown>;
    const allowed = new Set(["connectionId", "clusterId", "nodeScoped"]);
    if (
      Object.keys(input).some((key) => !allowed.has(key)) ||
      typeof input.connectionId !== "string" || !CONNECTION_ID.test(input.connectionId) ||
      typeof input.clusterId !== "string" || !CLUSTER_ID.test(input.clusterId) ||
      (input.nodeScoped !== undefined && typeof input.nodeScoped !== "boolean")
    ) throw Object.assign(new Error("Invalid bootstrap request"), { code: "INVALID_INPUT" });
    const connection = await getConnectionForOrg(authenticated.subject.orgId, input.connectionId);
    if (connection === null) throw Object.assign(new Error("Connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const bootstrap = await new KubernetesAgentRepository().issueBootstrap({
      scope: {
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId: connection.id,
        clusterId: input.clusterId,
      },
      createdBy: authenticated.subject.userId,
      // A node-scoped bootstrap is the reusable enrollment secret a DaemonSet
      // shares across its per-node pods; the default stays single-use.
      nodeScoped: input.nodeScoped === true,
    });
    return jsonResponse({
      schema: "sutra.kubernetes-agent-bootstrap.v1",
      ...bootstrap,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
