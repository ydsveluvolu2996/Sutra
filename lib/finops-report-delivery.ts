// Workers-compatible delivery for scheduled FinOps cost reports. It REUSES the
// same outbound transport as public contact leads (lib/contact-delivery.ts):
// the identical SUTRA_CONTACT_* environment, the same provider detection, and
// the same sender-identity resolution. Only the payload and the per-schedule
// destination differ.
//
// Two per-schedule destinations (never a stored secret — only a URL or a
// recipient address lives in the row):
//   * webhook — the schedule's own HTTPS endpoint. The report envelope is
//     POSTed there unchanged. The endpoint URL is SSRF-screened at store time.
//   * email   — the schedule's recipient address, sent through the configured
//     transactional email API (SUTRA_CONTACT_EMAIL_API_URL / _KEY). When that
//     API is not configured we do NOT pretend an email went out.
//
// Honesty rules (never relaxed, mirroring contact-delivery):
//   * delivered = true ONLY when the transport returns a 2xx response.
//   * A missing/misconfigured transport resolves to { delivered:false,
//     transport:"none" } — never a fabricated success.
//   * This never throws: any transport failure resolves to delivered:false so
//     the caller can record the honest outcome.
import {
  detectEmailProvider,
  resolveContactFrom,
  usesZohoContactDelivery,
  type ContactDeliveryEnv,
} from "./contact-delivery.ts";
import { assertSafeOutboundUrl } from "./ssrf-guard.ts";
import { sendZohoMail } from "./zoho-mail.ts";

export type ReportDeliveryKind = "webhook" | "email";
export type ReportDeliveryTransport = "webhook" | "email-api" | "none";

// The report delivery draws on the SAME environment as contact delivery, so an
// operator configures one outbound transport, not two.
export type ReportDeliveryEnv = ContactDeliveryEnv;

/** The immutable summary a delivered report carries. Built by the job handler. */
export interface ScheduledReportEnvelope {
  readonly schema: "sutra.finops-scheduled-report.v1";
  readonly scheduleName: string;
  readonly connectionId: string;
  readonly period: string | null;
  readonly lineCount: number;
  readonly currencyTotals: readonly { readonly currency: string; readonly totalMicros: string }[];
  readonly budgetStates: readonly { readonly name: string; readonly state: string; readonly spentMicros: string }[];
  readonly anomalyCount: number;
  readonly generatedAt: string;
  readonly disclaimer: string;
}

export interface ReportDeliveryResult {
  readonly delivered: boolean;
  readonly transport: ReportDeliveryTransport;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/gu;
const SUBJECT_MAX = 200;
// Bound every outbound POST so a slow/hung transport cannot pin the job worker
// (mirrors contact-delivery + the ITSM dispatch route).
const DELIVERY_TIMEOUT_MS = 10_000;

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function headerSafe(value: string, max: number): string {
  return value
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function httpsUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || hasControl(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function buildSubject(envelope: ScheduledReportEnvelope): string {
  const period = envelope.period ?? "no billing period";
  return headerSafe(`Sutra cost report — ${envelope.scheduleName} (${period})`, SUBJECT_MAX);
}

function buildText(envelope: ScheduledReportEnvelope): string {
  const totals = envelope.currencyTotals.length === 0
    ? ["  (no billing lines for the reported period)"]
    : envelope.currencyTotals.map((entry) => `  ${entry.currency}: ${entry.totalMicros} micros`);
  const budgets = envelope.budgetStates.length === 0
    ? ["  (no budgets configured)"]
    : envelope.budgetStates.map((entry) => `  ${entry.name}: ${entry.state} (${entry.spentMicros} micros spent)`);
  return [
    `Schedule: ${envelope.scheduleName}`,
    `Connection: ${envelope.connectionId}`,
    `Period: ${envelope.period ?? "—"}`,
    `Line items: ${envelope.lineCount}`,
    "",
    "Totals by currency:",
    ...totals,
    "",
    "Budgets:",
    ...budgets,
    "",
    `Anomaly signals: ${envelope.anomalyCount}`,
    `Generated at: ${envelope.generatedAt}`,
    "",
    envelope.disclaimer,
  ].join("\n");
}

/**
 * Attempt delivery. Never throws. `fetchImpl` is injectable so the handler test
 * can prove the render->deliver path with no real network.
 */
export async function deliverScheduledReport(input: {
  readonly kind: ReportDeliveryKind;
  readonly target: string;
  readonly envelope: ScheduledReportEnvelope;
  readonly env: ReportDeliveryEnv;
  readonly fetchImpl?: typeof fetch;
}): Promise<ReportDeliveryResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  if (input.kind === "webhook") {
    const url = httpsUrl(input.target);
    // A stored target that is not a usable HTTPS URL cannot be delivered to; be
    // honest rather than throw.
    if (url === null) return { delivered: false, transport: "none" };
    try {
      // Re-screen the tenant-supplied URL right before egress (the store-time
      // check cannot stop a later redirect to an internal target) and refuse to
      // follow redirects so a 3xx cannot bypass the SSRF guard after the first
      // hop. A blocked target throws here and resolves to an honest non-delivery.
      const target = assertSafeOutboundUrl(url);
      const response = await fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ report: input.envelope }),
        redirect: "error",
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      return { delivered: response.ok, transport: "webhook" };
    } catch {
      return { delivered: false, transport: "webhook" };
    }
  }

  // Email: reuse the contact transactional-email transport (env-provided URL +
  // key). The recipient is the per-schedule target; the transport is shared.
  const recipient = input.target.trim();
  if (!EMAIL.test(recipient) || hasControl(recipient)) {
    return { delivered: false, transport: "none" };
  }
  const from = resolveContactFrom(input.env);
  const subject = buildSubject(input.envelope);
  const text = buildText(input.envelope);
  if (usesZohoContactDelivery(input.env)) {
    const outcome = await sendZohoMail(input.env, {
      fromAddress: from.email,
      toAddress: recipient,
      subject,
      content: text,
    }, fetchImpl);
    return {
      delivered: outcome.status === "accepted",
      transport:
        outcome.errorCode === "EMAIL_NOT_CONFIGURED" ||
        outcome.errorCode === "EMAIL_CONFIGURATION_INVALID"
          ? "none"
          : "email-api",
    };
  }

  const emailApiUrl = httpsUrl(input.env.SUTRA_CONTACT_EMAIL_API_URL);
  const emailApiKey = input.env.SUTRA_CONTACT_EMAIL_API_KEY?.trim();
  if (
    emailApiUrl === null || emailApiKey === undefined || emailApiKey.length === 0
  ) {
    return { delivered: false, transport: "none" };
  }
  const provider = detectEmailProvider(input.env, emailApiUrl);

  let body: unknown;
  if (provider === "resend") {
    body = { from: from.display, to: [recipient], subject, text };
  } else if (provider === "sendgrid") {
    body = {
      personalizations: [{ to: [{ email: recipient }] }],
      from: { email: from.email },
      subject,
      content: [{ type: "text/plain", value: text }],
    };
  } else {
    // Generic self-hosted forwarder: the stable envelope with the Bearer header.
    body = { recipient, subject, report: input.envelope };
  }

  try {
    const response = await fetchImpl(emailApiUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${emailApiKey}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return { delivered: response.ok, transport: "email-api" };
  } catch {
    return { delivered: false, transport: "email-api" };
  }
}
