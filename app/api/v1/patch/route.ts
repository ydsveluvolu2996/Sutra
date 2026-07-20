import { getConnectionForOrg, getPilotStateForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { buildPatchPosture } from "../../../../lib/patch-posture";
import { buildPatchPostureInputs } from "../../../../lib/patch-posture-inputs";
import type { PilotResource } from "../../../../lib/pilot-types";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(new Error("The patch-posture request is invalid"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();

    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    // Compute patch posture on-demand from the tenant-scoped collected facts
    // (EC2 instances joined with their read-only SSM patch-state resources).
    // Honest empty when nothing has been collected for the connection.
    const resources: readonly PilotResource[] =
      (await getPilotStateForOrg(authenticated.subject.orgId, connectionId)).resources;
    const report = buildPatchPosture(buildPatchPostureInputs({ resources }));

    return jsonResponse({ connectionId, report });
  } catch (error) {
    return errorResponse(error);
  }
}
