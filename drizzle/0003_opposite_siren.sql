CREATE TABLE `cmdb_change_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`from_snapshot_id` text,
	`to_snapshot_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`change_type` text NOT NULL,
	`changed_paths_json` text DEFAULT '[]' NOT NULL,
	`before_json` text,
	`after_json` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cmdb_change_events_snapshot_resource_uq` ON `cmdb_change_events` (`to_snapshot_id`,`resource_key`);--> statement-breakpoint
CREATE INDEX `cmdb_change_events_scope_time_idx` ON `cmdb_change_events` (`org_id`,`customer_id`,`connection_id`,`occurred_at`,`id`);