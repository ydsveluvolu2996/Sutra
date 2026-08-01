CREATE TABLE `finops_graviton_snapshots` (
 `generation_id` text PRIMARY KEY NOT NULL,`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,
 `management_account_id` text NOT NULL,`partition` text NOT NULL,`source_collection_id` text NOT NULL,
 `source_state` text NOT NULL CHECK(`source_state` IN ('COMPLETE','PARTIAL','CONFIGURATION_REQUIRED')),
 `generated_at` text NOT NULL,`content_sha256` text NOT NULL,`snapshot_json` text NOT NULL,
 `opportunity_count` integer NOT NULL,`usage_group_count` integer NOT NULL,`created_at` integer NOT NULL,
 FOREIGN KEY(`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,FOREIGN KEY(`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,FOREIGN KEY(`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
 UNIQUE(`org_id`,`customer_id`,`connection_id`,`generation_id`),UNIQUE(`org_id`,`customer_id`,`connection_id`,`source_collection_id`),
 CHECK(length(`generation_id`)=68 AND substr(`generation_id`,1,4)='gvg_' AND substr(`generation_id`,5) NOT GLOB '*[^a-f0-9]*'),
 CHECK(length(`management_account_id`)=12 AND `management_account_id` NOT GLOB '*[^0-9]*'),CHECK(`partition` IN ('aws','aws-us-gov','aws-cn')),
 CHECK(length(`source_collection_id`) BETWEEN 1 AND 128),CHECK(length(`generated_at`)=24),CHECK(length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
 CHECK(length(`snapshot_json`) BETWEEN 2 AND 8388608),CHECK(`opportunity_count` BETWEEN 0 AND 5000),CHECK(`usage_group_count` BETWEEN 0 AND 250000),CHECK(`created_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `finops_graviton_snapshots_history_idx` ON `finops_graviton_snapshots`(`org_id`,`customer_id`,`connection_id`,`generated_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_graviton_snapshot_heads`(`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,`active_generation_id` text NOT NULL UNIQUE,`advanced_at` integer NOT NULL,PRIMARY KEY(`org_id`,`customer_id`,`connection_id`),FOREIGN KEY(`active_generation_id`) REFERENCES `finops_graviton_snapshots`(`generation_id`),CHECK(`advanced_at` BETWEEN 0 AND 9007199254740991));
--> statement-breakpoint
CREATE TRIGGER `finops_graviton_snapshots_update_guard` BEFORE UPDATE ON `finops_graviton_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_GRAVITON_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_graviton_snapshots_delete_guard` BEFORE DELETE ON `finops_graviton_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_GRAVITON_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_graviton_heads_insert_guard` BEFORE INSERT ON `finops_graviton_snapshot_heads` WHEN NOT EXISTS(SELECT 1 FROM `finops_graviton_snapshots` s WHERE s.`generation_id`=NEW.`active_generation_id` AND s.`org_id`=NEW.`org_id` AND s.`customer_id`=NEW.`customer_id` AND s.`connection_id`=NEW.`connection_id` AND s.`source_state`='COMPLETE') BEGIN SELECT RAISE(ABORT,'FINOPS_GRAVITON_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_graviton_heads_update_guard` BEFORE UPDATE ON `finops_graviton_snapshot_heads` WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id` OR NOT EXISTS(SELECT 1 FROM `finops_graviton_snapshots` candidate JOIN `finops_graviton_snapshots` active ON active.`generation_id`=OLD.`active_generation_id` WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id` AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id` AND candidate.`source_state`='COMPLETE' AND candidate.`generated_at`>active.`generated_at`) BEGIN SELECT RAISE(ABORT,'FINOPS_GRAVITON_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_graviton_heads_delete_guard` BEFORE DELETE ON `finops_graviton_snapshot_heads` BEGIN SELECT RAISE(ABORT,'FINOPS_GRAVITON_HEAD_IMMUTABLE'); END;
