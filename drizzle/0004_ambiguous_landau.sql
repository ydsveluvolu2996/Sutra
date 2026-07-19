CREATE TABLE `local_job_publications` (
	`job_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`sync_run_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`fixture_id` text NOT NULL,
	`fixture_version` text NOT NULL,
	`actor_id` text NOT NULL,
	`published_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_job_publications_sync_uq` ON `local_job_publications` (`org_id`,`sync_run_id`);--> statement-breakpoint
CREATE INDEX `local_job_publications_scope_time_idx` ON `local_job_publications` (`org_id`,`customer_id`,`published_at`,`job_id`);--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `source_kind` text DEFAULT 'aws_trust_role' NOT NULL;--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `fixture_id` text;--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `fixture_version` text;--> statement-breakpoint
ALTER TABLE `cmdb_snapshots` ADD `origin_kind` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `cmdb_snapshots` ADD `fixture_id` text;--> statement-breakpoint
ALTER TABLE `cmdb_snapshots` ADD `fixture_version` text;