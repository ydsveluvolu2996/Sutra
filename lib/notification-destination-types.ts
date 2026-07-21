import type { SecurityNotificationChannel } from "./security-notifications.ts";

export interface EmailNotificationDestinationConfig {
  readonly channel: "email";
  readonly recipients: readonly string[];
  readonly fromAddress: string;
  readonly sesRegion: string;
}

export interface WebhookNotificationDestinationConfig {
  // Every non-email channel is configured the same way: a managed-secret
  // reference. Webhook channels store an Incoming-Webhook URL secret; PagerDuty
  // stores an Events API v2 routing key secret. Neither the raw URL nor the
  // routing key is ever persisted in the destination row.
  readonly channel: "slack" | "microsoft_teams" | "generic_webhook" | "pagerduty";
  readonly secretReference: string;
}

export type NotificationDestinationConfig =
  | EmailNotificationDestinationConfig
  | WebhookNotificationDestinationConfig;

export interface NotificationDestination {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly channel: SecurityNotificationChannel;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly configuration: NotificationDestinationConfig;
  readonly deliveryReadiness: "configured" | "adapter_not_configured";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NotificationOutboxStatus =
  | "pending"
  | "processing"
  | "delivered"
  | "retry_scheduled"
  | "dead_letter"
  | "not_configured";

export interface NotificationOutboxJob {
  readonly id: string;
  readonly destinationId: string;
  readonly channel: SecurityNotificationChannel;
  readonly status: NotificationOutboxStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}
