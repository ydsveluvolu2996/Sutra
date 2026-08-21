import {
  getConnectionForOrg,
  getPilotStateForOrg,
  listConnectionsForOrg,
} from "../../../../../db/pilot-repository";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { authorize } from "../../../../../lib/auth-policy";
import { assertAwsNavigatorStateBoundary, buildAwsNavigatorEnvelope } from "../../../../../lib/aws-navigator";
import type { PilotState } from "../../../../../lib/pilot-types";
import {
  errorResponse,
  isLocalSimulationRuntime,
  jsonResponse,
  requirePilotActor,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ALLOWED_PARAMETERS = new Set(["connectionId", "path", "q", "region"]);

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
    if ([...url.searchParams.keys()].some((key) => !ALLOWED_PARAMETERS.has(key))
      || [...ALLOWED_PARAMETERS].some((key) => url.searchParams.getAll(key).length > 1)) {
      throw Object.assign(new Error("The AWS Navigator request is invalid"), { code: "INVALID_INPUT" });
    }
    const requestedConnectionId = url.searchParams.get("connectionId");
    if (requestedConnectionId !== null && !CONNECTION_ID.test(requestedConnectionId)) {
      throw Object.assign(new Error("The AWS Navigator request is invalid"), { code: "INVALID_INPUT" });
    }

    const allowSimulatedEvidence = isLocalSimulationRuntime();
    let selectedConnectionId = requestedConnectionId;
    if (selectedConnectionId === null) {
      const connections = await listConnectionsForOrg(actor.orgId);
      selectedConnectionId = connections.find((connection) =>
        (allowSimulatedEvidence || connection.sourceKind !== "simulated_fixture")
        && authorize(actor.authenticated.subject, {
          orgId: actor.orgId,
          capability: "connection:read",
          customerId: connection.customerId,
        }).allowed)?.id ?? null;
    }

    let state = emptyState();
    if (selectedConnectionId !== null) {
      const connection = await getConnectionForOrg(actor.orgId, selectedConnectionId);
      if (connection === null || (!allowSimulatedEvidence && connection.sourceKind === "simulated_fixture")) {
        throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
      }
      assertSessionCapability(actor.authenticated, "connection:read", connection.customerId);
      state = await getPilotStateForOrg(actor.orgId, connection.id);
      assertAwsNavigatorStateBoundary(connection, state);
    }

    const path = url.searchParams.get("path");
    const segments = path === null ? [] : path.split("/");
    return jsonResponse(buildAwsNavigatorEnvelope({
      state,
      segments,
      region: url.searchParams.get("region"),
      query: url.searchParams.get("q"),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
