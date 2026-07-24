import { assertSafeOutboundUrl } from "./ssrf-guard";
import type {
  InvitationDeliveryEnv,
  InvitationDeliveryResult,
} from "./invitation-delivery";

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const DELIVERY_TIMEOUT_MS = 10_000;

function bareEmail(value: string): string | null {
  const match = /<([^<>]+)>/u.exec(value);
  const candidate = (match?.[1] ?? value).trim();
  return EMAIL.test(candidate) ? candidate : null;
}

export async function deliverPasswordResetEmail(
  input: {
    readonly recipient: string;
    readonly resetUrl: string;
    readonly expiresAt: string;
  },
  env: InvitationDeliveryEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<InvitationDeliveryResult> {
  const endpoint = env.SUTRA_INVITATION_EMAIL_API_URL?.trim();
  const apiKey = env.SUTRA_INVITATION_EMAIL_API_KEY?.trim();
  const from = env.SUTRA_INVITATION_FROM?.trim();
  const origin = env.SUTRA_PUBLIC_ORIGIN?.trim();
  if (!endpoint || !apiKey || !from || !origin) {
    return {
      status: "failed",
      transport: "none",
      provider: "none",
      errorCode: "EMAIL_NOT_CONFIGURED",
      httpStatus: null,
    };
  }

  try {
    const url = assertSafeOutboundUrl(endpoint);
    const sender = bareEmail(from);
    const reset = new URL(input.resetUrl);
    const publicOrigin = new URL(origin);
    if (
      sender === null ||
      !EMAIL.test(input.recipient) ||
      /[\r\n]/u.test(from) ||
      reset.origin !== publicOrigin.origin ||
      reset.pathname !== "/reset-password"
    ) {
      throw new Error("invalid reset delivery configuration");
    }
    const configured = env.SUTRA_INVITATION_EMAIL_PROVIDER?.trim().toLowerCase();
    const provider =
      configured === "resend" ||
      configured === "sendgrid" ||
      configured === "generic"
        ? configured
        : url.hostname.includes("resend")
          ? "resend"
          : url.hostname.includes("sendgrid")
            ? "sendgrid"
            : "generic";
    const subject = "Reset your Sutra CMDB password";
    const text = [
      "A password reset was requested for your Sutra CMDB account.",
      "",
      `This single-use link expires at ${input.expiresAt}.`,
      input.resetUrl,
      "",
      "If you did not request this change, ignore this email and contact your Sutra administrator.",
    ].join("\n");
    const body =
      provider === "resend"
        ? { from, to: [input.recipient], subject, text }
        : provider === "sendgrid"
          ? {
              personalizations: [{ to: [{ email: input.recipient }] }],
              from: { email: sender },
              subject,
              content: [{ type: "text/plain", value: text }],
            }
          : { from, to: [input.recipient], subject, text };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) {
        return {
          status: "accepted",
          transport: "email-api",
          provider,
          errorCode: null,
          httpStatus: response.status,
        };
      }
      return {
        status: "failed",
        transport: "email-api",
        provider,
        errorCode:
          response.status === 429
            ? "PROVIDER_RATE_LIMITED"
            : response.status >= 500
              ? "PROVIDER_UNAVAILABLE"
              : "PROVIDER_REJECTED",
        httpStatus: response.status,
      };
    } catch {
      return {
        status: "unknown",
        transport: "email-api",
        provider,
        errorCode: "PROVIDER_RESULT_UNKNOWN",
        httpStatus: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return {
      status: "failed",
      transport: "none",
      provider: "none",
      errorCode: "EMAIL_CONFIGURATION_INVALID",
      httpStatus: null,
    };
  }
}
