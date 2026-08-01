-- Immutable AWS Resilience Hub assessment evidence. One accepted head is kept
-- for every server-resolved account/partition/Region target in a connection.
CREATE TABLE `finops_resilience_vue_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-cn','aws-us-gov')),
  `region` text NOT NULL,
  `capture_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN ('configuration_required','no_apps','no_assessments','partial','stale','current')),
  `complete` integer NOT NULL CHECK (`complete` IN (0,1)),
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `completed_at` text NOT NULL,
  `application_count` integer NOT NULL CHECK (`application_count` BETWEEN 0 AND 1000),
  `assessment_count` integer NOT NULL CHECK (`assessment_count` BETWEEN 0 AND 20000),
  `recommendation_count` integer NOT NULL CHECK (`recommendation_count` BETWEEN 0 AND 200000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `account_id`, `partition`, `region`, `capture_id`),
  CHECK (length(`generation_id`) = 68 AND substr(`generation_id`, 1, 4) = 'rvg_'
    AND substr(`generation_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`capture_id`) = 75 AND substr(`capture_id`, 1, 11) = 'resilience_'
    AND substr(`capture_id`, 12) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_id`) = 12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`region`) BETWEEN 9 AND 32),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 67108864),
  CHECK (length(`completed_at`) = 24),
  CHECK (`complete` = 0 OR `source_state` IN ('no_apps','no_assessments','stale','current'))
);
--> statement-breakpoint
CREATE INDEX `finops_resilience_vue_history_idx`
  ON `finops_resilience_vue_snapshots`
  (`org_id`, `customer_id`, `connection_id`, `completed_at` DESC, `generation_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_resilience_vue_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL,
  `region` text NOT NULL,
  `active_generation_id` text NOT NULL UNIQUE,
  `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`, `account_id`, `partition`, `region`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_resilience_vue_snapshots`(`generation_id`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_snapshots_update_guard`
BEFORE UPDATE ON `finops_resilience_vue_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_RESILIENCE_VUE_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_snapshots_delete_guard`
BEFORE DELETE ON `finops_resilience_vue_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_RESILIENCE_VUE_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_heads_insert_guard`
BEFORE INSERT ON `finops_resilience_vue_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_resilience_vue_snapshots` candidate
  WHERE candidate.`generation_id` = NEW.`active_generation_id`
    AND candidate.`org_id` = NEW.`org_id` AND candidate.`customer_id` = NEW.`customer_id`
    AND candidate.`connection_id` = NEW.`connection_id` AND candidate.`account_id` = NEW.`account_id`
    AND candidate.`partition` = NEW.`partition` AND candidate.`region` = NEW.`region`
    AND candidate.`complete` = 1
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_RESILIENCE_VUE_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_heads_update_guard`
BEFORE UPDATE ON `finops_resilience_vue_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id`
 OR NEW.`connection_id` <> OLD.`connection_id` OR NEW.`account_id` <> OLD.`account_id`
 OR NEW.`partition` <> OLD.`partition` OR NEW.`region` <> OLD.`region`
 OR NOT EXISTS (
   SELECT 1 FROM `finops_resilience_vue_snapshots` candidate
   JOIN `finops_resilience_vue_snapshots` active ON active.`generation_id` = OLD.`active_generation_id`
   WHERE candidate.`generation_id` = NEW.`active_generation_id`
    AND candidate.`org_id` = OLD.`org_id` AND candidate.`customer_id` = OLD.`customer_id`
    AND candidate.`connection_id` = OLD.`connection_id` AND candidate.`account_id` = OLD.`account_id`
    AND candidate.`partition` = OLD.`partition` AND candidate.`region` = OLD.`region`
    AND candidate.`complete` = 1
    AND (candidate.`completed_at` > active.`completed_at`
      OR (candidate.`completed_at` = active.`completed_at` AND candidate.`generation_id` > active.`generation_id`))
 )
BEGIN SELECT RAISE(ABORT, 'FINOPS_RESILIENCE_VUE_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_heads_delete_guard`
BEFORE DELETE ON `finops_resilience_vue_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_RESILIENCE_VUE_HEAD_IMMUTABLE'); END;
