import { KubernetesAgentRepository } from "../../../../../../../db/kubernetes-agent-repository";
import {
  agentAuthorization,
  agentErrorResponse,
  exactAgentRecord,
  readAgentJson,
} from "../../../../../../../lib/kubernetes-agent-request";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly agentId: string }> },
): Promise<Response> {
  try {
    const { agentId } = await context.params;
    const token = agentAuthorization(request, "Bearer");
    const body = exactAgentRecord(await readAgentJson(request, 1024), ["agentId"]);
    if (body.agentId !== agentId) {
      throw Object.assign(new Error("Agent binding mismatch"), { code: "AUTHENTICATION_REQUIRED", status: 401 });
    }
    const credential = await new KubernetesAgentRepository().rotate(agentId, token);
    return Response.json(credential, {
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
