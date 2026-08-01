-- Immutable, normalized CORA dashboard snapshots. Raw Cost Optimization Hub
-- exports never enter this projection; the JSON is the bounded CoraSnapshot
-- produced by lib/finops-cora.ts.
CREATE TABLE `finops_cora_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `source_capture_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN (
    'READY', 'PARTIAL', 'CONFIGURATION_REQUIRED', 'STALE', 'EMPTY', 'ERROR'
  )),
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `summary_json` text NOT NULL,
  `collected_at` text NOT NULL,
  `data_through_at` text,
  `organization_coverage` text NOT NULL CHECK (`organization_coverage` IN (
    'COMPLETE', 'PARTIAL', 'SINGLE_ACCOUNT_ONLY'
  )),
  `enrollment_state` text NOT NULL,
  `recommendation_state` text NOT NULL,
  `expected_account_count` integer NOT NULL,
  `active_enrollment_account_count` integer NOT NULL,
  `recommendation_count` integer NOT NULL,
  `accepted_record_count` integer NOT NULL,
  `rejected_record_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `generation_id`),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `source_capture_id`),
  CHECK (length(`generation_id`) = 69 AND substr(`generation_id`, 1, 5) = 'corg_'
    AND substr(`generation_id`, 6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`source_capture_id`) = 69 AND substr(`source_capture_id`, 1, 5) = 'cora_'
    AND substr(`source_capture_id`, 6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 25165824),
  CHECK (length(`summary_json`) BETWEEN 2 AND 262144),
  CHECK (length(`collected_at`) = 24),
  CHECK (`data_through_at` IS NULL OR
    (length(`data_through_at`) = 24 AND `data_through_at` <= `collected_at`)),
  CHECK (`enrollment_state` IN ('READY', 'PARTIAL', 'CONFIGURATION_REQUIRED')),
  CHECK (`recommendation_state` IN (
    'READY', 'PARTIAL', 'EMPTY', 'CONFIGURATION_REQUIRED', 'ERROR', 'STALE'
  )),
  CHECK (`expected_account_count` BETWEEN 1 AND 10000),
  CHECK (`active_enrollment_account_count` BETWEEN 0 AND `expected_account_count`),
  CHECK (`recommendation_count` BETWEEN 0 AND 500000),
  CHECK (`accepted_record_count` = `recommendation_count`),
  CHECK (`rejected_record_count` BETWEEN 0 AND 500000),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`source_state` <> 'READY' OR (
    `organization_coverage` = 'COMPLETE'
    AND `enrollment_state` = 'READY'
    AND `recommendation_state` IN ('READY', 'EMPTY')
    AND `active_enrollment_account_count` = `expected_account_count`
    AND `rejected_record_count` = 0
    AND `data_through_at` IS NOT NULL
  ))
);
--> statement-breakpoint
CREATE INDEX `finops_cora_snapshots_history_idx` ON `finops_cora_snapshots`
  (`org_id`, `customer_id`, `connection_id`, `collected_at` DESC, `generation_id` DESC);
--> statement-breakpoint

CREATE TABLE `finops_cora_snapshot_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL,
  `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_cora_snapshots`(`generation_id`),
  UNIQUE (`active_generation_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint

CREATE TRIGGER `finops_cora_snapshots_update_guard` BEFORE UPDATE ON `finops_cora_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_CORA_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_snapshots_delete_guard` BEFORE DELETE ON `finops_cora_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_CORA_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_heads_insert_guard` BEFORE INSERT ON `finops_cora_snapshot_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_cora_snapshots` s
   WHERE s.`generation_id` = NEW.`active_generation_id`
     AND s.`org_id` = NEW.`org_id` AND s.`customer_id` = NEW.`customer_id`
     AND s.`connection_id` = NEW.`connection_id` AND s.`source_state` = 'READY'
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_CORA_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_heads_update_guard` BEFORE UPDATE ON `finops_cora_snapshot_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`connection_id` <> OLD.`connection_id`
  OR NOT EXISTS (
    SELECT 1 FROM `finops_cora_snapshots` candidate
    JOIN `finops_cora_snapshots` active
      ON active.`generation_id` = OLD.`active_generation_id`
   WHERE candidate.`generation_id` = NEW.`active_generation_id`
     AND candidate.`org_id` = OLD.`org_id` AND candidate.`customer_id` = OLD.`customer_id`
     AND candidate.`connection_id` = OLD.`connection_id` AND candidate.`source_state` = 'READY'
     AND (candidate.`data_through_at` > active.`data_through_at`
       OR (candidate.`data_through_at` = active.`data_through_at`
         AND candidate.`collected_at` > active.`collected_at`))
  )
BEGIN SELECT RAISE(ABORT, 'FINOPS_CORA_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_cora_heads_delete_guard` BEFORE DELETE ON `finops_cora_snapshot_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_CORA_HEAD_IMMUTABLE'); END;
