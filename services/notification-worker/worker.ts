import {
  deliverSecurityNotification,
  type SecurityNotificationDeliveryDependencies,
} from "../../lib/security-notification-delivery.ts";
import { SecurityNotificationRepository } from "../../db/security-notification-repository";

export async function processOneSecurityNotification(input: {
  readonly repository?: SecurityNotificationRepository;
  readonly delivery?: SecurityNotificationDeliveryDependencies;
  readonly now?: () => number;
} = {}): Promise<"idle" | "delivered" | "retry_scheduled" | "dead_letter" | "not_configured"> {
  const repository = input.repository ?? new SecurityNotificationRepository();
  const now = input.now ?? Date.now;
  const claimed = await repository.claim(now());
  if (claimed === null) return "idle";
  if (input.delivery === undefined || !claimed.destination.enabled) {
    await repository.finish(
      claimed.id,
      claimed.leaseToken,
      "not_configured",
      "DELIVERY_ADAPTER_NOT_CONFIGURED",
      null,
    );
    return "not_configured";
  }
  const configuration = claimed.destination.configuration;
  const destinations = configuration.channel === "email"
    ? {
        email: {
          region: configuration.sesRegion,
          fromAddress: configuration.fromAddress,
        },
      }
    : configuration.channel === "slack"
      ? { slackSecretReference: configuration.secretReference }
      : { microsoftTeamsSecretReference: configuration.secretReference };
  const [result] = await deliverSecurityNotification({
    deliveryId: claimed.event.eventId,
    payloads: claimed.payloads,
    destinations,
    dependencies: input.delivery,
  });
  if (result.status === "delivered") {
    await repository.finish(claimed.id, claimed.leaseToken, "delivered", null, null);
    return "delivered";
  }
  if (result.status === "permanent_failure" || claimed.attemptCount >= 5) {
    await repository.finish(
      claimed.id,
      claimed.leaseToken,
      "dead_letter",
      result.errorCode,
      null,
    );
    return "dead_letter";
  }
  const delay = result.retryAfterSeconds === null
    ? Math.min(60 * 60_000, 2 ** claimed.attemptCount * 30_000)
    : result.retryAfterSeconds * 1_000;
  await repository.finish(
    claimed.id,
    claimed.leaseToken,
    "retry_scheduled",
    result.errorCode,
    now() + delay,
  );
  return "retry_scheduled";
}
