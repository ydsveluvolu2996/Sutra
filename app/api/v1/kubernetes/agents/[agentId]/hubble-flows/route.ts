import { HubbleFlowRepository } from "../../../../../../../db/hubble-flow-repository";
import { KubernetesAgentRepository } from "../../../../../../../db/kubernetes-agent-repository";
import { normalizeHubbleFlowBatch } from "../../../../../../../lib/hubble-flow-evidence";
import {
  agentAuthorization, agentErrorResponse, exactAgentRecord, readAgentJson,
} from "../../../../../../../lib/kubernetes-agent-request";

export const dynamic = "force-dynamic";
const MAXIMUM_BODY_BYTES = 2 * 1024 * 1024;
function invalid(): never {
  throw Object.assign(new Error("Invalid Hubble upload"), { code: "INVALID_INPUT", status: 400 });
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly agentId: string }> },
): Promise<Response> {
  try {
    const { agentId } = await context.params;
    const token = agentAuthorization(request, "Bearer");
    const raw = await readAgentJson(request, MAXIMUM_BODY_BYTES);
    const body = exactAgentRecord(raw, ["schema", "collectedAt", "hubbleVersion", "flows"]);
    if (body.schema !== "sutra.hubble-agent-upload.v1") {
      invalid();
    }
    const agent = await new KubernetesAgentRepository().authenticate(agentId, token, { allowPrevious: true });
    const batch = await normalizeHubbleFlowBatch({
      clusterId: agent.clusterId,
      value: { collectedAt: body.collectedAt, hubbleVersion: body.hubbleVersion, flows: body.flows },
    }).catch(() => invalid());
    const result = await new HubbleFlowRepository().publish({
      orgId: agent.orgId, customerId: agent.customerId, clusterId: agent.clusterId,
    }, batch);
    return Response.json({
      schemaVersion: "sutra.hubble-agent-upload-response.v1",
      accepted: result.accepted,
      duplicates: result.duplicates,
      evidenceSha256: batch.evidenceSha256,
    }, { status: 202, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    return agentErrorResponse(error);
  }
}
