CREATE TABLE `kubernetes_clusters` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`cluster_uid` text NOT NULL,
	`name` text NOT NULL,
	`distribution` text,
	`version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_clusters_scope_uid_uq` ON `kubernetes_clusters` (`org_id`,`customer_id`,`cluster_uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_clusters_scope_id_uq` ON `kubernetes_clusters` (`org_id`,`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `kubernetes_clusters_scope_status_idx` ON `kubernetes_clusters` (`org_id`,`customer_id`,`status`,`name`);--> statement-breakpoint
CREATE TABLE `kubernetes_scan_coverage` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`scan_run_id` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`state` text NOT NULL,
	`items_observed` integer NOT NULL,
	`error_code` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_run_id`) REFERENCES `kubernetes_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_scan_coverage_run_kind_uq` ON `kubernetes_scan_coverage` (`scan_run_id`,`evidence_kind`);--> statement-breakpoint
CREATE INDEX `kubernetes_scan_coverage_scope_state_idx` ON `kubernetes_scan_coverage` (`org_id`,`customer_id`,`cluster_id`,`state`,`evidence_kind`);--> statement-breakpoint
CREATE TABLE `kubernetes_scan_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`scan_run_id` text NOT NULL,
	`control_id` text NOT NULL,
	`subject` text NOT NULL,
	`state` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`evidence_json` text NOT NULL,
	`finding_sha256` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_run_id`) REFERENCES `kubernetes_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_scan_findings_run_control_subject_uq` ON `kubernetes_scan_findings` (`scan_run_id`,`control_id`,`subject`);--> statement-breakpoint
CREATE INDEX `kubernetes_scan_findings_scope_state_idx` ON `kubernetes_scan_findings` (`org_id`,`customer_id`,`cluster_id`,`state`,`severity`,`control_id`);--> statement-breakpoint
CREATE TABLE `kubernetes_scan_heads` (
	`cluster_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`scan_run_id` text NOT NULL,
	`collected_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_run_id`) REFERENCES `kubernetes_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `kubernetes_scan_heads_scope_idx` ON `kubernetes_scan_heads` (`org_id`,`customer_id`,`cluster_id`);--> statement-breakpoint
CREATE TABLE `kubernetes_scan_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`scan_run_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`kind` text NOT NULL,
	`namespace` text,
	`name` text NOT NULL,
	`evidence_json` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_run_id`) REFERENCES `kubernetes_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_scan_resources_run_key_uq` ON `kubernetes_scan_resources` (`scan_run_id`,`resource_key`);--> statement-breakpoint
CREATE INDEX `kubernetes_scan_resources_scope_kind_idx` ON `kubernetes_scan_resources` (`org_id`,`customer_id`,`cluster_id`,`kind`,`namespace`,`name`);--> statement-breakpoint
CREATE TABLE `kubernetes_scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`status` text NOT NULL,
	`collected_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`posture_sha256` text NOT NULL,
	`resource_count` integer NOT NULL,
	`finding_count` integer NOT NULL,
	`coverage_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_scan_runs_scope_idempotency_uq` ON `kubernetes_scan_runs` (`org_id`,`cluster_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_scan_runs_scope_id_uq` ON `kubernetes_scan_runs` (`org_id`,`customer_id`,`cluster_id`,`id`);--> statement-breakpoint
CREATE INDEX `kubernetes_scan_runs_scope_time_idx` ON `kubernetes_scan_runs` (`org_id`,`customer_id`,`cluster_id`,`collected_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_runs_no_update` BEFORE UPDATE ON `kubernetes_scan_runs`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan runs are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_runs_no_delete` BEFORE DELETE ON `kubernetes_scan_runs`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan runs are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_resources_no_update` BEFORE UPDATE ON `kubernetes_scan_resources`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan resources are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_resources_no_delete` BEFORE DELETE ON `kubernetes_scan_resources`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan resources are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_findings_no_update` BEFORE UPDATE ON `kubernetes_scan_findings`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan findings are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_findings_no_delete` BEFORE DELETE ON `kubernetes_scan_findings`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan findings are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_coverage_no_update` BEFORE UPDATE ON `kubernetes_scan_coverage`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan coverage is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_coverage_no_delete` BEFORE DELETE ON `kubernetes_scan_coverage`
BEGIN SELECT RAISE(ABORT, 'kubernetes scan coverage is immutable'); END;
