CREATE TABLE `finops_scad_allocation_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `capture_id` text NOT NULL, `active_billing_generation_id` text NOT NULL,
  `manifest_sha256` text NOT NULL, `source_state` text NOT NULL,
  `complete` integer NOT NULL CHECK (`complete` IN (0,1)), `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL, `billing_period_start_at` text NOT NULL,
  `billing_period_end_at` text NOT NULL, `generated_at` text NOT NULL, `data_through_at` text NOT NULL,
  `row_count` integer NOT NULL CHECK (`row_count` BETWEEN 0 AND 750000),
  `group_count` integer NOT NULL CHECK (`group_count` BETWEEN 0 AND 100000),
  `object_expected` integer NOT NULL CHECK (`object_expected` BETWEEN 0 AND 20000),
  `object_processed` integer NOT NULL CHECK (`object_processed` BETWEEN 0 AND 20000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`billing_period_start_at`,`capture_id`),
  CHECK (length(`generation_id`)=68 AND substr(`generation_id`,1,4)='scg_' AND substr(`generation_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`capture_id`)=69 AND substr(`capture_id`,1,5)='scad_' AND substr(`capture_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`active_billing_generation_id`)=68 AND substr(`active_billing_generation_id`,1,4)='fbg_'),
  CHECK (length(`manifest_sha256`)=64 AND `manifest_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`source_state` IN ('CONFIGURATION_REQUIRED','WAITING_FIRST_DELIVERY','READY','PARTIAL','STALE','NO_USAGE')),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 134217728),
  CHECK (length(`billing_period_start_at`)=24 AND length(`billing_period_end_at`)=24 AND length(`generated_at`)=24 AND length(`data_through_at`)=24),
  CHECK (`complete`=0 OR `source_state` IN ('READY','STALE','NO_USAGE'))
);
--> statement-breakpoint
CREATE INDEX `finops_scad_allocation_history_idx` ON `finops_scad_allocation_snapshots`
 (`org_id`,`customer_id`,`connection_id`,`billing_period_start_at` DESC,`generated_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_scad_allocation_heads` (
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `billing_period_start_at` text NOT NULL, `active_generation_id` text NOT NULL UNIQUE,
  `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`,`billing_period_start_at`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_scad_allocation_snapshots`(`generation_id`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_scad_allocation_snapshots_update_guard` BEFORE UPDATE ON `finops_scad_allocation_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_SCAD_ALLOCATION_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_scad_allocation_snapshots_delete_guard` BEFORE DELETE ON `finops_scad_allocation_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_SCAD_ALLOCATION_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_scad_allocation_heads_insert_guard` BEFORE INSERT ON `finops_scad_allocation_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_scad_allocation_snapshots` candidate
 WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=NEW.`org_id`
 AND candidate.`customer_id`=NEW.`customer_id` AND candidate.`connection_id`=NEW.`connection_id`
 AND candidate.`billing_period_start_at`=NEW.`billing_period_start_at` AND candidate.`complete`=1)
BEGIN SELECT RAISE(ABORT,'FINOPS_SCAD_ALLOCATION_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_scad_allocation_heads_update_guard` BEFORE UPDATE ON `finops_scad_allocation_heads`
WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id`
 OR NEW.`billing_period_start_at`<>OLD.`billing_period_start_at` OR NOT EXISTS (
  SELECT 1 FROM `finops_scad_allocation_snapshots` candidate JOIN `finops_scad_allocation_snapshots` active
   ON active.`generation_id`=OLD.`active_generation_id`
  WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id`
   AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id`
   AND candidate.`billing_period_start_at`=OLD.`billing_period_start_at` AND candidate.`complete`=1
   AND (candidate.`generated_at`>active.`generated_at` OR (candidate.`generated_at`=active.`generated_at` AND candidate.`generation_id`>active.`generation_id`)))
BEGIN SELECT RAISE(ABORT,'FINOPS_SCAD_ALLOCATION_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_scad_allocation_heads_delete_guard` BEFORE DELETE ON `finops_scad_allocation_heads`
BEGIN SELECT RAISE(ABORT,'FINOPS_SCAD_ALLOCATION_HEAD_IMMUTABLE'); END;
