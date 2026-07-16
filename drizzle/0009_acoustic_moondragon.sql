CREATE TABLE `cost_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`source` text DEFAULT 'aws_cost_explorer' NOT NULL,
	`status` text NOT NULL,
	`currency` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`collected_at` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cost_snapshots_connection_hash_uq` ON `cost_snapshots` (`org_id`,`connection_id`,`payload_sha256`);--> statement-breakpoint
CREATE INDEX `cost_snapshots_scope_time_idx` ON `cost_snapshots` (`org_id`,`customer_id`,`connection_id`,`collected_at`,`id`);