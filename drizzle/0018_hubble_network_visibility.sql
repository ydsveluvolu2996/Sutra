CREATE TABLE `hubble_flow_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `observed_at` integer NOT NULL,
  `source_namespace` text,
  `source_workload_kind` text,
  `source_workload_name` text,
  `source_service_name` text,
  `source_world` integer NOT NULL,
  `destination_namespace` text,
  `destination_workload_kind` text,
  `destination_workload_name` text,
  `destination_service_name` text,
  `destination_world` integer NOT NULL,
  `direction` text NOT NULL,
  `verdict` text NOT NULL,
  `protocol` text NOT NULL,
  `destination_port` integer,
  `observations` integer NOT NULL,
  `evidence_sha256` text NOT NULL,
  `ingested_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`),
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`),
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hubble_flow_cluster_evidence_uq` ON `hubble_flow_evidence` (`cluster_id`, `evidence_sha256`);
--> statement-breakpoint
CREATE INDEX `hubble_flow_scope_time_idx` ON `hubble_flow_evidence` (`org_id`, `customer_id`, `cluster_id`, `observed_at`, `id`);
--> statement-breakpoint
CREATE TABLE `hubble_flow_sources` (
  `cluster_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `hubble_version` text NOT NULL,
  `last_batch_at` integer NOT NULL,
  `last_flow_at` integer,
  `last_batch_sha256` text NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`),
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`),
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`)
);
--> statement-breakpoint
CREATE INDEX `hubble_flow_sources_scope_idx` ON `hubble_flow_sources` (`org_id`, `customer_id`, `cluster_id`);
--> statement-breakpoint
CREATE TRIGGER `hubble_flow_no_update` BEFORE UPDATE ON `hubble_flow_evidence`
BEGIN SELECT RAISE(ABORT, 'Hubble flow evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `hubble_flow_no_delete` BEFORE DELETE ON `hubble_flow_evidence`
BEGIN SELECT RAISE(ABORT, 'Hubble flow evidence is immutable'); END;
