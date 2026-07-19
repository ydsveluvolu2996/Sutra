CREATE TABLE `local_schedule_mutation_outbox` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`customer_id` text,
	`schedule_id` text NOT NULL,
	`fixture_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`operation_kind` text NOT NULL,
	`command_json` text NOT NULL,
	`command_sha256` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	`failure_code` text,
	`failed_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `local_schedule_mutation_outbox_pending_idx` ON `local_schedule_mutation_outbox` (`org_id`,`status`,`created_at`,`operation_id`);--> statement-breakpoint
CREATE INDEX `local_schedule_mutation_outbox_scope_idx` ON `local_schedule_mutation_outbox` (`org_id`,`customer_id`,`schedule_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_org_request_id_uq` ON `audit_events` (`org_id`,`request_id`);
