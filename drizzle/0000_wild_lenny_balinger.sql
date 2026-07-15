CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text,
	`occurred_at` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`outcome` text NOT NULL,
	`request_id` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`previous_event_hash` text,
	`event_hash` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_events_org_time_idx` ON `audit_events` (`org_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `aws_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`partition` text DEFAULT 'aws' NOT NULL,
	`aws_account_id` text NOT NULL,
	`role_arn` text NOT NULL,
	`external_id_ciphertext` text NOT NULL,
	`external_id_key_version` text NOT NULL,
	`permission_pack_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`enabled_regions_json` text DEFAULT '[]' NOT NULL,
	`last_validated_at` integer,
	`last_successful_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aws_connections_customer_account_uq` ON `aws_connections` (`org_id`,`customer_id`,`partition`,`aws_account_id`);--> statement-breakpoint
CREATE INDEX `aws_connections_scope_status_idx` ON `aws_connections` (`org_id`,`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `control_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`control_key` text NOT NULL,
	`version` text NOT NULL,
	`title` text NOT NULL,
	`default_severity` text NOT NULL,
	`rule_ast_json` text NOT NULL,
	`remediation_json` text NOT NULL,
	`released_at` integer NOT NULL,
	`retired_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_versions_key_version_uq` ON `control_versions` (`control_key`,`version`);--> statement-breakpoint
CREATE TABLE `customer_access` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_access_scope_uq` ON `customer_access` (`org_id`,`customer_id`,`membership_id`);--> statement-breakpoint
CREATE INDEX `customer_access_member_idx` ON `customer_access` (`org_id`,`membership_id`,`customer_id`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_org_slug_uq` ON `customers` (`org_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `customers_org_id_uq` ON `customers` (`org_id`,`id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`resource_id` text,
	`control_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`confidence` text DEFAULT 'high' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`current_evidence_json` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_org_fingerprint_uq` ON `findings` (`org_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `findings_scope_status_severity_idx` ON `findings` (`org_id`,`customer_id`,`status`,`severity`,`last_seen_at`,`id`);--> statement-breakpoint
CREATE INDEX `findings_scope_resource_status_idx` ON `findings` (`org_id`,`customer_id`,`resource_id`,`status`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`scope_mode` text DEFAULT 'assigned_customers' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_org_user_uq` ON `memberships` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_org_user_status_idx` ON `memberships` (`org_id`,`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_uq` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provider_key` text NOT NULL,
	`aws_account_id` text NOT NULL,
	`region_key` text NOT NULL,
	`resource_type` text NOT NULL,
	`native_id` text NOT NULL,
	`arn` text,
	`name` text,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`configuration_json` text DEFAULT '{}' NOT NULL,
	`content_sha256` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`seen_in_run_id` text,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seen_in_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_provider_identity_uq` ON `resources` (`org_id`,`connection_id`,`resource_type`,`region_key`,`native_id`);--> statement-breakpoint
CREATE INDEX `resources_scope_type_state_idx` ON `resources` (`org_id`,`customer_id`,`lifecycle_state`,`resource_type`,`id`);--> statement-breakpoint
CREATE INDEX `resources_scope_account_region_idx` ON `resources` (`org_id`,`customer_id`,`aws_account_id`,`region_key`,`id`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`status` text NOT NULL,
	`coverage_state` text DEFAULT 'unknown' NOT NULL,
	`collector_pack_version` text NOT NULL,
	`totals_json` text DEFAULT '{}' NOT NULL,
	`idempotency_key` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_runs_connection_idempotency_uq` ON `sync_runs` (`org_id`,`connection_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `sync_runs_scope_started_idx` ON `sync_runs` (`org_id`,`customer_id`,`connection_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_issuer_subject_uq` ON `users` (`issuer`,`subject`);