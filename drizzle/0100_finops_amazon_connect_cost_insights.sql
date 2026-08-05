CREATE TABLE `finops_amazon_connect_cost_snapshots` (
 `generation_id` text PRIMARY KEY NOT NULL,`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,
 `account_id` text NOT NULL,`partition` text NOT NULL CHECK (`partition` IN ('aws','aws-cn','aws-us-gov')),`region` text NOT NULL,
 `source_capture_id` text NOT NULL,`source_state` text NOT NULL CHECK (`source_state` IN ('configuration_required','permission_required','failed','partial','empty','stale','current')),
 `complete` integer NOT NULL CHECK (`complete` IN (0,1)),`content_sha256` text NOT NULL,`snapshot_json` text NOT NULL,
 `completed_at` text NOT NULL,`data_through_at` text NOT NULL,`billing_generation_id` text NOT NULL,`billing_manifest_sha256` text NOT NULL,
 `instance_count` integer NOT NULL CHECK (`instance_count` BETWEEN 0 AND 100),`phone_aggregate_count` integer NOT NULL CHECK (`phone_aggregate_count` BETWEEN 0 AND 10000),
 `cost_row_count` integer NOT NULL CHECK (`cost_row_count` BETWEEN 0 AND 500000),`created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
 UNIQUE (`org_id`,`customer_id`,`connection_id`,`generation_id`),UNIQUE (`org_id`,`customer_id`,`connection_id`,`source_capture_id`),
 CHECK (length(`generation_id`)=69 AND substr(`generation_id`,1,5)='acig_' AND substr(`generation_id`,6) NOT GLOB '*[^a-f0-9]*'),
 CHECK (length(`source_capture_id`)=72 AND substr(`source_capture_id`,1,8)='connect_' AND substr(`source_capture_id`,9) NOT GLOB '*[^a-f0-9]*'),
 CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),CHECK (length(`billing_manifest_sha256`)=64 AND `billing_manifest_sha256` NOT GLOB '*[^a-f0-9]*'),
 CHECK (length(`billing_generation_id`)=68 AND substr(`billing_generation_id`,1,4)='fbg_'),CHECK (length(`account_id`)=12 AND `account_id` NOT GLOB '*[^0-9]*'),
 CHECK (length(`region`) BETWEEN 9 AND 32),CHECK (length(`snapshot_json`) BETWEEN 2 AND 83886080),CHECK (length(`completed_at`)=24 AND length(`data_through_at`)=24 AND `data_through_at`<=`completed_at`),
 CHECK (`complete`=0 OR `source_state` IN ('empty','stale','current'))
);
--> statement-breakpoint
CREATE INDEX `finops_amazon_connect_cost_history_idx` ON `finops_amazon_connect_cost_snapshots` (`org_id`,`customer_id`,`connection_id`,`completed_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_amazon_connect_cost_heads` (`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,`active_generation_id` text NOT NULL UNIQUE,`advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),FOREIGN KEY (`active_generation_id`) REFERENCES `finops_amazon_connect_cost_snapshots`(`generation_id`));
--> statement-breakpoint
CREATE TRIGGER `finops_amazon_connect_cost_snapshot_update_guard` BEFORE UPDATE ON `finops_amazon_connect_cost_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_AMAZON_CONNECT_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_amazon_connect_cost_snapshot_delete_guard` BEFORE DELETE ON `finops_amazon_connect_cost_snapshots` BEGIN SELECT RAISE(ABORT,'FINOPS_AMAZON_CONNECT_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_amazon_connect_cost_head_insert_guard` BEFORE INSERT ON `finops_amazon_connect_cost_heads` WHEN NOT EXISTS (SELECT 1 FROM `finops_amazon_connect_cost_snapshots` c WHERE c.`generation_id`=NEW.`active_generation_id` AND c.`org_id`=NEW.`org_id` AND c.`customer_id`=NEW.`customer_id` AND c.`connection_id`=NEW.`connection_id` AND c.`complete`=1) BEGIN SELECT RAISE(ABORT,'FINOPS_AMAZON_CONNECT_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_amazon_connect_cost_head_update_guard` BEFORE UPDATE ON `finops_amazon_connect_cost_heads` WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id` OR NOT EXISTS (SELECT 1 FROM `finops_amazon_connect_cost_snapshots` candidate JOIN `finops_amazon_connect_cost_snapshots` active ON active.`generation_id`=OLD.`active_generation_id` WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id` AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id` AND candidate.`complete`=1 AND candidate.`completed_at`>active.`completed_at`) BEGIN SELECT RAISE(ABORT,'FINOPS_AMAZON_CONNECT_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_amazon_connect_cost_head_delete_guard` BEFORE DELETE ON `finops_amazon_connect_cost_heads` BEGIN SELECT RAISE(ABORT,'FINOPS_AMAZON_CONNECT_HEAD_IMMUTABLE'); END;
