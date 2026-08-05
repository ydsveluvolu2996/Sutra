-- Immutable dual-channel sustainability snapshots. CUR2 proxy usage and AWS
-- provider carbon remain independently typed inside the sealed payload.
CREATE TABLE `finops_sustainability_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `account_id` text NOT NULL, `partition` text NOT NULL,
  `source_capture_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN ('configuration_required','waiting_first_delivery','empty','partial','stale','current')),
  `complete` integer NOT NULL CHECK (`complete` IN (0,1)),
  `proxy_state` text NOT NULL, `carbon_state` text NOT NULL,
  `completed_at` text NOT NULL, `content_sha256` text NOT NULL, `snapshot_json` text NOT NULL,
  `proxy_row_count` integer NOT NULL, `carbon_row_count` integer NOT NULL, `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`generation_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`source_capture_id`),
  CHECK (length(`generation_id`)=68 AND substr(`generation_id`,1,4)='scg_' AND substr(`generation_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`source_capture_id`)=79 AND substr(`source_capture_id`,1,15)='sustainability_' AND substr(`source_capture_id`,16) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_id`)=12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (`partition` IN ('aws','aws-cn','aws-us-gov')),
  CHECK (`proxy_state` IN ('not_configured','waiting_first_delivery','empty','partial','stale','current')),
  CHECK (`carbon_state` IN ('not_configured','waiting_first_delivery','empty','partial','stale','current')),
  CHECK (length(`completed_at`)=24), CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 117440512),
  CHECK (`proxy_row_count` BETWEEN 0 AND 500000), CHECK (`carbon_row_count` BETWEEN 0 AND 500000),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`complete`=0 OR `source_state` IN ('current','empty','stale'))
);
--> statement-breakpoint
CREATE INDEX `finops_sustainability_snapshots_history_idx` ON `finops_sustainability_snapshots` (`org_id`,`customer_id`,`connection_id`,`completed_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_sustainability_snapshot_heads` (`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,`active_generation_id` text NOT NULL UNIQUE,`advanced_at` integer NOT NULL,PRIMARY KEY(`org_id`,`customer_id`,`connection_id`),FOREIGN KEY(`active_generation_id`) REFERENCES `finops_sustainability_snapshots`(`generation_id`),CHECK(`advanced_at` BETWEEN 0 AND 9007199254740991));
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_snapshots_update_guard` BEFORE UPDATE ON `finops_sustainability_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_snapshots_delete_guard` BEFORE DELETE ON `finops_sustainability_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_heads_insert_guard` BEFORE INSERT ON `finops_sustainability_snapshot_heads` WHEN NOT EXISTS (SELECT 1 FROM `finops_sustainability_snapshots` s WHERE s.`generation_id`=NEW.`active_generation_id` AND s.`org_id`=NEW.`org_id` AND s.`customer_id`=NEW.`customer_id` AND s.`connection_id`=NEW.`connection_id` AND s.`complete`=1 AND s.`source_state` IN ('current','empty')) BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_heads_update_guard` BEFORE UPDATE ON `finops_sustainability_snapshot_heads` WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id` OR NOT EXISTS (SELECT 1 FROM `finops_sustainability_snapshots` candidate JOIN `finops_sustainability_snapshots` active ON active.`generation_id`=OLD.`active_generation_id` WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id` AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id` AND candidate.`complete`=1 AND candidate.`source_state` IN ('current','empty') AND candidate.`completed_at`>active.`completed_at`) BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_heads_delete_guard` BEFORE DELETE ON `finops_sustainability_snapshot_heads` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_HEAD_IMMUTABLE'); END;
