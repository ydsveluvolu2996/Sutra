import { LOCAL_SESSION_TTL_MS, consumeLoginAttemptBudget, loginLocalUser } from "../../../../db/auth-repository";
import { localAuthSecrets, sessionCookie } from "../../../../lib/api-auth";
import {
  assertLocalAuthMutation,
  authErrorResponse,
  boundedInputString,
  clientSourceKey,
  exactInputObject,
  readAuthJson,
} from "../../../../lib/auth-http";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    // Per-source (per-IP) throttle IN FRONT of the credential check, so a single
    // origin cannot brute-force accounts or weaponize the per-account lockout.
    await consumeLoginAttemptBudget({ sourceKey: clientSourceKey(request), now: Date.now() });
    const body = exactInputObject(
      await readAuthJson(request, 2 * 1024),
      ["email", "password"],
      ["totpCode"],
    );
    const result = await loginLocalUser({
      email: boundedInputString(body.email, { label: "email address", maximum: 254 }),
      password: boundedInputString(body.password, {
        label: "password",
        maximum: 128,
        trim: false,
      }),
      ...(body.totpCode === undefined
        ? {}
        : {
            totpCode: boundedInputString(body.totpCode, {
              label: "authenticator code",
              minimum: 6,
              maximum: 6,
              trim: false,
            }),
          }),
    }, localAuthSecrets());
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
