CREATE TABLE `gcp_billing_connections` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `provider` text NOT NULL CHECK (`provider`='GCP'),
  `billing_account_id` text NOT NULL,
  `export_project_id` text NOT NULL,
  `dataset_id` text NOT NULL,
  `billing_table_id` text NOT NULL,
  `pricing_project_id` text NOT NULL,
  `pricing_dataset_id` text NOT NULL,
  `pricing_table_id` text NOT NULL,
  `location` text NOT NULL,
  `identity_binding_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('pending','active','disabled')),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`id`,`billing_account_id`),
  CHECK (length(`id`)=40 AND substr(`id`,1,8)='gcpconn_' AND substr(`id`,9) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`billing_account_id`)=20),
  CHECK (length(`identity_binding_id`)=71 AND substr(`identity_binding_id`,1,7)='gcpwif_' AND substr(`identity_binding_id`,8) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`export_project_id`) BETWEEN 6 AND 30),
  CHECK (length(`dataset_id`) BETWEEN 1 AND 1024),
  CHECK (length(`billing_table_id`) BETWEEN 1 AND 1024),
  CHECK (length(`pricing_project_id`) BETWEEN 6 AND 30),
  CHECK (length(`pricing_dataset_id`) BETWEEN 1 AND 1024),
  CHECK (length(`pricing_table_id`) BETWEEN 1 AND 1024),
  CHECK (length(`location`) BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE INDEX `gcp_billing_connections_scope_idx` ON `gcp_billing_connections` (`org_id`,`customer_id`,`status`);
--> statement-breakpoint
CREATE TABLE `finops_gcp_billing_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `billing_account_id` text NOT NULL,
  `capture_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN ('CONFIGURATION_REQUIRED','PERMISSION_REQUIRED','WAITING_FIRST_DELIVERY','PARTIAL_PIPELINE','EMPTY','READY')),
  `complete` integer NOT NULL CHECK (`complete` IN (0,1)),
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `completed_at` text NOT NULL,
  `data_through_at` text,
  `billing_row_count` integer NOT NULL CHECK (`billing_row_count` BETWEEN 0 AND 1000000),
  `opportunity_row_count` integer NOT NULL CHECK (`opportunity_row_count` BETWEEN 0 AND 100000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`,`customer_id`,`connection_id`,`billing_account_id`) REFERENCES `gcp_billing_connections`(`org_id`,`customer_id`,`id`,`billing_account_id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`capture_id`),
  CHECK (length(`generation_id`)=69 AND substr(`generation_id`,1,5)='gcpg_' AND substr(`generation_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`capture_id`)=75 AND substr(`capture_id`,1,11)='gcpbilling_' AND substr(`capture_id`,12) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 268435456),
  CHECK (length(`completed_at`)=24),
  CHECK (`data_through_at` IS NULL OR length(`data_through_at`)=24),
  CHECK (`complete`=0 OR `source_state` IN ('READY','EMPTY'))
);
--> statement-breakpoint
CREATE INDEX `finops_gcp_billing_history_idx` ON `finops_gcp_billing_snapshots` (`org_id`,`customer_id`,`connection_id`,`completed_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_gcp_billing_snapshot_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL UNIQUE,
  `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_gcp_billing_snapshots`(`generation_id`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_gcp_billing_snapshots_update_guard` BEFORE UPDATE ON `finops_gcp_billing_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_GCP_BILLING_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_gcp_billing_snapshots_delete_guard` BEFORE DELETE ON `finops_gcp_billing_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_GCP_BILLING_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_gcp_billing_heads_insert_guard` BEFORE INSERT ON `finops_gcp_billing_snapshot_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_gcp_billing_snapshots` candidate WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=NEW.`org_id` AND candidate.`customer_id`=NEW.`customer_id` AND candidate.`connection_id`=NEW.`connection_id` AND candidate.`complete`=1 AND candidate.`source_state` IN ('READY','EMPTY'))
BEGIN SELECT RAISE(ABORT,'FINOPS_GCP_BILLING_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_gcp_billing_heads_update_guard` BEFORE UPDATE ON `finops_gcp_billing_snapshot_heads`
WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id` OR NOT EXISTS (
  SELECT 1 FROM `finops_gcp_billing_snapshots` candidate JOIN `finops_gcp_billing_snapshots` active ON active.`generation_id`=OLD.`active_generation_id`
  WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id` AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id`
    AND candidate.`complete`=1 AND candidate.`source_state` IN ('READY','EMPTY')
    AND (candidate.`completed_at`>active.`completed_at` OR (candidate.`completed_at`=active.`completed_at` AND candidate.`generation_id`>active.`generation_id`))
) BEGIN SELECT RAISE(ABORT,'FINOPS_GCP_BILLING_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_gcp_billing_heads_delete_guard` BEFORE DELETE ON `finops_gcp_billing_snapshot_heads` BEGIN SELECT RAISE(ABORT,'FINOPS_GCP_BILLING_SNAPSHOT_IMMUTABLE'); END;
