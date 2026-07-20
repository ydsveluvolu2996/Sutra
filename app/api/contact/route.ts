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
import { readBoundedJson } from "../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// PUBLIC endpoint: this is the marketing-site "Contact us" form. It is
// deliberately UNauthenticated — it requires no session, and `/api/contact` is
// on the public allowlist in lib/deployment-security.ts. All safety therefore
// comes from strict validation, a bounded body, a bot honeypot, and a durable
// rate limit rather than from a session.

// Bodies are tiny; anything larger than 8 KiB is not a real contact form post.
const MAX_BODY_BYTES = 8 * 1024;
// Sliding one-minute window; abusive callers are throttled per source IP with a
// global ceiling as a backstop against a distributed flood.
const RATE_WINDOW_MS = 60_000;
const MAX_PER_SOURCE_PER_WINDOW = 5;
const MAX_GLOBAL_PER_WINDOW = 200;

const SOURCE_IP = /^[A-Za-z0-9.:_-]{1,64}$/u;

function tooManyRequests(): never {
  throw Object.assign(new Error("Too many contact submissions; please try again shortly"), {
    code: "RATE_LIMITED",
    status: 429,
  });
}

/** Best-effort client IP from the edge headers; unmatched values collapse to "unknown". */
function sourceIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct !== undefined && SOURCE_IP.test(direct)) return direct;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded !== undefined && SOURCE_IP.test(forwarded)) return forwarded;
  return "unknown";
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    const parsed = parseContactSubmission(body);

    // Honeypot filled → almost certainly a bot. Silently drop (no persistence)
    // but answer 200 so the bot cannot tell it was rejected.
    if (parsed.ok && parsed.drop) {
      return jsonResponse({ ok: true });
    }
    if (!parsed.ok) {
      throw Object.assign(new Error("The contact request is invalid"), { code: "INVALID_INPUT" });
    }

    const repository = new ContactSubmissionRepository();
    const ip = sourceIp(request);
    const now = Date.now();
    const since = now - RATE_WINDOW_MS;
    const [fromSource, globalCount] = await Promise.all([
      repository.countRecentForSource(ip, since),
      repository.countRecentGlobal(since),
    ]);
    if (fromSource >= MAX_PER_SOURCE_PER_WINDOW || globalCount >= MAX_GLOBAL_PER_WINDOW) tooManyRequests();

    const deliveryEnv = env as unknown as ContactDeliveryEnv;
    const recipient = resolveContactRecipient(deliveryEnv);
    const submittedAt = new Date(now).toISOString();
    const delivery = await deliverContactSubmission(
      recipient,
      { ...parsed.value, sourceIp: ip, submittedAt },
      deliveryEnv,
    );

    // Persist EVERY accepted submission so nothing is ever lost. `ok: true` is
    // the honest guarantee: the lead is durably stored. `delivered` reflects
    // only whether a configured transport accepted it — we never claim an email
    // was sent when no transport is set.
    await repository.record(
      { ...parsed.value, sourceIp: ip, recipient, delivered: delivery.delivered },
      now,
    );

    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
