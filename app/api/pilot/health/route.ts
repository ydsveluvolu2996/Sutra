import { errorResponse, getCollectorHealth, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    requirePilotActor(request);
    const health = await getCollectorHealth();
    return jsonResponse({ health });
  } catch (error) {
    return errorResponse(error);
  }
}
