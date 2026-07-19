import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { captureEventChangeHints } from "../../../../../lib/cmdb-event-capture";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    if (!CONNECTION_ID.test(connectionId)) {
      throw Object.assign(new Error("The change-hint request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const repository = new CmdbWorkspaceRepository();
    const inputs = await repository.changeHintInputs(
      { orgId: authenticated.subject.orgId, customerId: connection.customerId },
      connectionId,
    );
    if (inputs.snapshotCollectedAtMs === null) {
      return jsonResponse({ connectionId, status: "no-snapshot", hints: null });
    }
    const result = captureEventChangeHints({
      snapshotCollectedAtMs: inputs.snapshotCollectedAtMs,
      snapshotResources: inputs.resources,
      events: inputs.events,
    });
    return jsonResponse({ connectionId, status: "ok", snapshotCollectedAtMs: inputs.snapshotCollectedAtMs, hints: result });
  } catch (error) {
    return errorResponse(error);
  }
}
