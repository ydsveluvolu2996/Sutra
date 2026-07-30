-- SQLite cannot widen an existing CHECK constraint in place. Preserve the
-- invitation, delivery-operation, and immutable event rows while rebuilding
-- their three related tables with Zoho as an explicit delivery provider.
CREATE TABLE `sutra_0066_identity_invitation_events_backup` AS
  SELECT * FROM `identity_invitation_events`;--> statement-breakpoint
CREATE TABLE `sutra_0066_identity_invitation_operations_backup` AS
  SELECT * FROM `identity_invitation_operations`;--> statement-breakpoint
CREATE TABLE `sutra_0066_identity_invitations_backup` AS
  SELECT * FROM `identity_invitations`;--> statement-breakpoint
DROP TABLE `identity_invitation_events`;--> statement-breakpoint
DROP TABLE `identity_invitation_operations`;--> statement-breakpoint
DROP TABLE `identity_invitations`;--> statement-breakpoint
CREATE TABLE `identity_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`scope_mode` text DEFAULT 'assigned_customers' NOT NULL,
	`token_digest` text NOT NULL,
	`invited_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_user_id` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`customer_id` text,
	`delivery_status` text DEFAULT 'not_attempted' NOT NULL CHECK (`delivery_status` IN ('not_attempted', 'sending', 'accepted', 'failed', 'unknown')),
	`delivery_transport` text DEFAULT 'none' NOT NULL CHECK (`delivery_transport` IN ('none', 'email-api')),
	`delivery_provider` text DEFAULT 'none' NOT NULL CHECK (`delivery_provider` IN ('none', 'zoho', 'resend', 'sendgrid', 'generic')),
	`delivery_attempts` integer DEFAULT 0 NOT NULL CHECK (`delivery_attempts` >= 0),
	`delivery_last_attempted_at` integer,
	`delivery_completed_at` integer,
	`delivery_error_code` text,
	`delivery_http_status` integer,
	`delivery_idempotency_digest` text,
	`delivery_revision` integer DEFAULT 0 NOT NULL CHECK (`delivery_revision` >= 0),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `identity_invitations` (
	`id`, `org_id`, `email`, `role`, `scope_mode`, `token_digest`, `invited_by`,
	`expires_at`, `accepted_at`, `accepted_user_id`, `revoked_at`, `created_at`,
	`customer_id`, `delivery_status`, `delivery_transport`, `delivery_provider`,
	`delivery_attempts`, `delivery_last_attempted_at`, `delivery_completed_at`,
	`delivery_error_code`, `delivery_http_status`, `delivery_idempotency_digest`,
	`delivery_revision`
)
SELECT
	`id`, `org_id`, `email`, `role`, `scope_mode`, `token_digest`, `invited_by`,
	`expires_at`, `accepted_at`, `accepted_user_id`, `revoked_at`, `created_at`,
	`customer_id`, `delivery_status`, `delivery_transport`, `delivery_provider`,
	`delivery_attempts`, `delivery_last_attempted_at`, `delivery_completed_at`,
	`delivery_error_code`, `delivery_http_status`, `delivery_idempotency_digest`,
	`delivery_revision`
FROM `sutra_0066_identity_invitations_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitations_token_uq`
	ON `identity_invitations` (`token_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitations_active_email_uq`
	ON `identity_invitations` (`org_id`, `email`)
	WHERE `accepted_at` IS NULL AND `revoked_at` IS NULL;--> statement-breakpoint
CREATE INDEX `identity_invitations_org_expiry_idx`
	ON `identity_invitations` (`org_id`, `expires_at`, `revoked_at`);--> statement-breakpoint
CREATE INDEX `identity_invitations_org_delivery_idx`
	ON `identity_invitations` (`org_id`, `delivery_status`, `delivery_last_attempted_at`);--> statement-breakpoint
CREATE TABLE `identity_invitation_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`operation_kind` text NOT NULL CHECK (`operation_kind` IN ('creation', 'initial_delivery', 'resend')),
	`idempotency_scope_id` text NOT NULL,
	`invitation_id` text,
	`idempotency_digest` text NOT NULL CHECK (length(`idempotency_digest`) = 64),
	`request_fingerprint` text NOT NULL CHECK (length(`request_fingerprint`) = 64),
	`operation_status` text DEFAULT 'claimed' NOT NULL CHECK (`operation_status` IN ('claimed', 'completed')),
	`outcome_status` text CHECK (`outcome_status` IN ('accepted', 'failed', 'unknown')),
	`delivery_transport` text DEFAULT 'none' NOT NULL CHECK (`delivery_transport` IN ('none', 'email-api')),
	`delivery_provider` text DEFAULT 'none' NOT NULL CHECK (`delivery_provider` IN ('none', 'zoho', 'resend', 'sendgrid', 'generic')),
	`delivery_error_code` text,
	`delivery_http_status` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invitation_id`) REFERENCES `identity_invitations`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `identity_invitation_operations` (
	`id`, `org_id`, `operation_kind`, `idempotency_scope_id`, `invitation_id`,
	`idempotency_digest`, `request_fingerprint`, `operation_status`,
	`outcome_status`, `delivery_transport`, `delivery_provider`,
	`delivery_error_code`, `delivery_http_status`, `created_at`, `completed_at`
)
SELECT
	`id`, `org_id`, `operation_kind`, `idempotency_scope_id`, `invitation_id`,
	`idempotency_digest`, `request_fingerprint`, `operation_status`,
	`outcome_status`, `delivery_transport`, `delivery_provider`,
	`delivery_error_code`, `delivery_http_status`, `created_at`, `completed_at`
FROM `sutra_0066_identity_invitation_operations_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_operations_scope_key_uq`
	ON `identity_invitation_operations` (`org_id`, `operation_kind`, `idempotency_scope_id`, `idempotency_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_operations_invitation_key_uq`
	ON `identity_invitation_operations` (`org_id`, `invitation_id`, `idempotency_digest`)
	WHERE `invitation_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `identity_invitation_operations_invitation_time_idx`
	ON `identity_invitation_operations` (`org_id`, `invitation_id`, `created_at`, `id`);--> statement-breakpoint
