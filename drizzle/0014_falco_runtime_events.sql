CREATE TABLE `falco_ingestion_nonces` (
  `cluster_id` text NOT NULL,
  `key_id` text NOT NULL,
  `nonce_sha256` text NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY (`cluster_id`, `key_id`, `nonce_sha256`),
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `falco_ingestion_nonces_expiry_idx` ON `falco_ingestion_nonces` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `falco_runtime_events` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `occurred_at` integer NOT NULL,
  `rule_name` text NOT NULL,
  `priority` text NOT NULL,
  `source` text NOT NULL,
  `node_name` text,
  `namespace_name` text,
  `pod_name` text,
  `pod_uid` text,
  `container_id` text,
  `container_name` text,
  `container_image` text,
  `process_name` text,
  `process_executable` text,
  `process_id` integer,
  `parent_process_id` integer,
  `user_name` text,
  `user_id` text,
  `event_type` text,
  `evidence_json` text NOT NULL,
  `evidence_sha256` text NOT NULL,
  `ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `falco_runtime_events_cluster_evidence_uq` ON `falco_runtime_events` (`cluster_id`, `evidence_sha256`);
--> statement-breakpoint
CREATE INDEX `falco_runtime_events_scope_time_idx` ON `falco_runtime_events` (`org_id`, `customer_id`, `cluster_id`, `occurred_at`, `id`);
--> statement-breakpoint
CREATE TABLE `falco_runtime_sources` (
  `cluster_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `last_heartbeat_at` integer,
  `last_event_at` integer,
  `falco_version` text,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `falco_runtime_sources_scope_idx` ON `falco_runtime_sources` (`org_id`, `customer_id`, `cluster_id`);
--> statement-breakpoint
CREATE TRIGGER `falco_runtime_events_no_update` BEFORE UPDATE ON `falco_runtime_events`
BEGIN SELECT RAISE(ABORT, 'falco runtime evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `falco_runtime_events_no_delete` BEFORE DELETE ON `falco_runtime_events`
BEGIN SELECT RAISE(ABORT, 'falco runtime evidence is immutable'); END;
