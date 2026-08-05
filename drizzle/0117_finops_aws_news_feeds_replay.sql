-- ADV-07 durable replay receipts. Public feed payloads remain in the immutable
-- snapshot store; this ledger contains only tenant scope, leases, result IDs,
-- hashes, and fixed failure categories.
CREATE TABLE `finops_aws_news_feed_replay_receipts` (
  `idempotency_key` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('IN_PROGRESS','COMPLETED','FAILED')),
  `job_id` text NOT NULL,
  `lease_token` text,
  `lease_expires_at` integer,
  `result_json` text,
  `result_sha256` text,
  `failure_code` text CHECK (`failure_code` IS NULL OR `failure_code` = 'AWS_NEWS_FEEDS_COLLECTION_FAILED'),
  `completed_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`scheduled_window`),
  CHECK (length(`idempotency_key`) BETWEEN 1 AND 512 AND instr(`idempotency_key`, char(0)) = 0),
  CHECK (length(`connection_id`) = 37 AND substr(`connection_id`,1,5) = 'conn_'),
  CHECK (length(`scheduled_window`) = 24),
  CHECK (length(`job_id`) = 36 AND substr(`job_id`,1,4) = 'job_'
    AND substr(`job_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (`lease_token` IS NULL OR (length(`lease_token`) = 38 AND substr(`lease_token`,1,6) = 'lease_'
    AND substr(`lease_token`,7) NOT GLOB '*[^a-f0-9]*')),
  CHECK (`lease_expires_at` IS NULL OR `lease_expires_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`result_json` IS NULL OR length(`result_json`) BETWEEN 2 AND 2048),
  CHECK (`result_sha256` IS NULL OR (length(`result_sha256`) = 64
    AND `result_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK (`completed_at` IS NULL OR `completed_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`updated_at` BETWEEN `created_at` AND 9007199254740991),
  CHECK ((`state` = 'IN_PROGRESS' AND `lease_token` IS NOT NULL AND `lease_expires_at` IS NOT NULL
      AND `result_json` IS NULL AND `result_sha256` IS NULL AND `failure_code` IS NULL AND `completed_at` IS NULL)
    OR (`state` = 'COMPLETED' AND `lease_token` IS NULL AND `lease_expires_at` IS NULL
      AND `result_json` IS NOT NULL AND `result_sha256` IS NOT NULL AND `failure_code` IS NULL
      AND `completed_at` IS NOT NULL)
    OR (`state` = 'FAILED' AND `lease_token` IS NULL AND `lease_expires_at` IS NULL
      AND `result_json` IS NULL AND `result_sha256` IS NULL
      AND `failure_code` = 'AWS_NEWS_FEEDS_COLLECTION_FAILED' AND `completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_aws_news_feed_replay_receipts_lease_idx`
  ON `finops_aws_news_feed_replay_receipts` (`state`,`lease_expires_at`,`updated_at`);
--> statement-breakpoint

CREATE TABLE `finops_aws_news_feed_replay_failures` (
  `failure_id` text PRIMARY KEY NOT NULL,
  `idempotency_key` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `job_id` text NOT NULL,
  `failure_code` text NOT NULL CHECK (`failure_code` = 'AWS_NEWS_FEEDS_COLLECTION_FAILED'),
  `content_sha256` text NOT NULL,
  `failed_at` integer NOT NULL,
  FOREIGN KEY (`idempotency_key`) REFERENCES `finops_aws_news_feed_replay_receipts`(`idempotency_key`) ON DELETE CASCADE,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`idempotency_key`,`job_id`,`content_sha256`),
  CHECK (length(`failure_id`) = 70 AND substr(`failure_id`,1,6) = 'newsf_'
    AND substr(`failure_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`job_id`) = 36 AND substr(`job_id`,1,4) = 'job_'
    AND substr(`job_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`failed_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `finops_aws_news_feed_replay_failures_scope_idx`
  ON `finops_aws_news_feed_replay_failures`
  (`org_id`,`customer_id`,`connection_id`,`failed_at` DESC,`failure_id` DESC);
--> statement-breakpoint

CREATE TRIGGER `finops_aws_news_feed_replay_receipts_identity_guard`
BEFORE UPDATE ON `finops_aws_news_feed_replay_receipts`
WHEN NEW.`idempotency_key` <> OLD.`idempotency_key` OR NEW.`org_id` <> OLD.`org_id`
  OR NEW.`customer_id` <> OLD.`customer_id` OR NEW.`connection_id` <> OLD.`connection_id`
  OR NEW.`scheduled_window` <> OLD.`scheduled_window` OR NEW.`created_at` <> OLD.`created_at`
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_NEWS_FEED_REPLAY_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_replay_receipts_transition_guard`
BEFORE UPDATE ON `finops_aws_news_feed_replay_receipts`
WHEN NOT (
  (OLD.`state` = 'IN_PROGRESS' AND NEW.`state` IN ('COMPLETED','FAILED')
    AND NEW.`job_id` = OLD.`job_id` AND NEW.`updated_at` >= OLD.`updated_at`)
  OR (OLD.`state` = 'IN_PROGRESS' AND OLD.`lease_expires_at` <= NEW.`updated_at` AND NEW.`state` = 'IN_PROGRESS')
  OR (OLD.`state` = 'FAILED' AND NEW.`state` = 'IN_PROGRESS'
    AND NEW.`updated_at` >= OLD.`updated_at`)
)
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_NEWS_FEED_REPLAY_TRANSITION_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_replay_receipts_delete_guard`
BEFORE DELETE ON `finops_aws_news_feed_replay_receipts`
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_NEWS_FEED_REPLAY_RECEIPT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_replay_failures_update_guard`
BEFORE UPDATE ON `finops_aws_news_feed_replay_failures`
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_NEWS_FEED_REPLAY_FAILURE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_news_feed_replay_failures_delete_guard`
BEFORE DELETE ON `finops_aws_news_feed_replay_failures`
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_NEWS_FEED_REPLAY_FAILURE_IMMUTABLE'); END;
