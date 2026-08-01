-- Immutable Kubecost/OpenCost allocation snapshots. These are attribution
-- views reconciled to CUR2, never an independent spend ledger.
CREATE TABLE `finops_kubecost_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `partition` text NOT NULL,
  `billing_period` text NOT NULL,
  `active_cur2_generation_id` text NOT NULL,
  `source_capture_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN ('CONFIGURATION_REQUIRED','WAITING_FIRST_DELIVERY','UNKNOWN','ERROR','EMPTY','PARTIAL','STALE','READY')),
  `complete` integer NOT NULL CHECK (`complete` IN (0,1)),
  `data_through_at` text NOT NULL,
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `row_count` integer NOT NULL,
  `group_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`generation_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`source_capture_id`),
  CHECK (length(`generation_id`) = 68 AND substr(`generation_id`,1,4) = 'kcg_' AND substr(`generation_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`source_capture_id`) = 73 AND substr(`source_capture_id`,1,9) = 'kubecost_' AND substr(`source_capture_id`,10) NOT GLOB '*[^a-f0-9]*'),
  CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  CHECK (length(`billing_period`) = 7),
  CHECK (length(`active_cur2_generation_id`) = 68 AND substr(`active_cur2_generation_id`,1,4) = 'fbg_'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 25165824),
  CHECK (length(`data_through_at`) = 24),
  CHECK (`row_count` BETWEEN 0 AND 750000),
  CHECK (`group_count` BETWEEN 0 AND 250000),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`complete` = 0 OR (`source_state` IN ('READY','EMPTY')))
);
--> statement-breakpoint
CREATE INDEX `finops_kubecost_snapshots_history_idx` ON `finops_kubecost_snapshots` (`org_id`,`customer_id`,`connection_id`,`data_through_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_kubecost_snapshot_heads` (
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL UNIQUE, `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_kubecost_snapshots`(`generation_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_snapshots_update_guard` BEFORE UPDATE ON `finops_kubecost_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_snapshots_delete_guard` BEFORE DELETE ON `finops_kubecost_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_heads_insert_guard` BEFORE INSERT ON `finops_kubecost_snapshot_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_kubecost_snapshots` s WHERE s.`generation_id`=NEW.`active_generation_id` AND s.`org_id`=NEW.`org_id` AND s.`customer_id`=NEW.`customer_id` AND s.`connection_id`=NEW.`connection_id` AND s.`complete`=1 AND s.`source_state` IN ('READY','EMPTY'))
BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_heads_update_guard` BEFORE UPDATE ON `finops_kubecost_snapshot_heads`
WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id`
 OR NOT EXISTS (SELECT 1 FROM `finops_kubecost_snapshots` candidate JOIN `finops_kubecost_snapshots` active ON active.`generation_id`=OLD.`active_generation_id` WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id` AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id` AND candidate.`complete`=1 AND candidate.`source_state` IN ('READY','EMPTY') AND candidate.`data_through_at`>active.`data_through_at`)
BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_heads_delete_guard` BEFORE DELETE ON `finops_kubecost_snapshot_heads`
BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_HEAD_IMMUTABLE'); END;
