import { beginTotpEnrollment } from "../../../../../db/auth-repository";
import { localAuthSecrets, requireApiSession } from "../../../../../lib/api-auth";
import { assertLocalAuthMutation, authErrorResponse } from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    const authenticated = await requireApiSession(request, { requireMfa: false });
    const enrollment = await beginTotpEnrollment(authenticated, localAuthSecrets());
    return jsonResponse({ enrollment });
  } catch (error) {
    return authErrorResponse(error);
  }
}
