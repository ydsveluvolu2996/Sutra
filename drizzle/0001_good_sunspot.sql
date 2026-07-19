CREATE TABLE `cmdb_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`resource_key` text,
	`control_key` text NOT NULL,
	`control_version` text NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`remediation` text NOT NULL,
	`evidence_json` text NOT NULL,
	`evaluated_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cmdb_findings_snapshot_fingerprint_uq` ON `cmdb_findings` (`snapshot_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `cmdb_findings_scope_severity_idx` ON `cmdb_findings` (`org_id`,`customer_id`,`connection_id`,`status`,`severity`);--> statement-breakpoint
CREATE TABLE `cmdb_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`from_resource_key` text NOT NULL,
	`to_resource_key` text NOT NULL,
	`relation_type` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cmdb_relationships_snapshot_edge_uq` ON `cmdb_relationships` (`snapshot_id`,`from_resource_key`,`to_resource_key`,`relation_type`);--> statement-breakpoint
CREATE INDEX `cmdb_relationships_scope_from_idx` ON `cmdb_relationships` (`org_id`,`customer_id`,`connection_id`,`from_resource_key`);--> statement-breakpoint
CREATE TABLE `cmdb_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`provider_key` text DEFAULT 'aws' NOT NULL,
	`service` text NOT NULL,
	`resource_type` text NOT NULL,
	`native_id` text NOT NULL,
	`arn` text,
	`name` text,
	`region_key` text NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`tags_json` text DEFAULT '{}' NOT NULL,
	`configuration_json` text DEFAULT '{}' NOT NULL,
	`source_json` text DEFAULT '{}' NOT NULL,
	`content_sha256` text NOT NULL,
	`collected_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cmdb_resources_snapshot_key_uq` ON `cmdb_resources` (`snapshot_id`,`resource_key`);--> statement-breakpoint
CREATE INDEX `cmdb_resources_scope_type_idx` ON `cmdb_resources` (`org_id`,`customer_id`,`connection_id`,`resource_type`,`region_key`);--> statement-breakpoint
CREATE TABLE `cmdb_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`sync_run_id` text NOT NULL,
	`status` text DEFAULT 'staging' NOT NULL,
	`collected_at` integer NOT NULL,
	`completed_at` integer,
	`coverage_json` text DEFAULT '{}' NOT NULL,
	`summary_json` text DEFAULT '{}' NOT NULL,
	`snapshot_sha256` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cmdb_snapshots_sync_run_uq` ON `cmdb_snapshots` (`sync_run_id`);--> statement-breakpoint
CREATE INDEX `cmdb_snapshots_connection_time_idx` ON `cmdb_snapshots` (`org_id`,`connection_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `collector_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`sync_run_id` text NOT NULL,
	`collector_key` text NOT NULL,
	`region_key` text NOT NULL,
	`status` text NOT NULL,
	`items_observed` integer DEFAULT 0 NOT NULL,
	`pages_observed` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collector_runs_sync_collector_region_uq` ON `collector_runs` (`sync_run_id`,`collector_key`,`region_key`);--> statement-breakpoint
CREATE INDEX `collector_runs_scope_sync_idx` ON `collector_runs` (`org_id`,`customer_id`,`connection_id`,`sync_run_id`);--> statement-breakpoint
CREATE TABLE `connection_heads` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snapshot_id`) REFERENCES `cmdb_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connection_heads_scope_idx` ON `connection_heads` (`org_id`,`customer_id`,`connection_id`);--> statement-breakpoint
CREATE TABLE `finding_workflow_states` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`actor_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_workflow_scope_fingerprint_uq` ON `finding_workflow_states` (`org_id`,`connection_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `finding_workflow_scope_status_idx` ON `finding_workflow_states` (`org_id`,`customer_id`,`connection_id`,`status`);