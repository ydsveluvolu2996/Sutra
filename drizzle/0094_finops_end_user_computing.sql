-- Immutable, tenant-scoped End User Computing snapshots. The payload is the
-- privacy-minimized normalized projection, never raw AWS user/session data.
CREATE TABLE `finops_euc_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `partition` text NOT NULL,
  `source_capture_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN ('READY','PARTIAL','STALE','UNAVAILABLE')),
  `observed_at` text NOT NULL,
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `workspace_count` integer NOT NULL,
  `fleet_count` integer NOT NULL,
  `metric_count` integer NOT NULL,
  `cost_line_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `generation_id`),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `source_capture_id`),
  CHECK (length(`generation_id`) = 69 AND substr(`generation_id`, 1, 5) = 'eucg_' AND substr(`generation_id`, 6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`source_capture_id`) = 68 AND substr(`source_capture_id`, 1, 4) = 'euc_' AND substr(`source_capture_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 8388608),
  CHECK (length(`observed_at`) = 24),
  CHECK (`workspace_count` BETWEEN 0 AND 50000),
  CHECK (`fleet_count` BETWEEN 0 AND 10000),
  CHECK (`metric_count` BETWEEN 0 AND 100000),
  CHECK (`cost_line_count` BETWEEN 0 AND 250000),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `finops_euc_snapshots_history_idx` ON `finops_euc_snapshots`
  (`org_id`, `customer_id`, `connection_id`, `observed_at` DESC, `generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_euc_snapshot_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL UNIQUE,
  `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_euc_snapshots`(`generation_id`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_euc_snapshots_update_guard` BEFORE UPDATE ON `finops_euc_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_EUC_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_euc_snapshots_delete_guard` BEFORE DELETE ON `finops_euc_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_EUC_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_euc_heads_insert_guard` BEFORE INSERT ON `finops_euc_snapshot_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_euc_snapshots` s WHERE s.`generation_id` = NEW.`active_generation_id` AND s.`org_id` = NEW.`org_id` AND s.`customer_id` = NEW.`customer_id` AND s.`connection_id` = NEW.`connection_id` AND s.`source_state` = 'READY')
BEGIN SELECT RAISE(ABORT, 'FINOPS_EUC_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_euc_heads_update_guard` BEFORE UPDATE ON `finops_euc_snapshot_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id` OR NEW.`connection_id` <> OLD.`connection_id`
  OR NOT EXISTS (
    SELECT 1 FROM `finops_euc_snapshots` candidate JOIN `finops_euc_snapshots` active ON active.`generation_id` = OLD.`active_generation_id`
    WHERE candidate.`generation_id` = NEW.`active_generation_id` AND candidate.`org_id` = OLD.`org_id` AND candidate.`customer_id` = OLD.`customer_id` AND candidate.`connection_id` = OLD.`connection_id`
      AND candidate.`source_state` = 'READY' AND candidate.`observed_at` > active.`observed_at`
  )
BEGIN SELECT RAISE(ABORT, 'FINOPS_EUC_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_euc_heads_delete_guard` BEFORE DELETE ON `finops_euc_snapshot_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_EUC_HEAD_IMMUTABLE'); END;
