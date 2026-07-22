import { assertSafeOutboundUrl } from "./ssrf-guard.ts";

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const MAXIMUM_FROM_LENGTH = 320;
const MAXIMUM_SUBJECT_LENGTH = 180;
const DELIVERY_TIMEOUT_MS = 10_000;

export type InvitationDeliveryProvider = "none" | "resend" | "sendgrid" | "generic";
export type InvitationDeliveryTransport = "none" | "email-api";

export interface InvitationDeliveryEnv {
  readonly SUTRA_INVITATION_FROM?: string;
  readonly SUTRA_INVITATION_EMAIL_PROVIDER?: string;
  readonly SUTRA_INVITATION_EMAIL_API_URL?: string;
  readonly SUTRA_INVITATION_EMAIL_API_KEY?: string;
  readonly SUTRA_PUBLIC_ORIGIN?: string;
}

export interface InvitationEmailInput {
  readonly recipient: string;
  readonly activationUrl: string;
  readonly expiresAt: string;
  readonly role: string;
}

export interface InvitationDeliveryResult {
  /** "accepted" means the provider accepted the request, not inbox delivery. */
  readonly status: "accepted" | "failed" | "unknown";
  readonly transport: InvitationDeliveryTransport;
  readonly provider: InvitationDeliveryProvider;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
}

export interface InvitationProviderRequest {
  readonly url: URL;
  readonly provider: Exclude<InvitationDeliveryProvider, "none">;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

function bareEmail(value: string): string | null {
  const match = /<([^<>]+)>/u.exec(value);
  const candidate = (match?.[1] ?? value).trim();
  return EMAIL.test(candidate) ? candidate : null;
}

function safeHeader(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function provider(env: InvitationDeliveryEnv, url: URL): Exclude<InvitationDeliveryProvider, "none"> {
  const configured = env.SUTRA_INVITATION_EMAIL_PROVIDER?.trim().toLocaleLowerCase("en-US");
  if (configured === "resend" || configured === "sendgrid" || configured === "generic") return configured;
  if (configured !== undefined && configured.length > 0) throw new Error("Unsupported invitation email provider");
  if (url.hostname.toLocaleLowerCase("en-US").includes("resend")) return "resend";
  if (url.hostname.toLocaleLowerCase("en-US").includes("sendgrid")) return "sendgrid";
  return "generic";
}

function textBody(input: InvitationEmailInput): string {
  return [
    "You have been invited to Sutra CMDB.",
    "",
    `Assigned role: ${safeHeader(input.role.replaceAll("_", " "), 64)}`,
    `This single-use invitation expires at ${input.expiresAt}.`,
    "",
    "Activate your account:",
    input.activationUrl,
    "",
    "If you were not expecting this invitation, do not open the link. Contact the Sutra administrator who invited you.",
  ].join("\n");
}

/**
 * Builds a provider-specific request without performing network I/O. The
 * invitation token exists only inside the request body and is never returned in
 * an error, logged, or persisted by this module.
 */
export function buildInvitationProviderRequest(
  input: InvitationEmailInput,
  env: InvitationDeliveryEnv,
): InvitationProviderRequest | null {
  const endpoint = env.SUTRA_INVITATION_EMAIL_API_URL?.trim();
  const apiKey = env.SUTRA_INVITATION_EMAIL_API_KEY?.trim();
  const configuredFrom = env.SUTRA_INVITATION_FROM?.trim();
  const configuredOrigin = env.SUTRA_PUBLIC_ORIGIN?.trim();
  if (!endpoint || !apiKey || !configuredFrom || !configuredOrigin) return null;

  const url = assertSafeOutboundUrl(endpoint);
  const fromEmail = bareEmail(configuredFrom);
  if (fromEmail === null || configuredFrom.length > MAXIMUM_FROM_LENGTH || /[\r\n]/u.test(configuredFrom)) return null;
  if (!EMAIL.test(input.recipient) || /[\r\n]/u.test(input.recipient)) return null;
  const activation = new URL(input.activationUrl);
  const publicOrigin = new URL(configuredOrigin);
  if (
    activation.protocol !== "https:"
    || publicOrigin.protocol !== "https:"
    || publicOrigin.username !== ""
    || publicOrigin.password !== ""
    || publicOrigin.pathname !== "/"
    || publicOrigin.search !== ""
    || publicOrigin.hash !== ""
    || activation.origin !== publicOrigin.origin
  ) return null;

  const selected = provider(env, url);
  const subject = safeHeader("You're invited to Sutra CMDB", MAXIMUM_SUBJECT_LENGTH);
  const text = textBody(input);
  const body = selected === "resend"
    ? { from: configuredFrom, to: [input.recipient], subject, text }
    : selected === "sendgrid"
      ? {
          personalizations: [{ to: [{ email: input.recipient }] }],
          from: { email: fromEmail },
          subject,
          content: [{ type: "text/plain", value: text }],
        }
      : { from: configuredFrom, to: [input.recipient], subject, text };
  return {
    url,
    provider: selected,
    body,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json; charset=utf-8",
    },
  };
}

function rejected(providerName: Exclude<InvitationDeliveryProvider, "none">, status: number): InvitationDeliveryResult {
  const errorCode = status === 401 || status === 403
    ? "PROVIDER_AUTHENTICATION_FAILED"
    : status === 429
      ? "PROVIDER_RATE_LIMITED"
      : status >= 500
        ? "PROVIDER_UNAVAILABLE"
        : "PROVIDER_REJECTED";
  return { status: "failed", transport: "email-api", provider: providerName, errorCode, httpStatus: status };
}

/**
 * Sends one invitation through the configured transactional email API. A 2xx
 * is reported as provider "accepted" rather than inbox-delivered because only
 * provider webhooks can prove later delivery/bounce outcomes.
 */
export async function deliverInvitationEmail(
  input: InvitationEmailInput,
  env: InvitationDeliveryEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<InvitationDeliveryResult> {
  let request: InvitationProviderRequest | null;
  try {
    request = buildInvitationProviderRequest(input, env);
  } catch {
    return {
      status: "failed",
      transport: "none",
      provider: "none",
      errorCode: "EMAIL_CONFIGURATION_INVALID",
      httpStatus: null,
    };
  }
  if (request === null) {
    return {
      status: "failed",
      transport: "none",
      provider: "none",
      errorCode: "EMAIL_NOT_CONFIGURED",
      httpStatus: null,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      redirect: "error",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok) return rejected(request.provider, response.status);
    return {
      status: "accepted",
      transport: "email-api",
      provider: request.provider,
      errorCode: null,
      httpStatus: response.status,
    };
  } catch {
    // A timeout/network exception is ambiguous: the provider may have accepted
    // the request before the response was lost. Mark UNKNOWN and never retry the
    // same idempotency key automatically, preventing duplicate messages.
    return {
      status: "unknown",
      transport: "email-api",
      provider: request.provider,
      errorCode: "PROVIDER_RESULT_UNKNOWN",
      httpStatus: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
