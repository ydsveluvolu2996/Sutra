import { env } from "cloudflare:workers";

import {
  ContactSubmissionRepository,
  parseContactSubmission,
} from "../../../db/contact-submission-repository";
import {
  deliverContactSubmission,
  resolveContactRecipient,
  type ContactDeliveryEnv,
} from "../../../lib/contact-delivery";
import { clientSourceKey } from "../../../lib/auth-http";
import { readBoundedJson } from "../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../lib/pilot-server";
import { TURNSTILE_ACTIONS } from "../../../lib/turnstile-contract";
import {
  verifyTurnstileToken,
  type TurnstileEnvironment,
} from "../../../lib/turnstile-server";

export const dynamic = "force-dynamic";

// PUBLIC endpoint: this is the marketing-site "Contact us" form. It is
// deliberately UNauthenticated — it requires no session, and `/api/contact` is
// on the public allowlist in lib/deployment-security.ts. All safety therefore
// comes from strict validation, a bounded body, a bot honeypot, server-verified
// Turnstile and a durable rate limit rather than from a session.

// Bodies are tiny; anything larger than 8 KiB is not a real contact form post.
const MAX_BODY_BYTES = 8 * 1024;
// Fixed one-minute window; abusive callers are throttled per source IP with a
// global ceiling as a backstop against a distributed flood.
const RATE_WINDOW_MS = 60_000;
const MAX_PER_SOURCE_PER_WINDOW = 5;
const MAX_GLOBAL_PER_WINDOW = 60;

// Single shared bucket for requests without a trusted edge IP. Everything
// unattributed shares one per-source budget so a spoofer cannot mint buckets.
const UNATTRIBUTED_SOURCE = "unattributed";

function tooManyRequests(): never {
  throw Object.assign(new Error("Too many contact submissions; please try again shortly"), {
    code: "RATE_LIMITED",
    status: 429,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    const bodyRecord =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const { turnstileToken, ...contactBody } = bodyRecord;
    const parsed = parseContactSubmission(contactBody);

    // Honeypot filled → almost certainly a bot. Silently drop (no persistence)
    // but answer 200 so the bot cannot tell it was rejected.
    if (parsed.ok && parsed.drop) {
      return jsonResponse({ ok: true });
    }
    if (!parsed.ok) {
      throw Object.assign(new Error("The contact request is invalid"), { code: "INVALID_INPUT" });
    }
    await verifyTurnstileToken(
      request,
      env as unknown as TurnstileEnvironment,
      turnstileToken,
      TURNSTILE_ACTIONS.contact,
    );

    const repository = new ContactSubmissionRepository();
    // Caddy is the app container's only ingress peer and overwrites
    // X-Forwarded-For with Cloudflare's canonical CF-Connecting-IP before
    // forwarding. Read the right-most trusted-proxy hop through the same helper
    // as password auth; never read the client-supplied Cloudflare header here.
    const ip = clientSourceKey(request) ?? UNATTRIBUTED_SOURCE;
    const now = Date.now();
    const rateBudgetAvailable = await repository.consumeRateBudget({
      sourceIp: ip,
      now,
      windowMs: RATE_WINDOW_MS,
      maxPerSource: MAX_PER_SOURCE_PER_WINDOW,
      maxGlobal: MAX_GLOBAL_PER_WINDOW,
    });
    if (!rateBudgetAvailable) tooManyRequests();

    const deliveryEnv = env as unknown as ContactDeliveryEnv;
    const recipient = resolveContactRecipient(deliveryEnv);
    const submittedAt = new Date(now).toISOString();

    // RECORD BEFORE DELIVER. The atomic counter reservation above already
    // includes in-flight submissions. `ok: true` remains the honest guarantee
    // that the lead is durably stored; `delivered` only reflects whether a
    // configured transport accepted it.
    const id = await repository.record(
      { ...parsed.value, sourceIp: ip, recipient, delivered: false },
      now,
    );
    const delivery = await deliverContactSubmission(
      recipient,
      { ...parsed.value, sourceIp: ip, submittedAt },
      deliveryEnv,
    );
    if (delivery.delivered) await repository.markDelivered(id);

    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
