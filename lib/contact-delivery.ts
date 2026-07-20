// Workers-compatible delivery for public contact submissions.
//
// The app runs on Cloudflare Workers, which have NO SMTP. So "delivery" here is
// an outbound HTTPS POST to a transport you configure — a webhook or a
// transactional-email API — that forwards the lead to the real inbox. If no
// transport is configured we DO NOT pretend an email was sent: the submission
// is still persisted (delivered = 0) and the route's honest guarantee is only
// that the lead was safely stored.
//
// ── Environment to enable live delivery to the recipient Gmail ──────────────
//   SUTRA_CONTACT_RECIPIENT       Destination address the lead is routed to.
//                                 Defaults to yds.veluvolu@gmail.com.
//   Option A — generic webhook (simplest):
//   SUTRA_CONTACT_WEBHOOK_URL     An HTTPS endpoint (e.g. a Zapier/Make/Pipedream
//                                 or Cloudflare Worker "email route" hook) that
//                                 receives the JSON below and forwards it to
//                                 SUTRA_CONTACT_RECIPIENT. Set this to turn on
//                                 delivery — nothing else is required.
//   Option B — transactional email API (e.g. Resend / SendGrid / Mailgun):
//   SUTRA_CONTACT_EMAIL_API_URL   The provider's send endpoint (HTTPS).
//   SUTRA_CONTACT_EMAIL_API_KEY   Bearer token for that endpoint.
//                                 When both are set the same JSON payload is
//                                 POSTed with an Authorization: Bearer header;
//                                 configure the provider to deliver to the
//                                 recipient. (A provider-specific body shape can
//                                 be added here if your provider needs one.)
//
// The POST body is a stable JSON envelope: { recipient, submission: { name,
// email, company, message, sourceIp, submittedAt } }. delivered = 1 is recorded
// only when the transport returns a 2xx response.

export const DEFAULT_CONTACT_RECIPIENT = "yds.veluvolu@gmail.com";

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;

export interface ContactDeliveryEnv {
  readonly SUTRA_CONTACT_RECIPIENT?: string;
  readonly SUTRA_CONTACT_WEBHOOK_URL?: string;
  readonly SUTRA_CONTACT_EMAIL_API_URL?: string;
  readonly SUTRA_CONTACT_EMAIL_API_KEY?: string;
}

export interface ContactDeliveryPayload {
  readonly name: string;
  readonly email: string;
  readonly company: string | null;
  readonly message: string;
  readonly sourceIp: string;
  readonly submittedAt: string;
}

export type ContactDeliveryTransport = "webhook" | "email-api" | "none";

export interface ContactDeliveryResult {
  readonly delivered: boolean;
  readonly transport: ContactDeliveryTransport;
}

/** Resolve (and validate) the configured recipient, falling back to the default. */
export function resolveContactRecipient(env: ContactDeliveryEnv): string {
  const configured = env.SUTRA_CONTACT_RECIPIENT?.trim();
  if (configured !== undefined && configured.length > 0 && configured.length <= 320 && EMAIL.test(configured)) {
    return configured;
  }
  return DEFAULT_CONTACT_RECIPIENT;
}

function httpsUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || /[\r\n]/u.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Attempt delivery. NEVER throws: any transport failure resolves to
 * { delivered: false }, so the caller still persists the lead and answers
 * honestly. Injectable fetch keeps this unit-testable.
 */
export async function deliverContactSubmission(
  recipient: string,
  payload: ContactDeliveryPayload,
  env: ContactDeliveryEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ContactDeliveryResult> {
  const body = JSON.stringify({ recipient, submission: payload });

  const webhookUrl = httpsUrl(env.SUTRA_CONTACT_WEBHOOK_URL);
  const emailApiUrl = httpsUrl(env.SUTRA_CONTACT_EMAIL_API_URL);
  const emailApiKey = env.SUTRA_CONTACT_EMAIL_API_KEY?.trim();

  let target: { url: string; headers: Record<string, string>; transport: ContactDeliveryTransport } | null = null;
  if (webhookUrl !== null) {
    target = { url: webhookUrl, headers: {}, transport: "webhook" };
  } else if (emailApiUrl !== null && emailApiKey !== undefined && emailApiKey.length > 0) {
    target = { url: emailApiUrl, headers: { authorization: `Bearer ${emailApiKey}` }, transport: "email-api" };
  }

  // No transport configured: honest non-delivery. The lead is still persisted.
  if (target === null) return { delivered: false, transport: "none" };

  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", ...target.headers },
      body,
    });
    return { delivered: response.ok, transport: target.transport };
  } catch {
    return { delivered: false, transport: target.transport };
  }
}
