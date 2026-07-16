import { getLocalSession } from "../../../../db/auth-repository";
import {
  assertLocalAuthRequest,
  expiredSessionCookie,
  sessionTokenFromRequest,
} from "../../../../lib/api-auth";
import { authErrorResponse } from "../../../../lib/auth-http";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalAuthRequest(request);
    const token = sessionTokenFromRequest(request);
    const authenticated = token === null ? null : await getLocalSession(token);
    return jsonResponse(
      { session: authenticated?.session ?? null },
      authenticated === null && token !== null
        ? { headers: { "set-cookie": expiredSessionCookie(request) } }
        : {},
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
