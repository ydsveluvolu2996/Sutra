CREATE TABLE `dspm_scan_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `source` text NOT NULL,
  `status` text NOT NULL,
  `coverage_json` text NOT NULL,
  `evidence_sha256` text NOT NULL,
  `asset_count` integer NOT NULL,
  `finding_count` integer NOT NULL,
  `collected_at` integer NOT NULL,
  `imported_by` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dspm_scan_runs_scope_id_uq` ON `dspm_scan_runs` (`org_id`,`customer_id`,`connection_id`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dspm_scan_runs_idempotency_uq` ON `dspm_scan_runs` (`org_id`,`connection_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `dspm_scan_runs_scope_time_idx` ON `dspm_scan_runs` (`org_id`,`customer_id`,`connection_id`,`collected_at`,`id`);
--> statement-breakpoint
CREATE TABLE `dspm_asset_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `scan_run_id` text NOT NULL,
  `resource_key` text NOT NULL,
  `resource_type` text NOT NULL,
  `region_key` text NOT NULL,
  `classification` text NOT NULL,
  `categories_json` text NOT NULL,
  `owner_ref` text,
  `encrypted` integer,
  `public_access` integer,
  `cross_account_access` integer,
  `external_sharing` integer,
  `credentials_detected` integer,
  `data_size_bytes` integer,
  `risk_score` integer NOT NULL,
  `risk_severity` text NOT NULL,
  `risk_title` text,
  `risk_factors_json` text NOT NULL,
  `recommendations_json` text NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`scan_run_id`) REFERENCES `dspm_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dspm_asset_evidence_run_resource_uq` ON `dspm_asset_evidence` (`scan_run_id`,`resource_key`);
--> statement-breakpoint
CREATE INDEX `dspm_asset_evidence_scope_risk_idx` ON `dspm_asset_evidence` (`org_id`,`customer_id`,`connection_id`,`risk_severity`,`risk_score`);
--> statement-breakpoint
CREATE TABLE `dspm_scan_heads` (
  `connection_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `scan_run_id` text NOT NULL,
  `collected_at` integer NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`scan_run_id`) REFERENCES `dspm_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dspm_scan_heads_scope_idx` ON `dspm_scan_heads` (`org_id`,`customer_id`,`connection_id`);
--> statement-breakpoint
CREATE TRIGGER `dspm_scan_runs_no_update` BEFORE UPDATE ON `dspm_scan_runs`
BEGIN SELECT RAISE(ABORT, 'DSPM scan runs are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `dspm_scan_runs_no_delete` BEFORE DELETE ON `dspm_scan_runs`
BEGIN SELECT RAISE(ABORT, 'DSPM scan runs are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `dspm_asset_evidence_no_update` BEFORE UPDATE ON `dspm_asset_evidence`
BEGIN SELECT RAISE(ABORT, 'DSPM asset evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `dspm_asset_evidence_no_delete` BEFORE DELETE ON `dspm_asset_evidence`
BEGIN SELECT RAISE(ABORT, 'DSPM asset evidence is immutable'); END;
