import { env } from "cloudflare:workers";

import { jsonResponse } from "../../../../lib/pilot-server";
import {
  turnstileClientConfiguration,
  type TurnstileEnvironment,
} from "../../../../lib/turnstile-server";

export const dynamic = "force-dynamic";

/**
 * Public configuration endpoint. The site key is intentionally public; the
 * Siteverify secret never leaves the server runtime.
 */
export function GET(request: Request): Response {
  try {
    return jsonResponse(
      turnstileClientConfiguration(
        env as unknown as TurnstileEnvironment,
        request,
      ),
    );
  } catch {
    return jsonResponse(
      {
        error: {
          code: "TURNSTILE_CONFIGURATION_INVALID",
          message: "The security check is temporarily unavailable",
        },
      },
      { status: 503 },
    );
  }
}
