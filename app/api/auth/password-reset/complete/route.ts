import { env } from "cloudflare:workers";

import { consumeLoginAttemptBudget } from "../../../../../db/auth-repository";
import { completePasswordReset } from "../../../../../db/password-reset-repository";
import {
  assertLocalAuthMutation,
  authErrorResponse,
  boundedInputString,
  clientSourceKey,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";
import { TURNSTILE_ACTIONS } from "../../../../../lib/turnstile-contract";
import {
  verifyTurnstileToken,
  type TurnstileEnvironment,
} from "../../../../../lib/turnstile-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    await consumeLoginAttemptBudget({
      sourceKey: clientSourceKey(request),
      now: Date.now(),
      windowMs: 15 * 60 * 1000,
      maxPerWindow: 10,
    });
    const body = exactInputObject(
      await readAuthJson(request, 4 * 1024),
      ["token", "password", "turnstileToken"],
      [],
    );
    await verifyTurnstileToken(
      request,
      env as unknown as TurnstileEnvironment,
      body.turnstileToken,
      TURNSTILE_ACTIONS.passwordResetComplete,
    );
    await completePasswordReset(
      boundedInputString(body.token, {
        label: "password reset token",
        minimum: 43,
        maximum: 43,
        trim: false,
      }),
      boundedInputString(body.password, {
        label: "password",
        maximum: 128,
        trim: false,
      }),
    );
    return jsonResponse({ reset: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
