const MAXIMUM_EVENT_BYTES = 256 * 1024;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DELIVERY_ID = /^notify_[a-f0-9]{48}$/u;
const MESSAGE_ID = /^[A-Za-z0-9._@-]{1,200}$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const AWS_ACCOUNT_ID = /^\d{12}$/u;
const CONFIGURATION_SET = /^[A-Za-z0-9_-]{1,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type SesFeedbackEventType =
  | "send"
  | "delivery"
  | "delivery_delay"
  | "bounce"
  | "complaint"
  | "reject"
  | "rendering_failure";

export interface SesFeedbackEvent {
  readonly eventId: string;
  readonly deliveryId: string;
  readonly providerMessageId: string;
  readonly eventType: SesFeedbackEventType;
  readonly occurredAt: number;
  readonly payloadSha256: string;
}

export class SesFeedbackValidationError extends Error {
  public readonly code = "INVALID_SES_FEEDBACK";

  public constructor() {
    super("SES feedback event rejected");
    this.name = "SesFeedbackValidationError";
  }
}

function invalid(): never {
  throw new SesFeedbackValidationError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function singleTag(
  tags: Record<string, unknown>,
  name: string,
): string {
  const values = tags[name];
  if (
    !Array.isArray(values) ||
    values.length !== 1 ||
    typeof values[0] !== "string"
  ) invalid();
  return values[0];
}

function eventType(value: unknown): SesFeedbackEventType {
  switch (value) {
    case "Send": return "send";
    case "Delivery": return "delivery";
    case "DeliveryDelay": return "delivery_delay";
    case "Bounce": return "bounce";
    case "Complaint": return "complaint";
    case "Reject": return "reject";
    case "Rendering Failure": return "rendering_failure";
    default: return invalid();
  }
}

export async function parseSesFeedbackEvent(input: {
  readonly body: string;
  readonly expectedRegion: string;
  readonly expectedAccountId: string;
  readonly expectedConfigurationSetName: string;
  readonly now?: number;
}): Promise<SesFeedbackEvent> {
  if (
    Buffer.byteLength(input.body, "utf8") < 2 ||
    Buffer.byteLength(input.body, "utf8") > MAXIMUM_EVENT_BYTES ||
    !AWS_REGION.test(input.expectedRegion) ||
    !AWS_ACCOUNT_ID.test(input.expectedAccountId) ||
    !CONFIGURATION_SET.test(input.expectedConfigurationSetName)
  ) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return invalid();
  }
  const envelope = record(parsed);
  const detail = record(envelope.detail);
  const mail = record(detail.mail);
  const tags = record(mail.tags);
  const id = envelope.id;
  const account = envelope.account;
  const region = envelope.region;
  const source = envelope.source;
  const occurredAt = Date.parse(String(envelope.time ?? ""));
  const providerMessageId = mail.messageId;
  const deliveryId = singleTag(tags, "sutra_delivery_id");
  const configurationSetName = singleTag(tags, "ses:configuration-set");
  const now = input.now ?? Date.now();
  if (
    typeof id !== "string" ||
    !EVENT_ID.test(id) ||
    source !== "aws.ses" ||
    account !== input.expectedAccountId ||
    region !== input.expectedRegion ||
    configurationSetName !== input.expectedConfigurationSetName ||
    typeof providerMessageId !== "string" ||
    !MESSAGE_ID.test(providerMessageId) ||
    !DELIVERY_ID.test(deliveryId) ||
    !Number.isFinite(occurredAt) ||
    occurredAt < Date.UTC(2020, 0, 1) ||
    occurredAt > now + 5 * 60_000
  ) invalid();
  const payloadSha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.body)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!SHA256.test(payloadSha256)) invalid();
  return {
    eventId: id.toLowerCase(),
    deliveryId,
    providerMessageId,
    eventType: eventType(detail.eventType),
    occurredAt,
    payloadSha256,
  };
}
