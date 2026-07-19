import { confirmTotpEnrollment } from "../../../../../db/auth-repository";
import {
  localAuthSecrets,
  requireApiSession,
  sessionTokenFromRequest,
} from "../../../../../lib/api-auth";
import {
  assertLocalAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    const authenticated = await requireApiSession(request, { requireMfa: false });
    const token = sessionTokenFromRequest(request);
    if (token === null) {
      return jsonResponse(
        { error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in before setting up MFA" } },
        { status: 401 },
      );
    }
    const body = exactInputObject(await readAuthJson(request, 512), ["code"]);
    const session = await confirmTotpEnrollment(
      token,
      authenticated,
      boundedInputString(body.code, {
        label: "authenticator code",
        minimum: 6,
        maximum: 6,
        trim: false,
      }),
      localAuthSecrets(),
    );
    return jsonResponse({ session: session.session });
  } catch (error) {
    return authErrorResponse(error);
  }
}
