CREATE TABLE `security_notification_destinations` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `channel` text NOT NULL,
  `display_name` text NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `secret_reference` text,
  `email_recipients_json` text,
  `email_from_address` text,
  `ses_region` text,
  `created_by` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_notification_destinations_scope_channel_uq`
  ON `security_notification_destinations` (`org_id`, `customer_id`, `channel`);
--> statement-breakpoint
CREATE INDEX `security_notification_destinations_scope_enabled_idx`
  ON `security_notification_destinations` (`org_id`, `customer_id`, `enabled`, `channel`);
--> statement-breakpoint
CREATE TABLE `security_notification_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `destination_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `event_json` text NOT NULL,
  `payload_json` text NOT NULL,
  `payload_sha256` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer NOT NULL,
  `lease_token` text,
  `lease_expires_at` integer,
  `last_error_code` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `delivered_at` integer,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`destination_id`) REFERENCES `security_notification_destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_notification_outbox_scope_idempotency_uq`
  ON `security_notification_outbox` (`org_id`, `customer_id`, `destination_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `security_notification_outbox_due_idx`
  ON `security_notification_outbox` (`status`, `next_attempt_at`, `lease_expires_at`, `created_at`);
--> statement-breakpoint
CREATE INDEX `security_notification_outbox_scope_history_idx`
  ON `security_notification_outbox` (`org_id`, `customer_id`, `created_at`, `id`);
