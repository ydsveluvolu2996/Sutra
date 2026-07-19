import { KubernetesAgentRepository } from "../../../../../../db/kubernetes-agent-repository";
import {
  agentAuthorization,
  agentErrorResponse,
  exactAgentRecord,
  readAgentJson,
} from "../../../../../../lib/kubernetes-agent-request";

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export async function POST(request: Request): Promise<Response> {
  try {
    const bootstrapToken = agentAuthorization(request, "Sutra-Bootstrap");
    const body = exactAgentRecord(await readAgentJson(request, 16 * 1024), [
      "clusterId", "clusterName", "agentVersion", "capabilities",
    ]);
    if (
      typeof body.clusterId !== "string" || !ID.test(body.clusterId) ||
      typeof body.clusterName !== "string" || body.clusterName.length < 1 || body.clusterName.length > 253 ||
      typeof body.agentVersion !== "string" || !ID.test(body.agentVersion) ||
      !Array.isArray(body.capabilities) || body.capabilities.length < 1 || body.capabilities.length > 64 ||
      body.capabilities.some((item) => typeof item !== "string" || !CAPABILITY.test(item))
    ) throw Object.assign(new Error("Invalid agent identity"), { code: "INVALID_INPUT", status: 400 });
    const credential = await new KubernetesAgentRepository().enroll(bootstrapToken, {
      clusterId: body.clusterId,
      clusterName: body.clusterName,
      agentVersion: body.agentVersion,
      capabilities: body.capabilities as string[],
    });
    return Response.json(credential, {
      status: 201,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
