import { canonicalJson } from "./canonical-json.ts";

const EVENT_ID = /^notify_[a-f0-9]{48}$/u;
const SCOPED_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

export type SecurityNotificationChannel =
  | "email"
  | "slack"
  | "microsoft_teams"
  | "generic_webhook"
  | "pagerduty";
export type SecurityNotificationSeverity = "critical" | "high" | "medium" | "low";
export type PagerDutyEventSeverity = "critical" | "error" | "warning" | "info";

export interface SecurityNotificationEvent {
  readonly schemaVersion: "sutra.security-notification.v1";
  readonly eventId: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly clusterId: string;
  readonly severity: SecurityNotificationSeverity;
  readonly title: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly findingCount: number;
  readonly reportUrl: string;
  readonly evidenceSha256: string;
}

export interface SecurityNotificationPayloads {
  readonly email: {
    readonly to: readonly string[];
    readonly subject: string;
    readonly text: string;
  };
  readonly slack: {
    readonly text: string;
    readonly blocks: readonly Record<string, unknown>[];
  };
  readonly microsoftTeams: {
    readonly type: "message";
    readonly attachments: readonly [{
      readonly contentType: "application/vnd.microsoft.card.adaptive";
      readonly contentUrl: null;
      readonly content: Record<string, unknown>;
    }];
  };
  // Provider-neutral JSON envelope for the registered Jira Cloud Automation
  // and ServiceNow API webhook targets.
  // Stable, flat, and self-describing so a receiving system can map fields
  // without Sutra-specific parsing.
  readonly genericWebhook: {
    readonly schema: "sutra.ticket.v1";
    readonly source: "sutra";
    readonly eventId: string;
    readonly severity: SecurityNotificationSeverity;
    readonly title: string;
    readonly summary: string;
    readonly clusterId: string;
    readonly findingCount: number;
    readonly occurredAt: string;
    readonly evidenceSha256: string;
    readonly reportUrl: string;
  };
  // PagerDuty Events API v2 "trigger" event, minus the routing key. The routing
  // key is a per-destination credential resolved from the managed secret store
  // and injected only inside the worker trust boundary at send time — it is
  // never persisted in this stored payload. `severity` is the PagerDuty scale
  // (critical/error/warning/info), mapped from the Sutra severity.
  readonly pagerduty: {
    readonly event_action: "trigger";
    readonly dedup_key: string;
    readonly payload: {
      readonly summary: string;
      readonly severity: PagerDutyEventSeverity;
      readonly source: "sutra";
      readonly timestamp: string;
      readonly group: string;
      readonly custom_details: {
        readonly findingCount: number;
        readonly clusterId: string;
        readonly evidenceSha256: string;
        readonly reportUrl: string;
      };
    };
    readonly links: readonly { readonly href: string; readonly text: string }[];
  };
  readonly payloadSha256: string;
}

const PAGERDUTY_SEVERITY: Readonly<Record<SecurityNotificationSeverity, PagerDutyEventSeverity>> = {
  critical: "critical",
  high: "error",
  medium: "warning",
  low: "info",
};

export class SecurityNotificationError extends Error {
  public readonly code = "INVALID_NOTIFICATION";

  public constructor() {
    super("Security notification was rejected");
    this.name = "SecurityNotificationError";
  }
}

function invalid(): never {
  throw new SecurityNotificationError();
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  ) invalid();
  return value;
}

function scopedId(value: unknown, pattern = SCOPED_ID): string {
  const parsed = text(value, 192);
  if (!pattern.test(parsed)) invalid();
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = text(value, 40);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now() + 300_000) invalid();
  return new Date(milliseconds).toISOString();
}

function safeUrl(value: unknown, publicOrigin: string): string {
  const parsed = text(value, 2_048);
  let url: URL;
  let expected: URL;
  try {
    url = new URL(parsed);
    expected = new URL(publicOrigin);
  } catch {
    return invalid();
  }
  if (
    expected.protocol !== "https:" || url.origin !== expected.origin ||
    url.username !== "" || url.password !== "" || url.hash !== ""
  ) invalid();
  return url.toString();
}

function recipients(value: readonly string[]): readonly string[] {
  if (value.length === 0 || value.length > 20) invalid();
  const normalized = value.map((item) => text(item.toLocaleLowerCase("en-US"), 254));
  if (normalized.some((item) => !EMAIL.test(item))) invalid();
  return [...new Set(normalized)].sort();
}

