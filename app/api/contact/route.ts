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
const MAX_GLOBAL_PER_WINDOW = 60;

const SOURCE_IP = /^[A-Za-z0-9.:_-]{1,64}$/u;
// Single shared bucket for requests without a trusted edge IP. Everything
// unattributed shares one per-source budget so a spoofer cannot mint buckets.
const UNATTRIBUTED_SOURCE = "unattributed";

function tooManyRequests(): never {
  throw Object.assign(new Error("Too many contact submissions; please try again shortly"), {
    code: "RATE_LIMITED",
    status: 429,
  });
}

/**
 * Per-source rate limiting assumes a Cloudflare edge that sets `cf-connecting-ip`.
 * Only that header is trusted as the bucket key — a client-supplied
 * `x-forwarded-for` is NOT honored, because it is trivially spoofable and would
 * let an attacker mint unlimited independent buckets. When the trusted header is
 * absent every request collapses into one shared "unattributed" bucket.
 */
function sourceIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")?.trim();
  if (direct !== undefined && SOURCE_IP.test(direct)) return direct;
  return UNATTRIBUTED_SOURCE;
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

    // RECORD BEFORE DELIVER. Reserve the row first (delivered = 0) so the
    // rate-limit counters above include in-flight submissions — this closes the
    // check-before-write window that let a burst of concurrent requests all pass
    // the count before any of them persisted. `ok: true` remains the honest
    // guarantee that the lead is durably stored; `delivered` only reflects
    // whether a configured transport accepted it.
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
