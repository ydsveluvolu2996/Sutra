CREATE TABLE `local_password_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`algorithm` text NOT NULL,
	`iterations` integer NOT NULL,
	`salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`changed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `local_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_digest` text NOT NULL,
	`user_id` text NOT NULL,
	`selected_org_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`mfa_verified_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`selected_org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_sessions_token_digest_uq` ON `local_sessions` (`token_digest`);--> statement-breakpoint
CREATE INDEX `local_sessions_user_expiry_idx` ON `local_sessions` (`user_id`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `totp_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_key_version` text NOT NULL,
	`confirmed_at` integer,
	`last_used_step` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_issuer_email_uq` ON `users` (`issuer`,`email`);