function severity(value: unknown): SecurityNotificationSeverity {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") return value;
  return invalid();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeSecurityNotificationEvent(
  value: Omit<SecurityNotificationEvent, "schemaVersion">,
  publicOrigin: string,
): SecurityNotificationEvent {
  if (!Number.isSafeInteger(value.findingCount) || value.findingCount < 1 || value.findingCount > 1_000_000) invalid();
  const evidenceSha256 = text(value.evidenceSha256, 64);
  if (!/^[a-f0-9]{64}$/u.test(evidenceSha256)) invalid();
  return {
    schemaVersion: "sutra.security-notification.v1",
    eventId: scopedId(value.eventId, EVENT_ID),
    orgId: scopedId(value.orgId),
    customerId: scopedId(value.customerId),
    clusterId: scopedId(value.clusterId),
    severity: severity(value.severity),
    title: text(value.title, 200),
    summary: text(value.summary, 1_000),
    occurredAt: timestamp(value.occurredAt),
    findingCount: value.findingCount,
    reportUrl: safeUrl(value.reportUrl, publicOrigin),
    evidenceSha256,
  };
}

/**
 * Produces bounded provider payloads. Destination webhook URLs and provider
 * credentials are intentionally absent; delivery workers resolve secret
 * references from a managed secret store.
 */
export async function buildSecurityNotificationPayloads(input: {
  readonly event: SecurityNotificationEvent;
  readonly emailRecipients: readonly string[];
}): Promise<SecurityNotificationPayloads> {
  const event = input.event;
  const to = recipients(input.emailRecipients);
  const severityLabel = event.severity.toUpperCase();
  const subject = `[Sutra ${severityLabel}] ${event.title}`;
  const textBody = [
    `${event.title} (${severityLabel})`,
    event.summary,
    `Cluster: ${event.clusterId}`,
    `Findings: ${event.findingCount}`,
    `Observed: ${event.occurredAt}`,
    `Evidence: ${event.evidenceSha256}`,
    `Open report: ${event.reportUrl}`,
  ].join("\n");
  const slack = {
    text: subject,
    blocks: [
      { type: "header", text: { type: "plain_text", text: subject, emoji: false } },
      { type: "section", text: { type: "mrkdwn", text: event.summary } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Cluster*\n${event.clusterId}` },
          { type: "mrkdwn", text: `*Findings*\n${event.findingCount}` },
        ],
      },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Sutra", emoji: false }, url: event.reportUrl }] },
    ],
  } as const;
  const microsoftTeams = {
    type: "message" as const,
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive" as const,
      contentUrl: null,
      content: {
        $schema: "https://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: subject, weight: "Bolder", wrap: true },
          { type: "TextBlock", text: event.summary, wrap: true },
          {
            type: "FactSet",
            facts: [
              { title: "Cluster", value: event.clusterId },
              { title: "Findings", value: String(event.findingCount) },
              { title: "Evidence", value: event.evidenceSha256 },
            ],
          },
        ],
        actions: [{ type: "Action.OpenUrl", title: "Open Sutra", url: event.reportUrl }],
      },
    }],
  } as const;
  const genericWebhook = {
    schema: "sutra.ticket.v1" as const,
    source: "sutra" as const,
    eventId: event.eventId,
    severity: event.severity,
    title: event.title,
    summary: event.summary,
    clusterId: event.clusterId,
    findingCount: event.findingCount,
    occurredAt: event.occurredAt,
    evidenceSha256: event.evidenceSha256,
    reportUrl: event.reportUrl,
  };
  const pagerduty = {
    event_action: "trigger" as const,
    dedup_key: event.eventId,
    payload: {
      summary: subject,
      severity: PAGERDUTY_SEVERITY[event.severity],
      source: "sutra" as const,
      timestamp: event.occurredAt,
      group: event.clusterId,
      custom_details: {
        findingCount: event.findingCount,
        clusterId: event.clusterId,
        evidenceSha256: event.evidenceSha256,
        reportUrl: event.reportUrl,
      },
    },
    links: [{ href: event.reportUrl, text: "Open Sutra" }],
  };
  const payloads = {
    email: { to, subject, text: textBody },
    slack,
    microsoftTeams,
    genericWebhook,
    pagerduty,
  };
  return { ...payloads, payloadSha256: await sha256(canonicalJson(payloads)) };
}
