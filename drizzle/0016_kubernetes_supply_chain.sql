CREATE TABLE `kubernetes_supply_chain_evidence` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `image_repository` text NOT NULL,
  `image_digest` text NOT NULL,
  `collected_at` integer NOT NULL,
  `priority_score` integer NOT NULL,
  `priority_rating` text NOT NULL,
  `evidence_json` text NOT NULL,
  `evidence_sha256` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_supply_chain_cluster_evidence_uq`
  ON `kubernetes_supply_chain_evidence` (`cluster_id`, `evidence_sha256`);
--> statement-breakpoint
CREATE INDEX `kubernetes_supply_chain_scope_time_idx`
  ON `kubernetes_supply_chain_evidence` (`org_id`, `customer_id`, `cluster_id`, `collected_at`, `id`);
--> statement-breakpoint
CREATE INDEX `kubernetes_supply_chain_digest_idx`
  ON `kubernetes_supply_chain_evidence` (`org_id`, `customer_id`, `image_digest`);
--> statement-breakpoint
CREATE TRIGGER `kubernetes_supply_chain_no_update`
BEFORE UPDATE ON `kubernetes_supply_chain_evidence`
BEGIN SELECT RAISE(ABORT, 'kubernetes supply-chain evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_supply_chain_no_delete`
BEFORE DELETE ON `kubernetes_supply_chain_evidence`
BEGIN SELECT RAISE(ABORT, 'kubernetes supply-chain evidence is immutable'); END;
