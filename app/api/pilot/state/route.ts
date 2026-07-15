import { getPilotState } from "../../../../db/pilot-repository";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    requirePilotActor(request);
    return jsonResponse({ state: await getPilotState() });
  } catch (error) {
    return errorResponse(error);
  }
}
