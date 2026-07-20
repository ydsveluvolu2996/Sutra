// Workers-compatible delivery for public contact submissions.
//
// The app runs on Cloudflare Workers, which have NO SMTP. So "delivery" here is
// an outbound HTTPS POST to a transport you configure — a webhook or a
// transactional-email API — that forwards the lead to the real inbox. If no
// transport is configured we DO NOT pretend an email was sent: the submission
// is still persisted (delivered = 0) and the route's honest guarantee is only
// that the lead was safely stored.
//
// IMPORTANT (Workers runtime): these variables must reach the Worker `env`,
// which reads from `.dev.vars` — NOT the container's process.env. The pilot
// setup (scripts/setup-local-pilot.mjs) copies any SUTRA_CONTACT_* present in
// the container env into `.dev.vars`, and compose.yaml passes them through to
// the app container. Set them once in `.sutra/docker.env` and they flow
// app-container -> .dev.vars -> Worker env; then delivery turns on with no
// code change.
//
// ── Environment ─────────────────────────────────────────────────────────────
//   SUTRA_CONTACT_RECIPIENT   Destination the lead is routed to.
//                             Defaults to yds.veluvolu@gmail.com.
//   SUTRA_CONTACT_FROM        Sender identity. Accepts "Name <email>" or a bare
//                             address. Defaults to "Sutra <onboarding@resend.dev>".
//   SUTRA_CONTACT_PROVIDER    Optional explicit transport: "resend" | "sendgrid"
//                             | "webhook". When unset the provider is inferred
//                             from the email-API URL host.
//
//   Transport selection (first match wins):
//
//   1. Webhook (Zapier / Make / Pipedream / Worker email-route hook):
//        SUTRA_CONTACT_WEBHOOK_URL   HTTPS endpoint.
//      POSTs the stable envelope { recipient, submission: { name, email,
//      company, message, sourceIp, submittedAt } } unchanged.
//
//   2. Transactional email API:
//        SUTRA_CONTACT_EMAIL_API_URL   Provider send endpoint (HTTPS).
//        SUTRA_CONTACT_EMAIL_API_KEY   Bearer token for that endpoint.
//      The provider is detected from SUTRA_CONTACT_PROVIDER or the URL host:
//
//      • Resend  (host contains "resend", or provider=resend)
//          URL:    https://api.resend.com/emails
//          Header: Authorization: Bearer <SUTRA_CONTACT_EMAIL_API_KEY>
//          Body:   { from: "<SUTRA_CONTACT_FROM>", to: [recipient],
//                    reply_to: "<submitter email>", subject, text }
//        NOTE: Resend only delivers to arbitrary inboxes (e.g. Gmail) once you
//        VERIFY a sender domain and set SUTRA_CONTACT_FROM to an address on it.
//        The default onboarding@resend.dev delivers ONLY to the Resend account
//        owner's own email — fine for a smoke test, not for real leads.
//
//      • SendGrid (host contains "sendgrid", or provider=sendgrid)
//          URL:    https://api.sendgrid.com/v3/mail/send
//          Header: Authorization: Bearer <SUTRA_CONTACT_EMAIL_API_KEY>
//          Body:   { personalizations: [{ to: [{ email: recipient }] }],
//                    from: { email: "<parsed SUTRA_CONTACT_FROM>" },
//                    reply_to: { email: "<submitter email>" },
//                    subject, content: [{ type: "text/plain", value: text }] }
//        NOTE: SendGrid requires the `from` address to belong to a VERIFIED
//        Single Sender or authenticated domain, or the send is rejected.
//
//      • Generic (any other host, no provider match)
//          Falls back to the { recipient, submission } envelope with the Bearer
//          header — for a self-hosted forwarder that speaks that shape.
//
//   3. Nothing configured -> { delivered: false, transport: "none" }. The lead
//      is still persisted by the caller; we never claim an email was sent.
//
// delivered = 1 is recorded only when the transport returns a 2xx response.

export const DEFAULT_CONTACT_RECIPIENT = "yds.veluvolu@gmail.com";
export const DEFAULT_CONTACT_FROM = "Sutra <onboarding@resend.dev>";

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;

// Header-bound fields (subject, sender) must never carry CR/LF or other control
// characters — that is a header-injection vector. Caps bound the built subject.
const SUBJECT_MAX = 200;
const FROM_MAX = 320;

