import { getConnectionForOrg, getPilotStateForOrg } from "../../../../db/pilot-repository";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId");
    if (
      [...url.searchParams.keys()].some((key) => key !== "connectionId") ||
      (connectionId !== null && !/^conn_[a-f0-9]{32}$/u.test(connectionId))
    ) {
      throw Object.assign(new Error("The workspace state request is invalid"), { code: "INVALID_INPUT" });
    }
    if (connectionId !== null) {
      const connection = await getConnectionForOrg(actor.orgId, connectionId);
      if (connection === null) {
        throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
      }
      assertSessionCapability(actor.authenticated, "connection:read", connection.customerId);
    }
    const state = await getPilotStateForOrg(actor.orgId, connectionId ?? undefined);
    if (state.connection !== null) {
      assertSessionCapability(actor.authenticated, "connection:read", state.connection.customerId);
    }
    return jsonResponse({ state });
  } catch (error) {
    return errorResponse(error);
  }
}
