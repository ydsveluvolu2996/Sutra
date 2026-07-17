CREATE TABLE `kubernetes_agent_bootstraps` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `token_digest` text NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer,
  `consumed_agent_id` text,
  `created_by` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_agent_bootstraps_digest_uq` ON `kubernetes_agent_bootstraps` (`token_digest`);
--> statement-breakpoint
CREATE INDEX `kubernetes_agent_bootstraps_scope_expiry_idx` ON `kubernetes_agent_bootstraps` (`org_id`,`customer_id`,`connection_id`,`cluster_id`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `kubernetes_agents` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `current_token_digest` text NOT NULL,
  `previous_token_digest` text,
  `previous_token_expires_at` integer,
  `credential_expires_at` integer NOT NULL,
  `agent_version` text NOT NULL,
  `capabilities_json` text NOT NULL,
  `deployment_namespace` text,
  `deployment_pod_name` text,
  `deployment_started_at` integer,
  `module_health_json` text DEFAULT '{}' NOT NULL,
  `last_heartbeat_at` integer,
  `last_scan_at` integer,
  `enrolled_at` integer NOT NULL,
  `rotated_at` integer,
  `revoked_at` integer,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_agents_current_digest_uq` ON `kubernetes_agents` (`current_token_digest`);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_agents_previous_digest_uq` ON `kubernetes_agents` (`previous_token_digest`) WHERE `previous_token_digest` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_agents_active_cluster_uq` ON `kubernetes_agents` (`org_id`,`customer_id`,`cluster_id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE INDEX `kubernetes_agents_scope_health_idx` ON `kubernetes_agents` (`org_id`,`customer_id`,`connection_id`,`cluster_id`,`status`,`last_heartbeat_at`);
--> statement-breakpoint
CREATE TABLE `kubernetes_agent_scan_receipts` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_id` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `payload_sha256` text NOT NULL,
  `scan_run_id` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`agent_id`) REFERENCES `kubernetes_agents`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`scan_run_id`) REFERENCES `kubernetes_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_agent_scan_receipts_idempotency_uq` ON `kubernetes_agent_scan_receipts` (`agent_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `kubernetes_agent_scan_receipts_scope_time_idx` ON `kubernetes_agent_scan_receipts` (`org_id`,`customer_id`,`connection_id`,`cluster_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `kubernetes_agent_scan_receipts_no_update` BEFORE UPDATE ON `kubernetes_agent_scan_receipts`
BEGIN SELECT RAISE(ABORT, 'kubernetes agent scan receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_agent_scan_receipts_no_delete` BEFORE DELETE ON `kubernetes_agent_scan_receipts`
BEGIN SELECT RAISE(ABORT, 'kubernetes agent scan receipts are immutable'); END;
