import {
  getConnectionForOrg,
  getPilotStateForOrg,
  listConnectionsForOrg,
} from "../../../../db/pilot-repository";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../lib/api-auth";
import { authorize } from "../../../../lib/auth-policy";
import type { PilotState } from "../../../../lib/pilot-types";

export const dynamic = "force-dynamic";

function emptyState(): PilotState {
  return {
    mode: "empty",
    connection: null,
    resources: [],
    relationships: [],
    findings: [],
    coverage: [],
    latestRunCoverage: null,
    syncRuns: [],
    activeSnapshot: null,
  };
}

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
    let selectedConnectionId = connectionId;
    if (selectedConnectionId !== null) {
      const connection = await getConnectionForOrg(actor.orgId, selectedConnectionId);
      if (connection === null) {
        throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
      }
      assertSessionCapability(actor.authenticated, "connection:read", connection.customerId);
    } else {
      // An assigned-customer member may not read the organization's newest
      // connection. Select the newest connection their persisted customer
      // grant actually authorizes; if there is none, return an empty workspace
      // without disclosing that other customers have accounts.
      const connections = await listConnectionsForOrg(actor.orgId);
      selectedConnectionId = connections.find((connection) =>
        authorize(actor.authenticated.subject, {
          orgId: actor.orgId,
          capability: "connection:read",
          customerId: connection.customerId,
        }).allowed,
      )?.id ?? null;
      if (selectedConnectionId === null) {
        return jsonResponse({ state: emptyState() });
      }
    }
    const state = await getPilotStateForOrg(actor.orgId, selectedConnectionId);
    if (state.connection !== null) {
      assertSessionCapability(actor.authenticated, "connection:read", state.connection.customerId);
    }
    return jsonResponse({ state });
  } catch (error) {
    return errorResponse(error);
  }
}
