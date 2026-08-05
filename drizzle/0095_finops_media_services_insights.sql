-- Immutable normalized Media Services inventory joined to an active CUR2 slice.
-- A head exists only for a complete server-pinned account/partition/Region target.
CREATE TABLE `finops_media_services_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-cn','aws-us-gov')),
  `region` text NOT NULL,
  `capture_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN ('configuration_required','failed','partial','empty','stale','current')),
  `complete` integer NOT NULL CHECK (`complete` IN (0,1)),
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `completed_at` text NOT NULL,
  `data_through_at` text NOT NULL,
  `billing_generation_id` text NOT NULL,
  `billing_manifest_sha256` text NOT NULL,
  `provider_count` integer NOT NULL CHECK (`provider_count` = 6),
  `resource_count` integer NOT NULL CHECK (`resource_count` BETWEEN 0 AND 300000),
  `cost_row_count` integer NOT NULL CHECK (`cost_row_count` BETWEEN 0 AND 500000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`account_id`,`partition`,`region`,`capture_id`),
  CHECK (length(`generation_id`) = 68 AND substr(`generation_id`,1,4) = 'msg_'
    AND substr(`generation_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`capture_id`) = 70 AND substr(`capture_id`,1,6) = 'media_'
    AND substr(`capture_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`billing_manifest_sha256`) = 64 AND `billing_manifest_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`billing_generation_id`) = 68 AND substr(`billing_generation_id`,1,4) = 'fbg_'),
  CHECK (length(`account_id`) = 12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`region`) BETWEEN 9 AND 32),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 83886080),
  CHECK (length(`completed_at`) = 24 AND length(`data_through_at`) = 24),
  CHECK (`complete` = 0 OR `source_state` IN ('empty','stale','current'))
);
--> statement-breakpoint
CREATE INDEX `finops_media_services_history_idx` ON `finops_media_services_snapshots`
  (`org_id`,`customer_id`,`connection_id`,`completed_at` DESC,`generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_media_services_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL,
  `region` text NOT NULL,
  `active_generation_id` text NOT NULL UNIQUE,
  `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`,`account_id`,`partition`,`region`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_media_services_snapshots`(`generation_id`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_media_services_snapshots_update_guard`
BEFORE UPDATE ON `finops_media_services_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_MEDIA_SERVICES_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_media_services_snapshots_delete_guard`
BEFORE DELETE ON `finops_media_services_snapshots`
BEGIN SELECT RAISE(ABORT,'FINOPS_MEDIA_SERVICES_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_media_services_heads_insert_guard`
BEFORE INSERT ON `finops_media_services_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_media_services_snapshots` candidate
  WHERE candidate.`generation_id`=NEW.`active_generation_id`
    AND candidate.`org_id`=NEW.`org_id` AND candidate.`customer_id`=NEW.`customer_id`
    AND candidate.`connection_id`=NEW.`connection_id` AND candidate.`account_id`=NEW.`account_id`
    AND candidate.`partition`=NEW.`partition` AND candidate.`region`=NEW.`region`
    AND candidate.`complete`=1
)
BEGIN SELECT RAISE(ABORT,'FINOPS_MEDIA_SERVICES_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_media_services_heads_update_guard`
BEFORE UPDATE ON `finops_media_services_heads`
WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id`
 OR NEW.`connection_id`<>OLD.`connection_id` OR NEW.`account_id`<>OLD.`account_id`
 OR NEW.`partition`<>OLD.`partition` OR NEW.`region`<>OLD.`region`
 OR NOT EXISTS (
  SELECT 1 FROM `finops_media_services_snapshots` candidate
  JOIN `finops_media_services_snapshots` active ON active.`generation_id`=OLD.`active_generation_id`
  WHERE candidate.`generation_id`=NEW.`active_generation_id`
    AND candidate.`org_id`=OLD.`org_id` AND candidate.`customer_id`=OLD.`customer_id`
    AND candidate.`connection_id`=OLD.`connection_id` AND candidate.`account_id`=OLD.`account_id`
    AND candidate.`partition`=OLD.`partition` AND candidate.`region`=OLD.`region`
    AND candidate.`complete`=1
    AND (candidate.`completed_at`>active.`completed_at`
      OR (candidate.`completed_at`=active.`completed_at` AND candidate.`generation_id`>active.`generation_id`))
 )
BEGIN SELECT RAISE(ABORT,'FINOPS_MEDIA_SERVICES_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_media_services_heads_delete_guard`
BEFORE DELETE ON `finops_media_services_heads`
BEGIN SELECT RAISE(ABORT,'FINOPS_MEDIA_SERVICES_HEAD_IMMUTABLE'); END;
