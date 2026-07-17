import type { NotificationDestinationConfig } from "./notification-destination-types.ts";

const SECRET_REFERENCE = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{2,190}$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;

export class NotificationDestinationValidationError extends Error {
  public readonly code = "INVALID_INPUT";

  public constructor() {
    super("Notification destination configuration rejected");
    this.name = "NotificationDestinationValidationError";
  }
}

function invalid(): never {
  throw new NotificationDestinationValidationError();
}

function email(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized.length > 254 || !EMAIL.test(normalized)) invalid();
  return normalized;
}

export function normalizeNotificationDestinationConfig(
  config: NotificationDestinationConfig,
): NotificationDestinationConfig {
  if (config.channel === "email") {
    if (
      !Array.isArray(config.recipients) ||
      config.recipients.length < 1 ||
      config.recipients.length > 20 ||
      !AWS_REGION.test(config.sesRegion)
    ) invalid();
    const recipients = [...new Set(config.recipients.map(email))].sort();
    return {
      channel: "email",
      recipients,
      fromAddress: email(config.fromAddress),
      sesRegion: config.sesRegion,
    };
  }
  if (
    (config.channel !== "slack" && config.channel !== "microsoft_teams") ||
    !SECRET_REFERENCE.test(config.secretReference)
  ) invalid();
  return { channel: config.channel, secretReference: config.secretReference };
}
