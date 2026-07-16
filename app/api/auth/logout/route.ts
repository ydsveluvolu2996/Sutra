import { revokeLocalSession } from "../../../../db/auth-repository";
import {
  expiredSessionCookie,
  sessionTokenFromRequest,
} from "../../../../lib/api-auth";
import { assertLocalAuthMutation, authErrorResponse } from "../../../../lib/auth-http";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    const token = sessionTokenFromRequest(request);
    if (token !== null) await revokeLocalSession(token);
    return jsonResponse(
      { signedOut: true },
      { headers: { "set-cookie": expiredSessionCookie(request) } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
