-- Privacy-minimized AWS Support case evidence. The JSON payload has already
-- passed the exact-key engine and contains no correspondence or personal data.
CREATE TABLE `finops_aws_support_case_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `capture_id` text NOT NULL,
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `observed_at` text NOT NULL,
  `data_through_at` text NOT NULL,
  `configuration_state` text NOT NULL CHECK (`configuration_state` IN ('ready','unverified','unavailable')),
  `collection_state` text NOT NULL CHECK (`collection_state` IN ('complete','partial','unavailable')),
  `intended_account_count` integer NOT NULL CHECK (`intended_account_count` BETWEEN 1 AND 200),
  `complete_account_count` integer NOT NULL CHECK (`complete_account_count` BETWEEN 0 AND `intended_account_count`),
  `case_count` integer NOT NULL CHECK (`case_count` BETWEEN 0 AND 50000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `generation_id`),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `capture_id`),
  CHECK (length(`generation_id`) = 69 AND substr(`generation_id`, 1, 5) = 'supg_' AND substr(`generation_id`, 6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`capture_id`) = 72 AND substr(`capture_id`, 1, 8) = 'support_' AND substr(`capture_id`, 9) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 67108864),
  CHECK (length(`observed_at`) = 24 AND length(`data_through_at`) = 24 AND `data_through_at` <= `observed_at`),
  CHECK (`collection_state` <> 'complete' OR (`configuration_state` = 'ready' AND `complete_account_count` = `intended_account_count`))
);
--> statement-breakpoint
CREATE INDEX `finops_aws_support_case_snapshots_history_idx` ON `finops_aws_support_case_snapshots`
  (`org_id`, `customer_id`, `connection_id`, `observed_at` DESC, `generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_aws_support_case_heads` (
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL, `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_aws_support_case_snapshots`(`generation_id`),
  UNIQUE (`active_generation_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TRIGGER `finops_aws_support_case_snapshot_update_guard` BEFORE UPDATE ON `finops_aws_support_case_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_SUPPORT_CASE_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_support_case_snapshot_delete_guard` BEFORE DELETE ON `finops_aws_support_case_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_SUPPORT_CASE_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_support_case_head_insert_guard` BEFORE INSERT ON `finops_aws_support_case_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_aws_support_case_snapshots` s WHERE s.`generation_id` = NEW.`active_generation_id`
  AND s.`org_id` = NEW.`org_id` AND s.`customer_id` = NEW.`customer_id` AND s.`connection_id` = NEW.`connection_id`
  AND s.`configuration_state` = 'ready' AND s.`collection_state` = 'complete')
BEGIN SELECT RAISE(ABORT, 'FINOPS_SUPPORT_CASE_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_support_case_head_update_guard` BEFORE UPDATE ON `finops_aws_support_case_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id` OR NEW.`connection_id` <> OLD.`connection_id`
  OR NOT EXISTS (SELECT 1 FROM `finops_aws_support_case_snapshots` candidate
    JOIN `finops_aws_support_case_snapshots` active ON active.`generation_id` = OLD.`active_generation_id`
    WHERE candidate.`generation_id` = NEW.`active_generation_id` AND candidate.`org_id` = OLD.`org_id`
      AND candidate.`customer_id` = OLD.`customer_id` AND candidate.`connection_id` = OLD.`connection_id`
      AND candidate.`configuration_state` = 'ready' AND candidate.`collection_state` = 'complete'
      AND (candidate.`data_through_at` > active.`data_through_at`
        OR (candidate.`data_through_at` = active.`data_through_at` AND candidate.`observed_at` > active.`observed_at`)))
BEGIN SELECT RAISE(ABORT, 'FINOPS_SUPPORT_CASE_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_support_case_head_delete_guard` BEFORE DELETE ON `finops_aws_support_case_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_SUPPORT_CASE_HEAD_IMMUTABLE'); END;
