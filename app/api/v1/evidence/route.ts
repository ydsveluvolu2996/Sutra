import { EvidenceRepository } from "../../../../db/evidence-repository";
import { requireConnectionScope } from "../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, connection } = await requireConnectionScope(request, "export:read");
    const objects = await new EvidenceRepository().list({
      ...scope,
      connectionId: connection.id,
    });
    return jsonResponse({ objects });
  } catch (error) {
    return errorResponse(error);
  }
}
