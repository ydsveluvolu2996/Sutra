CREATE TABLE `compliance_exception_events` (
	`id` text PRIMARY KEY NOT NULL,
	`exception_id` text NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`note` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`exception_id`) REFERENCES `compliance_exceptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `compliance_exception_events_scope_time_idx` ON `compliance_exception_events` (`org_id`,`exception_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `compliance_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`control_key` text NOT NULL,
	`finding_fingerprint` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`owner_user_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`reviewed_by` text,
	`rationale` text NOT NULL,
	`compensating_control` text NOT NULL,
	`review_note` text,
	`expires_at` integer NOT NULL,
	`requested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reviewed_at` integer,
	`revoked_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_exceptions_active_finding_uq` ON `compliance_exceptions` (`org_id`,`connection_id`,`finding_fingerprint`) WHERE "compliance_exceptions"."status" IN ('pending', 'approved');--> statement-breakpoint
CREATE INDEX `compliance_exceptions_scope_status_idx` ON `compliance_exceptions` (`org_id`,`customer_id`,`connection_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `finding_case_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`detail_json` text NOT NULL,
	`previous_event_hash` text,
	`event_hash` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `finding_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_case_activity_hash_uq` ON `finding_case_activities` (`case_id`,`event_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `finding_case_activity_chain_uq` ON `finding_case_activities` (`case_id`,`previous_event_hash`);--> statement-breakpoint
CREATE INDEX `finding_case_activity_timeline_idx` ON `finding_case_activities` (`org_id`,`customer_id`,`case_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `finding_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`case_number` text NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`finding_fingerprint` text NOT NULL,
	`finding_snapshot_id` text NOT NULL,
	`finding_severity` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text NOT NULL,
	`assignee_membership_id` text,
	`due_at` integer NOT NULL,
	`resolved_at` integer,
	`closed_at` integer,
	`created_by_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finding_snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_cases_org_number_uq` ON `finding_cases` (`org_id`,`case_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `finding_cases_active_fingerprint_uq` ON `finding_cases` (`org_id`,`connection_id`,`finding_fingerprint`) WHERE "finding_cases"."status" != 'closed';--> statement-breakpoint
CREATE INDEX `finding_cases_scope_status_idx` ON `finding_cases` (`org_id`,`customer_id`,`connection_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `security_event_detections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`rule_version` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`first_event_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	`event_ids_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`limitation` text NOT NULL,
	`note` text,
	`actor_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_run_id`) REFERENCES `security_event_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_event_detections_scope_id_uq` ON `security_event_detections` (`org_id`,`connection_id`,`id`);--> statement-breakpoint
CREATE INDEX `security_event_detections_scope_status_idx` ON `security_event_detections` (`org_id`,`customer_id`,`connection_id`,`status`,`severity`,`last_event_at`,`id`);--> statement-breakpoint
CREATE TABLE `security_event_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`source` text DEFAULT 'aws_cloudtrail_lookup_events' NOT NULL,
	`status` text NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`collected_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`coverage_json` text NOT NULL,
	`events_observed` integer DEFAULT 0 NOT NULL,
	`events_inserted` integer DEFAULT 0 NOT NULL,
	`duplicate_events` integer DEFAULT 0 NOT NULL,
	`detections_observed` integer DEFAULT 0 NOT NULL,
	`payload_sha256` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_event_runs_scope_hash_uq` ON `security_event_runs` (`org_id`,`connection_id`,`payload_sha256`);--> statement-breakpoint
CREATE INDEX `security_event_runs_scope_time_idx` ON `security_event_runs` (`org_id`,`customer_id`,`connection_id`,`collected_at`,`id`);--> statement-breakpoint
CREATE TABLE `security_event_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`source` text DEFAULT 'aws_cloudtrail_lookup_events' NOT NULL,
	`status` text DEFAULT 'NOT_COLLECTED' NOT NULL,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`lookback_hours` integer DEFAULT 1 NOT NULL,
	`overlap_minutes` integer DEFAULT 5 NOT NULL,
	`last_window_start` integer,
	`last_window_end` integer,
	`last_collected_at` integer,
	`last_run_id` text,
	`last_error_code` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_event_sources_scope_uq` ON `security_event_sources` (`org_id`,`customer_id`,`connection_id`);--> statement-breakpoint
CREATE TABLE `security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`source_run_id` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`account_id` text NOT NULL,
	`region_key` text NOT NULL,
	`event_time` integer NOT NULL,
	`event_name` text NOT NULL,
	`event_source` text NOT NULL,
	`read_only` integer,
	`management_event` integer,
	`event_category` text,
	`username` text,
	`identity_type` text,
	`principal_arn` text,
	`source_ip` text,
	`user_agent` text,
	`error_code` text,
	`request_id` text,
	`console_login_result` text,
	`mfa_used` integer,
	`detail_status` text NOT NULL,
	`resources_json` text DEFAULT '[]' NOT NULL,
	`ingested_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_run_id`) REFERENCES `security_event_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_events_provider_identity_uq` ON `security_events` (`org_id`,`connection_id`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `security_events_scope_time_idx` ON `security_events` (`org_id`,`customer_id`,`connection_id`,`event_time`,`id`);--> statement-breakpoint
CREATE INDEX `security_events_scope_name_idx` ON `security_events` (`org_id`,`customer_id`,`connection_id`,`event_name`,`region_key`,`event_time`);
--> statement-breakpoint
CREATE TRIGGER `finding_case_activities_no_update` BEFORE UPDATE ON `finding_case_activities` BEGIN SELECT RAISE(ABORT, 'case activity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `finding_case_activities_no_delete` BEFORE DELETE ON `finding_case_activities` BEGIN SELECT RAISE(ABORT, 'case activity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `compliance_exception_events_no_update` BEFORE UPDATE ON `compliance_exception_events` BEGIN SELECT RAISE(ABORT, 'compliance exception activity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `compliance_exception_events_no_delete` BEFORE DELETE ON `compliance_exception_events` BEGIN SELECT RAISE(ABORT, 'compliance exception activity is immutable'); END;
