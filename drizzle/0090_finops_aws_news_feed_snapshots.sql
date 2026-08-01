-- Immutable AWS News Feeds dashboard projections. Only snapshots normalized by
-- lib/finops-aws-news-feeds.ts are accepted by the repository. A partial,
-- failed, or stale generation remains visible in history but cannot replace the
-- fresh complete head.
CREATE TABLE `finops_aws_news_feed_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `capture_id` text NOT NULL,
  `catalog_id` text NOT NULL,
  `source_state` text NOT NULL CHECK (`source_state` IN ('READY','PARTIAL','STALE','FAILED')),
  `coverage` text NOT NULL CHECK (`coverage` IN ('COMPLETE','PARTIAL','UNKNOWN')),
  `content_sha256` text NOT NULL,
  `snapshot_json` text NOT NULL,
  `observed_at` text NOT NULL,
  `sources_succeeded` integer NOT NULL CHECK (`sources_succeeded` BETWEEN 0 AND 5),
  `sources_failed` integer NOT NULL CHECK (`sources_failed` BETWEEN 0 AND 5),
  `sources_truncated` integer NOT NULL CHECK (`sources_truncated` BETWEEN 0 AND 5),
  `accepted_item_count` integer NOT NULL CHECK (`accepted_item_count` BETWEEN 0 AND 2000),
  `deduplicated_item_count` integer NOT NULL CHECK (`deduplicated_item_count` BETWEEN 0 AND 2000),
  `relevant_item_count` integer NOT NULL CHECK (`relevant_item_count` BETWEEN 0 AND 1000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `generation_id`),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `capture_id`),
  CHECK (length(`generation_id`) = 70 AND substr(`generation_id`, 1, 6) = 'newsg_'
    AND substr(`generation_id`, 7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`capture_id`) = 69 AND substr(`capture_id`, 1, 5) = 'news_'
    AND substr(`capture_id`, 6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`catalog_id`) = 72 AND substr(`catalog_id`, 1, 8) = 'catalog_'
    AND substr(`catalog_id`, 9) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`snapshot_json`) BETWEEN 2 AND 8388608),
  CHECK (length(`observed_at`) = 24),
  CHECK (`sources_succeeded` + `sources_failed` = 5),
  CHECK (`sources_truncated` <= `sources_succeeded`),
  CHECK (`deduplicated_item_count` <= `accepted_item_count`),
  CHECK (`relevant_item_count` <= `deduplicated_item_count`),
  CHECK (`source_state` <> 'READY' OR (
    `coverage` = 'COMPLETE' AND `sources_succeeded` = 5
    AND `sources_failed` = 0 AND `sources_truncated` = 0
  ))
);
--> statement-breakpoint
CREATE INDEX `finops_aws_news_feed_snapshots_history_idx`
  ON `finops_aws_news_feed_snapshots`
  (`org_id`, `customer_id`, `connection_id`, `observed_at` DESC, `generation_id` DESC);
--> statement-breakpoint

CREATE TABLE `finops_aws_news_feed_snapshot_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL,
  `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_aws_news_feed_snapshots`(`generation_id`),
  UNIQUE (`active_generation_id`)
);
--> statement-breakpoint

CREATE TRIGGER `finops_aws_news_feed_snapshots_update_guard`
BEFORE UPDATE ON `finops_aws_news_feed_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_NEWS_FEED_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_snapshots_delete_guard`
BEFORE DELETE ON `finops_aws_news_feed_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_NEWS_FEED_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_heads_insert_guard`
BEFORE INSERT ON `finops_aws_news_feed_snapshot_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_aws_news_feed_snapshots` candidate
   WHERE candidate.`generation_id` = NEW.`active_generation_id`
     AND candidate.`org_id` = NEW.`org_id`
     AND candidate.`customer_id` = NEW.`customer_id`
     AND candidate.`connection_id` = NEW.`connection_id`
     AND candidate.`source_state` = 'READY'
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_NEWS_FEED_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_heads_update_guard`
BEFORE UPDATE ON `finops_aws_news_feed_snapshot_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`connection_id` <> OLD.`connection_id`
  OR NOT EXISTS (
    SELECT 1 FROM `finops_aws_news_feed_snapshots` candidate
    JOIN `finops_aws_news_feed_snapshots` active
      ON active.`generation_id` = OLD.`active_generation_id`
   WHERE candidate.`generation_id` = NEW.`active_generation_id`
     AND candidate.`org_id` = OLD.`org_id`
     AND candidate.`customer_id` = OLD.`customer_id`
     AND candidate.`connection_id` = OLD.`connection_id`
     AND candidate.`source_state` = 'READY'
     AND candidate.`observed_at` > active.`observed_at`
  )
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_NEWS_FEED_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_heads_delete_guard`
BEFORE DELETE ON `finops_aws_news_feed_snapshot_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_AWS_NEWS_FEED_HEAD_IMMUTABLE'); END;
