import { KubernetesAgentRepository } from "../../../../../../../db/kubernetes-agent-repository";
import {
  agentAuthorization,
  agentErrorResponse,
  exactAgentRecord,
  readAgentJson,
} from "../../../../../../../lib/kubernetes-agent-request";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MODULE_STATE = new Set(["AVAILABLE", "DEGRADED", "NOT_CONFIGURED", "UNKNOWN"]);

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly agentId: string }> },
): Promise<Response> {
  try {
    const { agentId } = await context.params;
    const token = agentAuthorization(request, "Bearer");
    const body = exactAgentRecord(await readAgentJson(request, 32 * 1024), [
      "clusterId", "clusterName", "agentVersion", "capabilities", "agentId",
      "deployment", "modules", "lastSuccessfulScanAt",
    ]);
    const deployment = exactAgentRecord(body.deployment, ["namespace", "podName", "startedAt"]);
    if (
      body.agentId !== agentId ||
      typeof body.clusterId !== "string" || !ID.test(body.clusterId) ||
      typeof body.clusterName !== "string" || body.clusterName.length < 1 || body.clusterName.length > 253 ||
      typeof body.agentVersion !== "string" || !ID.test(body.agentVersion) ||
      !Array.isArray(body.capabilities) || body.capabilities.length < 1 || body.capabilities.length > 64 ||
      body.capabilities.some((item) => typeof item !== "string" || !CAPABILITY.test(item)) ||
      typeof deployment.namespace !== "string" || !ID.test(deployment.namespace) ||
      typeof deployment.podName !== "string" || !ID.test(deployment.podName) ||
      typeof deployment.startedAt !== "string" || !Number.isFinite(Date.parse(deployment.startedAt)) ||
      (body.lastSuccessfulScanAt !== null &&
        (typeof body.lastSuccessfulScanAt !== "string" ||
          !Number.isFinite(Date.parse(body.lastSuccessfulScanAt)))) ||
      typeof body.modules !== "object" || body.modules === null || Array.isArray(body.modules) ||
      Object.keys(body.modules as object).length > 32 ||
      Object.entries(body.modules as Record<string, unknown>).some(
        ([key, value]) => !CAPABILITY.test(key) || !MODULE_STATE.has(value as string),
      )
    ) throw Object.assign(new Error("Invalid heartbeat"), { code: "INVALID_INPUT", status: 400 });
    const repository = new KubernetesAgentRepository();
    const agent = await repository.authenticate(agentId, token, { allowPrevious: true });
    if (agent.clusterUid !== body.clusterId || agent.clusterName !== body.clusterName) {
      throw Object.assign(new Error("Agent binding mismatch"), { code: "AUTHENTICATION_REQUIRED", status: 401 });
    }
    await repository.recordHeartbeat({
      agent,
      agentVersion: body.agentVersion,
      capabilities: body.capabilities as string[],
      deployment: deployment as unknown as { namespace: string; podName: string; startedAt: string },
      modules: body.modules as Record<string, string>,
    });
    return Response.json(
      { schema: "sutra.kubernetes-agent-heartbeat-response.v1", status: "accepted" },
      { status: 202, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
    );
  } catch (error) {
    return agentErrorResponse(error);
  }
}
