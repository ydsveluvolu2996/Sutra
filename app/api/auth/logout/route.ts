import { getLocalSession } from "../../../../db/auth-repository";
import { revokeManagedSession } from "../../../../db/session-administration-repository";
import {
  expiredSessionCookie,
  sessionTokenFromRequest,
} from "../../../../lib/api-auth";
import { assertAuthMutation, authErrorResponse } from "../../../../lib/auth-http";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const token = sessionTokenFromRequest(request);
    if (token !== null) {
      const authenticated = await getLocalSession(token);
      if (authenticated !== null) await revokeManagedSession(authenticated, authenticated.session.id);
    }
    return jsonResponse(
      { signedOut: true },
      { headers: { "set-cookie": expiredSessionCookie(request) } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
