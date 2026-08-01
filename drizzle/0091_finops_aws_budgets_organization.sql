-- Immutable, tenant-pinned AWS Budgets provider generations. This is
-- intentionally separate from finops_budgets, which stores Sutra-authored
-- budget guardrails.
CREATE TABLE `finops_aws_budget_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `source_capture_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('ready','partial','configuration_required','unavailable')),
  `hierarchy_state` text CHECK (`hierarchy_state` IN ('complete','partial','configuration_required','unavailable')),
  `observed_at` text NOT NULL,
  `data_through_at` text,
  `content_sha256` text NOT NULL,
  `payload_json` text NOT NULL,
  `budget_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `generation_id`),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `source_capture_id`),
  CHECK (length(`generation_id`) = 68 AND substr(`generation_id`, 1, 4) = 'abg_'
    AND substr(`generation_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`source_capture_id`) = 75 AND substr(`source_capture_id`, 1, 11) = 'awsbudgets_'
    AND substr(`source_capture_id`, 12) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_id`) = 12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`observed_at`) = 24),
  CHECK (`data_through_at` IS NULL OR (length(`data_through_at`) = 24 AND `data_through_at` <= `observed_at`)),
  CHECK (length(`payload_json`) BETWEEN 2 AND 16777216),
  CHECK (`budget_count` BETWEEN 0 AND 1000),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`state` <> 'ready' OR `hierarchy_state` = 'complete')
);
--> statement-breakpoint
CREATE INDEX `finops_aws_budget_snapshots_history_idx` ON `finops_aws_budget_snapshots`
  (`org_id`, `customer_id`, `connection_id`, `observed_at` DESC, `generation_id` DESC);
--> statement-breakpoint

CREATE TABLE `finops_aws_budget_snapshot_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL,
  `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_aws_budget_snapshots`(`generation_id`),
  UNIQUE (`active_generation_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint

CREATE TRIGGER `finops_aws_budget_snapshots_update_guard` BEFORE UPDATE ON `finops_aws_budget_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_BUDGET_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_budget_snapshots_delete_guard` BEFORE DELETE ON `finops_aws_budget_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_BUDGET_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_budget_heads_insert_guard` BEFORE INSERT ON `finops_aws_budget_snapshot_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_aws_budget_snapshots` candidate
   WHERE candidate.`generation_id` = NEW.`active_generation_id`
     AND candidate.`org_id` = NEW.`org_id`
     AND candidate.`customer_id` = NEW.`customer_id`
     AND candidate.`connection_id` = NEW.`connection_id`
     AND candidate.`state` = 'ready' AND candidate.`hierarchy_state` = 'complete'
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_BUDGET_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_budget_heads_update_guard` BEFORE UPDATE ON `finops_aws_budget_snapshot_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`connection_id` <> OLD.`connection_id`
  OR NOT EXISTS (
    SELECT 1 FROM `finops_aws_budget_snapshots` candidate
    JOIN `finops_aws_budget_snapshots` active
      ON active.`generation_id` = OLD.`active_generation_id`
   WHERE candidate.`generation_id` = NEW.`active_generation_id`
     AND candidate.`org_id` = OLD.`org_id`
     AND candidate.`customer_id` = OLD.`customer_id`
     AND candidate.`connection_id` = OLD.`connection_id`
     AND candidate.`state` = 'ready' AND candidate.`hierarchy_state` = 'complete'
     AND (candidate.`observed_at` > active.`observed_at`
       OR (candidate.`observed_at` = active.`observed_at`
         AND candidate.`generation_id` > active.`generation_id`))
  )
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_BUDGET_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_budget_heads_delete_guard` BEFORE DELETE ON `finops_aws_budget_snapshot_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_BUDGET_HEAD_IMMUTABLE'); END;
