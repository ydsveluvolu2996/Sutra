CREATE TABLE `finops_marketplace_spg_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL, `org_id` text NOT NULL, `customer_id` text NOT NULL,
  `connection_id` text NOT NULL, `account_id` text NOT NULL, `partition` text NOT NULL CHECK (`partition`='aws'),
  `source_capture_id` text NOT NULL, `source_state` text NOT NULL CHECK (`source_state` IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED','STALE')),
  `content_sha256` text NOT NULL, `snapshot_json` text NOT NULL, `summary_json` text NOT NULL,
  `captured_at` text NOT NULL, `data_through_at` text NOT NULL,
  `organization_coverage` text NOT NULL CHECK (`organization_coverage` IN ('COMPLETE','PARTIAL','SINGLE_ACCOUNT_ONLY')),
  `agreement_state` text NOT NULL CHECK (`agreement_state` IN ('READY','EMPTY','PARTIAL')),
  `license_state` text NOT NULL CHECK (`license_state` IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED')),
  `spend_state` text NOT NULL CHECK (`spend_state` IN ('READY','EMPTY','PARTIAL','CONFIGURATION_REQUIRED')),
  `agreement_count` integer NOT NULL CHECK (`agreement_count` BETWEEN 0 AND 50000),
  `license_count` integer NOT NULL CHECK (`license_count` BETWEEN 0 AND 50000),
  `grant_count` integer NOT NULL CHECK (`grant_count` BETWEEN 0 AND 250000),
  `spend_row_count` integer NOT NULL CHECK (`spend_row_count` BETWEEN 0 AND 500000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`generation_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`source_capture_id`),
  CHECK (length(`generation_id`)=69 AND substr(`generation_id`,1,5)='mspg_' AND substr(`generation_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`source_capture_id`)=76 AND substr(`source_capture_id`,1,12)='marketplace_' AND substr(`source_capture_id`,13) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_id`)=12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 25165824), CHECK (length(`summary_json`) BETWEEN 2 AND 262144),
  CHECK (length(`captured_at`)=24 AND length(`data_through_at`)=24 AND `data_through_at`<=`captured_at`)
);
--> statement-breakpoint
CREATE INDEX `finops_marketplace_spg_history_idx` ON `finops_marketplace_spg_snapshots`
  (`org_id`,`customer_id`,`connection_id`,`captured_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_marketplace_spg_heads` (
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL UNIQUE, `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_marketplace_spg_snapshots`(`generation_id`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_marketplace_spg_snapshot_update_guard` BEFORE UPDATE ON `finops_marketplace_spg_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_marketplace_spg_snapshot_delete_guard` BEFORE DELETE ON `finops_marketplace_spg_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_marketplace_spg_head_insert_guard` BEFORE INSERT ON `finops_marketplace_spg_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_marketplace_spg_snapshots` candidate WHERE candidate.`generation_id`=NEW.`active_generation_id`
  AND candidate.`org_id`=NEW.`org_id` AND candidate.`customer_id`=NEW.`customer_id` AND candidate.`connection_id`=NEW.`connection_id`
  AND candidate.`organization_coverage`='COMPLETE' AND candidate.`source_state` IN ('READY','EMPTY')
  AND candidate.`agreement_state` IN ('READY','EMPTY') AND candidate.`license_state` IN ('READY','EMPTY') AND candidate.`spend_state` IN ('READY','EMPTY'))
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_marketplace_spg_head_update_guard` BEFORE UPDATE ON `finops_marketplace_spg_heads`
WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id` OR NOT EXISTS (
  SELECT 1 FROM `finops_marketplace_spg_snapshots` candidate JOIN `finops_marketplace_spg_snapshots` active ON active.`generation_id`=OLD.`active_generation_id`
  WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id`
    AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id`
    AND candidate.`organization_coverage`='COMPLETE' AND candidate.`source_state` IN ('READY','EMPTY')
    AND candidate.`agreement_state` IN ('READY','EMPTY') AND candidate.`license_state` IN ('READY','EMPTY') AND candidate.`spend_state` IN ('READY','EMPTY')
    AND candidate.`captured_at`>active.`captured_at`)
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_marketplace_spg_head_delete_guard` BEFORE DELETE ON `finops_marketplace_spg_heads`
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_HEAD_IMMUTABLE'); END;