CREATE TABLE `identity_invitation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`invitation_id` text NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`previous_event_hash` text,
	`event_hash` text NOT NULL,
	FOREIGN KEY (`invitation_id`) REFERENCES `identity_invitations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `identity_invitation_events` (
	`id`, `invitation_id`, `org_id`, `actor_id`, `action`, `occurred_at`,
	`metadata_json`, `previous_event_hash`, `event_hash`
)
SELECT
	`id`, `invitation_id`, `org_id`, `actor_id`, `action`, `occurred_at`,
	`metadata_json`, `previous_event_hash`, `event_hash`
FROM `sutra_0066_identity_invitation_events_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_events_hash_uq`
	ON `identity_invitation_events` (`invitation_id`, `event_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_events_previous_hash_uq`
	ON `identity_invitation_events` (`invitation_id`, `previous_event_hash`)
	WHERE `previous_event_hash` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `identity_invitation_events_org_time_idx`
	ON `identity_invitation_events` (`org_id`, `occurred_at`, `id`);--> statement-breakpoint
CREATE TRIGGER `identity_invitation_events_no_update`
BEFORE UPDATE ON `identity_invitation_events`
BEGIN
  SELECT RAISE(ABORT, 'identity invitation activity is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `identity_invitation_events_no_delete`
BEFORE DELETE ON `identity_invitation_events`
BEGIN
  SELECT RAISE(ABORT, 'identity invitation activity is immutable');
END;--> statement-breakpoint
DROP TABLE `sutra_0066_identity_invitation_events_backup`;--> statement-breakpoint
DROP TABLE `sutra_0066_identity_invitation_operations_backup`;--> statement-breakpoint
DROP TABLE `sutra_0066_identity_invitations_backup`;
