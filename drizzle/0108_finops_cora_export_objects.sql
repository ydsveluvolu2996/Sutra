CREATE TABLE `finops_cora_export_object_generations` (
  `generation_id` text PRIMARY KEY NOT NULL, `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `management_account_id` text NOT NULL, `request_key` text NOT NULL, `materialization_id` text NOT NULL, `capture_id` text NOT NULL,
  `export_arn` text NOT NULL, `execution_id` text NOT NULL, `source_state` text NOT NULL CHECK (`source_state` IN ('WAITING_DELIVERY','FAILED','PARTIAL','EMPTY','COMPLETE')),
  `complete` integer NOT NULL CHECK (`complete` IN (0,1)), `content_sha256` text NOT NULL, `materialization_json` text NOT NULL,
  `scheduled_window` text NOT NULL, `generated_at` text, `data_through_at` text, `manifest_sha256` text, `object_count` integer NOT NULL,
  `row_count` integer NOT NULL, `accepted_row_count` integer NOT NULL, `rejected_row_count` integer NOT NULL, `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE, FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`request_key`), UNIQUE (`org_id`,`customer_id`,`connection_id`,`materialization_id`), UNIQUE (`org_id`,`customer_id`,`connection_id`,`execution_id`),
  CHECK (length(`generation_id`)=69 AND substr(`generation_id`,1,5)='core_' AND substr(`generation_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`request_key`)=71 AND substr(`request_key`,1,7)='corarq_' AND substr(`request_key`,8) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`materialization_id`)=70 AND substr(`materialization_id`,1,6)='coram_' AND substr(`materialization_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`capture_id`)=69 AND substr(`capture_id`,1,5)='cora_' AND substr(`capture_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`management_account_id`)=12 AND `management_account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'), CHECK (length(`materialization_json`) BETWEEN 2 AND 201326592),
  CHECK (length(`scheduled_window`)=24), CHECK (`generated_at` IS NULL OR length(`generated_at`)=24), CHECK (`data_through_at` IS NULL OR length(`data_through_at`)=24),
  CHECK (`manifest_sha256` IS NULL OR length(`manifest_sha256`)=64), CHECK (`object_count` BETWEEN 0 AND 100000), CHECK (`row_count` BETWEEN 0 AND 500000),
  CHECK (`accepted_row_count` BETWEEN 0 AND `row_count`), CHECK (`rejected_row_count` BETWEEN 0 AND `row_count`), CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`complete`=0 OR (`source_state` IN ('COMPLETE','EMPTY') AND `generated_at` IS NOT NULL AND `data_through_at` IS NOT NULL AND `manifest_sha256` IS NOT NULL AND `accepted_row_count`=`row_count` AND `rejected_row_count`=0))
);
--> statement-breakpoint
CREATE INDEX `finops_cora_export_object_history_idx` ON `finops_cora_export_object_generations` (`org_id`,`customer_id`,`connection_id`,`scheduled_window` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_cora_export_object_heads` (`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,`active_generation_id` text NOT NULL UNIQUE,`advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),PRIMARY KEY(`org_id`,`customer_id`,`connection_id`),FOREIGN KEY(`active_generation_id`) REFERENCES `finops_cora_export_object_generations`(`generation_id`));
--> statement-breakpoint
CREATE TRIGGER `finops_cora_export_objects_update_guard` BEFORE UPDATE ON `finops_cora_export_object_generations` BEGIN SELECT RAISE(ABORT,'FINOPS_CORA_EXPORT_OBJECT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_export_objects_delete_guard` BEFORE DELETE ON `finops_cora_export_object_generations` BEGIN SELECT RAISE(ABORT,'FINOPS_CORA_EXPORT_OBJECT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_export_heads_insert_guard` BEFORE INSERT ON `finops_cora_export_object_heads` WHEN NOT EXISTS(SELECT 1 FROM `finops_cora_export_object_generations` candidate WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=NEW.`org_id` AND candidate.`customer_id`=NEW.`customer_id` AND candidate.`connection_id`=NEW.`connection_id` AND candidate.`complete`=1 AND candidate.`source_state` IN ('COMPLETE','EMPTY')) BEGIN SELECT RAISE(ABORT,'FINOPS_CORA_EXPORT_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_export_heads_update_guard` BEFORE UPDATE ON `finops_cora_export_object_heads` WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id` OR NOT EXISTS(SELECT 1 FROM `finops_cora_export_object_generations` candidate JOIN `finops_cora_export_object_generations` active ON active.`generation_id`=OLD.`active_generation_id` WHERE candidate.`generation_id`=NEW.`active_generation_id` AND candidate.`org_id`=OLD.`org_id` AND candidate.`customer_id`=OLD.`customer_id` AND candidate.`connection_id`=OLD.`connection_id` AND candidate.`complete`=1 AND candidate.`source_state` IN ('COMPLETE','EMPTY') AND(candidate.`data_through_at`>active.`data_through_at` OR(candidate.`data_through_at`=active.`data_through_at` AND(candidate.`generated_at`>active.`generated_at` OR(candidate.`generated_at`=active.`generated_at` AND candidate.`generation_id`>active.`generation_id`))))) BEGIN SELECT RAISE(ABORT,'FINOPS_CORA_EXPORT_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_export_heads_delete_guard` BEFORE DELETE ON `finops_cora_export_object_heads` BEGIN SELECT RAISE(ABORT,'FINOPS_CORA_EXPORT_OBJECT_IMMUTABLE'); END;
