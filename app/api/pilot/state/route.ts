import { getPilotState } from "../../../../db/pilot-repository";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    const state = await getPilotState();
    if (state.connection !== null) {
      assertSessionCapability(actor.authenticated, "connection:read", state.connection.customerId);
    }
    return jsonResponse({ state });
  } catch (error) {
    return errorResponse(error);
  }
}
