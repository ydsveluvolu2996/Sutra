import { getChangeHistory, getConnectionForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const rawLimit = url.searchParams.get("limit") ?? "100";
    if (!CONNECTION_ID.test(connectionId) || !/^\d{1,3}$/u.test(rawLimit)) {
      throw Object.assign(new Error("The change-history request is invalid"), { code: "INVALID_INPUT" });
    }
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 500 || [...url.searchParams.keys()].some((key) => key !== "connectionId" && key !== "limit")) {
      throw Object.assign(new Error("The change-history request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const changes = await getChangeHistory({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
      limit,
    });
    return jsonResponse({ connection, changes });
  } catch (error) {
    return errorResponse(error);
  }
}
