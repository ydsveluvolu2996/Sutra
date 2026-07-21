import { LOCAL_SESSION_TTL_MS } from "../../../../../db/auth-repository";
import {
  acceptPasswordInvitation,
  previewPasswordInvitation,
} from "../../../../../db/identity-invitation-repository";
import { assertLocalAuthRequest, sessionCookie } from "../../../../../lib/api-auth";
import {
  assertLocalAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// Preview who an invitation is for, so the accept-invite page can greet the
// invitee. The token is the bearer secret; an invalid/used/expired token is a
// flat 404 that never distinguishes those cases.
export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalAuthRequest(request);
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const preview = await previewPasswordInvitation(token);
    if (preview === null) {
      return jsonResponse({ error: { code: "INVALID_INPUT", message: "This invitation is invalid or expired" } }, { status: 404 });
    }
    return jsonResponse(preview);
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    const body = exactInputObject(await readAuthJson(request, 4 * 1024), ["token", "password", "displayName"], []);
    const token = boundedInputString(body.token, { label: "invitation token", minimum: 43, maximum: 43, trim: false });
    const result = await acceptPasswordInvitation(token, {
      password: boundedInputString(body.password, { label: "password", maximum: 128, trim: false }),
      displayName: boundedInputString(body.displayName, { label: "full name", maximum: 80 }),
    });
    return jsonResponse(
      {
        session: result.session.session,
        mfaEnrollmentRequired: result.mfaEnrollmentRequired,
      },
      {
        headers: {
          "set-cookie": sessionCookie(request, result.token, LOCAL_SESSION_TTL_MS / 1000),
        },
      },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
