ALTER TABLE `identity_invitations` ADD `delivery_revision` integer DEFAULT 0 NOT NULL CHECK (`delivery_revision` >= 0);--> statement-breakpoint
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
	`delivery_provider` text DEFAULT 'none' NOT NULL CHECK (`delivery_provider` IN ('none', 'resend', 'sendgrid', 'generic')),
	`delivery_error_code` text,
	`delivery_http_status` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invitation_id`) REFERENCES `identity_invitations`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_operations_scope_key_uq`
	ON `identity_invitation_operations` (`org_id`, `operation_kind`, `idempotency_scope_id`, `idempotency_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_operations_invitation_key_uq`
	ON `identity_invitation_operations` (`org_id`, `invitation_id`, `idempotency_digest`)
	WHERE `invitation_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `identity_invitation_operations_invitation_time_idx`
	ON `identity_invitation_operations` (`org_id`, `invitation_id`, `created_at`, `id`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_events_previous_hash_uq`
	ON `identity_invitation_events` (`invitation_id`, `previous_event_hash`)
	WHERE `previous_event_hash` IS NOT NULL;
