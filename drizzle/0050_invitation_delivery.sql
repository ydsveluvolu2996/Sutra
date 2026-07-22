ALTER TABLE `identity_invitations` ADD `delivery_status` text DEFAULT 'not_attempted' NOT NULL CHECK (`delivery_status` IN ('not_attempted', 'sending', 'accepted', 'failed', 'unknown'));--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_transport` text DEFAULT 'none' NOT NULL CHECK (`delivery_transport` IN ('none', 'email-api'));--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_provider` text DEFAULT 'none' NOT NULL CHECK (`delivery_provider` IN ('none', 'resend', 'sendgrid', 'generic'));--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_attempts` integer DEFAULT 0 NOT NULL CHECK (`delivery_attempts` >= 0);--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_last_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_completed_at` integer;--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_error_code` text;--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_http_status` integer;--> statement-breakpoint
ALTER TABLE `identity_invitations` ADD `delivery_idempotency_digest` text;--> statement-breakpoint
CREATE INDEX `identity_invitations_org_delivery_idx`
  ON `identity_invitations` (`org_id`, `delivery_status`, `delivery_last_attempted_at`);--> statement-breakpoint
