import { env } from "cloudflare:workers";

import { consumeLoginAttemptBudget } from "../../../../../db/auth-repository";
import {
  createPasswordResetRequest,
  recordPasswordResetDelivery,
} from "../../../../../db/password-reset-repository";
import {
  assertLocalAuthMutation,
  authErrorResponse,
  boundedInputString,
  clientSourceKey,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import type { InvitationDeliveryEnv } from "../../../../../lib/invitation-delivery";
import { deliverPasswordResetEmail } from "../../../../../lib/password-reset-delivery";
import { jsonResponse } from "../../../../../lib/pilot-server";
import { TURNSTILE_ACTIONS } from "../../../../../lib/turnstile-contract";
import {
  verifyTurnstileToken,
  type TurnstileEnvironment,
} from "../../../../../lib/turnstile-server";

export const dynamic = "force-dynamic";

const PUBLIC_RESPONSE = {
  accepted: true,
  message:
    "If an active Sutra account matches that email, a single-use reset link has been sent.",
} as const;

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    await consumeLoginAttemptBudget({
      sourceKey: clientSourceKey(request),
      now: Date.now(),
      windowMs: 15 * 60 * 1000,
      maxPerWindow: 5,
    });
    const body = exactInputObject(
      await readAuthJson(request, 2 * 1024),
      ["email", "turnstileToken"],
      [],
    );
    await verifyTurnstileToken(
      request,
      env as unknown as TurnstileEnvironment,
      body.turnstileToken,
      TURNSTILE_ACTIONS.passwordResetRequest,
    );
    const email = boundedInputString(body.email, {
      label: "email address",
      maximum: 254,
    });
    // Constant-ish response time so an existing account (which additionally
    // sends an email below) cannot be distinguished by latency from a
    // nonexistent one. The floor is set to comfortably exceed typical provider
    // send time so both paths return at the same moment in the common case.
    // (A fully constant-time guarantee would move delivery to a background job;
    // tracked as a follow-up.)
    const minimumResponseAt = Date.now() + 900;
    const created = await createPasswordResetRequest(email);
    if (created !== null) {
      const origin = (env as unknown as InvitationDeliveryEnv)
        .SUTRA_PUBLIC_ORIGIN?.trim();
      if (origin !== undefined) {
        const resetUrl = new URL("/reset-password", origin);
        resetUrl.searchParams.set("token", created.token);
        const result = await deliverPasswordResetEmail(
          {
            recipient: created.email,
            resetUrl: resetUrl.toString(),
            expiresAt: new Date(created.expiresAt).toISOString(),
          },
          env as unknown as InvitationDeliveryEnv,
        );
        await recordPasswordResetDelivery(created.id, result);
      }
    }
    const remaining = minimumResponseAt - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    return jsonResponse(PUBLIC_RESPONSE, { status: 202 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