export interface ContactDeliveryEnv {
  readonly SUTRA_CONTACT_RECIPIENT?: string;
  readonly SUTRA_CONTACT_FROM?: string;
  readonly SUTRA_CONTACT_PROVIDER?: string;
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
export type ContactEmailProvider = "resend" | "sendgrid" | "generic";

export interface ContactDeliveryResult {
  readonly delivered: boolean;
  readonly transport: ContactDeliveryTransport;
}

/** A fully-composed outbound request; `body` is the JSON value to POST. */
export interface ProviderRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
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

function hasCrlf(value: string): boolean {
  return /[\r\n]/u.test(value);
}

/** Strip control chars (incl. CR/LF), collapse whitespace, and cap length. */
function headerSafe(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
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

/** Extract a bare email from `"Name <email>"` or a bare address. */
function parseFromEmail(from: string): string | null {
  const angle = /<([^<>]+)>/u.exec(from);
  const candidate = (angle ? angle[1] : from).trim();
  return candidate.length > 0 ? candidate : null;
}

/**
 * Resolve the sender both as a display string (for providers that accept
 * "Name <email>") and as a bare, validated address (for providers that want a
 * plain email). Falls back to the default when misconfigured.
 */
export function resolveContactFrom(env: ContactDeliveryEnv): { display: string; email: string } {
  const configured = env.SUTRA_CONTACT_FROM?.trim();
  if (configured !== undefined && configured.length > 0 && !hasCrlf(configured)) {
    const email = parseFromEmail(configured);
    if (email !== null && EMAIL.test(email)) {
      return { display: headerSafe(configured, FROM_MAX), email };
    }
  }
  // Default is a known-good literal, so the parse always succeeds.
  return { display: DEFAULT_CONTACT_FROM, email: parseFromEmail(DEFAULT_CONTACT_FROM) as string };
}

/** Decide the email provider from an explicit override or the endpoint host. */
export function detectEmailProvider(env: ContactDeliveryEnv, url: string): ContactEmailProvider {
  const explicit = env.SUTRA_CONTACT_PROVIDER?.trim().toLowerCase();
  if (explicit === "resend") return "resend";
  if (explicit === "sendgrid") return "sendgrid";
  let host = "";
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    host = "";
  }
  if (host.includes("resend")) return "resend";
  if (host.includes("sendgrid")) return "sendgrid";
  return "generic";
}

/** Subject line, header-safe. */
function buildSubject(payload: ContactDeliveryPayload): string {
  const base = `New Sutra contact — ${payload.name}${payload.company ? ` (${payload.company})` : ""}`;
  return headerSafe(base, SUBJECT_MAX);
}

/** Readable plaintext body. Newlines are fine here — this is the message body. */
function buildText(payload: ContactDeliveryPayload): string {
  return [
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Company: ${payload.company ?? "—"}`,
    "",
    "Message:",
    payload.message,
    "",
    `Source IP: ${payload.sourceIp}`,
    `Submitted at: ${payload.submittedAt}`,
  ].join("\n");
}

/**
 * Compose the provider-correct outbound request, or null when no transport is
 * configured. Exported so the body shapes are unit-testable without any fetch.
 */
export function buildProviderRequest(
  env: ContactDeliveryEnv,
  recipient: string,
  payload: ContactDeliveryPayload,
): ProviderRequest | null {
  // 1) Webhook takes precedence: the stable envelope, unchanged.
  const webhookUrl = httpsUrl(env.SUTRA_CONTACT_WEBHOOK_URL);
  if (webhookUrl !== null) {
    return { url: webhookUrl, headers: {}, body: { recipient, submission: payload }, transport: "webhook" };
  }

  // 2) Transactional email API. Requires both a URL and a key.
  const emailApiUrl = httpsUrl(env.SUTRA_CONTACT_EMAIL_API_URL);
  const emailApiKey = env.SUTRA_CONTACT_EMAIL_API_KEY?.trim();
  if (emailApiUrl === null || emailApiKey === undefined || emailApiKey.length === 0) {
    return null;
  }

  const headers = { authorization: `Bearer ${emailApiKey}` };
  const provider = detectEmailProvider(env, emailApiUrl);
  const from = resolveContactFrom(env);
  const subject = buildSubject(payload);
  const text = buildText(payload);
  // Reply-To routes a human reply straight back to the lead. The parse already
  // validated the address; re-check defensively so no CR/LF reaches a header.
  const replyTo = EMAIL.test(payload.email) && !hasCrlf(payload.email) ? payload.email : null;

  if (provider === "resend") {
    const body: Record<string, unknown> = { from: from.display, to: [recipient], subject, text };
    if (replyTo !== null) body.reply_to = replyTo;
    return { url: emailApiUrl, headers, body, transport: "email-api" };
  }

  if (provider === "sendgrid") {
    const body: Record<string, unknown> = {
      personalizations: [{ to: [{ email: recipient }] }],
      from: { email: from.email },
      subject,
      content: [{ type: "text/plain", value: text }],
    };
    if (replyTo !== null) body.reply_to = { email: replyTo };
    return { url: emailApiUrl, headers, body, transport: "email-api" };
  }

  // Generic self-hosted forwarder: same Bearer + stable envelope as the webhook.
  return { url: emailApiUrl, headers, body: { recipient, submission: payload }, transport: "email-api" };
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
  const request = buildProviderRequest(env, recipient, payload);

  // No transport configured: honest non-delivery. The lead is still persisted.
  if (request === null) return { delivered: false, transport: "none" };

  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", ...request.headers },
      body: JSON.stringify(request.body),
    });
    return { delivered: response.ok, transport: request.transport };
  } catch {
    return { delivered: false, transport: request.transport };
  }
}
