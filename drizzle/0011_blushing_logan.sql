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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitation_events_hash_uq` ON `identity_invitation_events` (`invitation_id`,`event_hash`);--> statement-breakpoint
CREATE INDEX `identity_invitation_events_org_time_idx` ON `identity_invitation_events` (`org_id`,`occurred_at`,`id`);--> statement-breakpoint
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
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitations_token_uq` ON `identity_invitations` (`token_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `identity_invitations_active_email_uq` ON `identity_invitations` (`org_id`,`email`) WHERE "identity_invitations"."accepted_at" IS NULL AND "identity_invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `identity_invitations_org_expiry_idx` ON `identity_invitations` (`org_id`,`expires_at`,`revoked_at`);
--> statement-breakpoint
CREATE TRIGGER `identity_invitation_events_no_update`
BEFORE UPDATE ON `identity_invitation_events`
BEGIN
  SELECT RAISE(ABORT, 'identity invitation activity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `identity_invitation_events_no_delete`
BEFORE DELETE ON `identity_invitation_events`
BEGIN
  SELECT RAISE(ABORT, 'identity invitation activity is immutable');
END;
