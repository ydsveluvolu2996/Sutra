import { requireRecentMfa } from "../../../../db/auth-repository";
import {
  listManagedSessions,
  revokeManagedSession,
  revokeOtherManagedSessions,
} from "../../../../db/session-administration-repository";
import {
  authorizePilotRequest,
  expiredSessionCookie,
} from "../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../lib/auth-http";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await authorizePilotRequest(request, "workspace:read");
    return jsonResponse(
      { sessions: await listManagedSessions(actor.authenticated) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const actor = await authorizePilotRequest(request, "workspace:read");
    requireRecentMfa(actor.authenticated);
    const body = exactInputObject(await readAuthJson(request, 1024), ["sessionId"]);
    const result = await revokeManagedSession(
      actor.authenticated,
      boundedInputString(body.sessionId, { label: "session identifier", maximum: 64 }),
    );
    return jsonResponse(
      { revoked: result.revoked, signedOut: result.current },
      result.current ? { headers: { "set-cookie": expiredSessionCookie(request) } } : {},
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const actor = await authorizePilotRequest(request, "workspace:read");
    requireRecentMfa(actor.authenticated);
    const body = exactInputObject(await readAuthJson(request, 1024), ["operation", "confirmation"]);
    const operation = boundedInputString(body.operation, { label: "session operation", maximum: 64 });
    const confirmation = boundedInputString(body.confirmation, { label: "session confirmation", maximum: 64 });
    if (operation !== "revoke_other_sessions" || confirmation !== "REVOKE OTHER SESSIONS") {
      throw { code: "INVALID_INPUT" };
    }
    const revoked = await revokeOtherManagedSessions(actor.authenticated);
    return jsonResponse({ revoked });
  } catch (error) {
    return authErrorResponse(error);
  }
}
