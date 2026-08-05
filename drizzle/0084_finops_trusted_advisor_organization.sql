-- Server-owned Trusted Advisor Organizational collection manifests. The
-- account set is frozen before fan-out and is never accepted from an API body.
CREATE TABLE `finops_ta_collection_manifests` (
  `manifest_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `anchor_connection_id` text NOT NULL,
  `job_id` text NOT NULL,
  `taxonomy_snapshot_id` text NOT NULL,
  `taxonomy_sha256` text NOT NULL,
  `account_set_sha256` text NOT NULL,
  `expected_account_count` integer NOT NULL,
  `status` text NOT NULL CHECK (`status` IN (
    'pending', 'collecting', 'finalizing', 'complete', 'partial', 'failed'
  )),
  `created_at` integer NOT NULL,
  `started_at` integer,
  `finalized_at` integer,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`anchor_connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `anchor_connection_id`, `job_id`),
  UNIQUE (`org_id`, `customer_id`, `anchor_connection_id`, `manifest_id`),
  CHECK (length(`manifest_id`) = 68 AND substr(`manifest_id`, 1, 4) = 'tam_'
    AND substr(`manifest_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`job_id`) BETWEEN 1 AND 256),
  CHECK (length(`taxonomy_snapshot_id`) BETWEEN 1 AND 256),
  CHECK (length(`taxonomy_sha256`) = 64 AND `taxonomy_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_set_sha256`) = 64 AND `account_set_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`expected_account_count` BETWEEN 1 AND 10000),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`started_at` IS NULL OR `started_at` BETWEEN `created_at` AND 9007199254740991),
  CHECK (`finalized_at` IS NULL OR (`started_at` IS NOT NULL AND `finalized_at` >= `started_at`)),
  CHECK ((`status` = 'pending' AND `started_at` IS NULL AND `finalized_at` IS NULL)
    OR (`status` IN ('collecting', 'finalizing') AND `started_at` IS NOT NULL AND `finalized_at` IS NULL)
    OR (`status` IN ('complete', 'partial', 'failed') AND `started_at` IS NOT NULL AND `finalized_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_ta_manifests_scope_time_idx` ON `finops_ta_collection_manifests`
  (`org_id`, `customer_id`, `anchor_connection_id`, `created_at` DESC, `manifest_id` DESC);
--> statement-breakpoint

CREATE TABLE `finops_ta_manifest_accounts` (
  `manifest_id` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `anchor_connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `account_position` integer NOT NULL,
  `target_connection_id` text,
  `status` text NOT NULL CHECK (`status` IN (
    'pending', 'running', 'accepted', 'partial', 'failed', 'unconfigured'
  )),
  `account_snapshot_id` text,
  `error_code` text,
  `started_at` integer,
  `finished_at` integer,
  PRIMARY KEY (`manifest_id`, `account_id`),
  FOREIGN KEY (`manifest_id`) REFERENCES `finops_ta_collection_manifests`(`manifest_id`),
  FOREIGN KEY (`target_connection_id`) REFERENCES `aws_connections`(`id`),
  UNIQUE (`manifest_id`, `account_position`),
  CHECK (length(`account_id`) = 12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (`account_position` BETWEEN 0 AND 9999),
  CHECK (`target_connection_id` IS NULL OR
    (length(`target_connection_id`) = 37 AND substr(`target_connection_id`, 1, 5) = 'conn_')),
  CHECK (`account_snapshot_id` IS NULL OR
    (length(`account_snapshot_id`) = 68 AND substr(`account_snapshot_id`, 1, 4) = 'tas_'
      AND substr(`account_snapshot_id`, 5) NOT GLOB '*[^a-f0-9]*')),
  CHECK (`error_code` IS NULL OR (length(`error_code`) BETWEEN 1 AND 96
    AND `error_code` NOT GLOB '*[^A-Z0-9_]*')),
  CHECK (`started_at` IS NULL OR `started_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`finished_at` IS NULL OR `status` = 'unconfigured'
    OR (`started_at` IS NOT NULL AND `finished_at` >= `started_at`)),
  CHECK ((`status` = 'pending' AND `started_at` IS NULL AND `finished_at` IS NULL
      AND `account_snapshot_id` IS NULL AND `error_code` IS NULL)
    OR (`status` = 'running' AND `started_at` IS NOT NULL AND `finished_at` IS NULL
      AND `account_snapshot_id` IS NULL AND `error_code` IS NULL)
    OR (`status` = 'accepted' AND `started_at` IS NOT NULL AND `finished_at` IS NOT NULL
      AND `account_snapshot_id` IS NOT NULL AND `error_code` IS NULL)
    OR (`status` = 'partial' AND `started_at` IS NOT NULL AND `finished_at` IS NOT NULL
      AND `account_snapshot_id` IS NOT NULL AND `error_code` IS NOT NULL)
    OR (`status` = 'failed' AND `started_at` IS NOT NULL AND `finished_at` IS NOT NULL
      AND `account_snapshot_id` IS NULL AND `error_code` IS NOT NULL)
    OR (`status` = 'unconfigured' AND `started_at` IS NULL AND `finished_at` IS NOT NULL
      AND `account_snapshot_id` IS NULL AND `error_code` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_ta_manifest_accounts_status_idx`
  ON `finops_ta_manifest_accounts` (`manifest_id`, `status`, `account_position`);
--> statement-breakpoint

CREATE TABLE `finops_ta_account_snapshots` (
  `account_snapshot_id` text PRIMARY KEY NOT NULL,
  `manifest_id` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `anchor_connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('complete', 'partial')),
  `content_sha256` text NOT NULL,
  `collected_at` text NOT NULL,
  `data_through_at` text,
  `check_count` integer NOT NULL,
  `resource_count` integer NOT NULL,
  `rejected_record_count` integer NOT NULL,
  `evidence_reference_ciphertext` text NOT NULL,
  `evidence_reference_key_version` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`manifest_id`, `account_id`) REFERENCES `finops_ta_manifest_accounts`(`manifest_id`, `account_id`),
  UNIQUE (`manifest_id`, `account_id`),
  UNIQUE (`manifest_id`, `account_snapshot_id`),
  CHECK (length(`account_snapshot_id`) = 68 AND substr(`account_snapshot_id`, 1, 4) = 'tas_'
    AND substr(`account_snapshot_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`collected_at`) = 24),
  CHECK (`data_through_at` IS NULL OR (length(`data_through_at`) = 24 AND `data_through_at` <= `collected_at`)),
  CHECK (`check_count` BETWEEN 0 AND 512),
  CHECK (`resource_count` BETWEEN 0 AND 25000),
  CHECK (`rejected_record_count` BETWEEN 0 AND 25000),
  CHECK (`status` <> 'complete' OR (`data_through_at` IS NOT NULL AND `rejected_record_count` = 0)),
  CHECK (length(`evidence_reference_ciphertext`) BETWEEN 32 AND 8192
    AND substr(`evidence_reference_ciphertext`, 1, 6) = 'fsev1.'
    AND substr(`evidence_reference_ciphertext`, 7) NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (length(`evidence_reference_key_version`) BETWEEN 1 AND 128),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint

CREATE TABLE `finops_ta_check_snapshots` (
  `account_snapshot_id` text NOT NULL,
  `check_id` text NOT NULL,
  `name` text NOT NULL,
  `category` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('ok', 'warning', 'error', 'not_available')),
  `data_through_at` text,
  `processed_count` integer NOT NULL,
  `flagged_count` integer NOT NULL,
  `ignored_count` integer NOT NULL,
  `suppressed_count` integer NOT NULL,
  `content_sha256` text NOT NULL,
  PRIMARY KEY (`account_snapshot_id`, `check_id`),
  FOREIGN KEY (`account_snapshot_id`) REFERENCES `finops_ta_account_snapshots`(`account_snapshot_id`),
  CHECK (length(`check_id`) BETWEEN 1 AND 128),
  CHECK (length(`name`) BETWEEN 1 AND 512),
  CHECK (length(`category`) BETWEEN 1 AND 128),
  CHECK (`data_through_at` IS NULL OR length(`data_through_at`) = 24),
  CHECK (`processed_count` BETWEEN 0 AND 1000000000),
  CHECK (`flagged_count` BETWEEN 0 AND 25000),
  CHECK (`ignored_count` BETWEEN 0 AND 1000000000),
  CHECK (`suppressed_count` BETWEEN 0 AND 1000000000),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*')
);
--> statement-breakpoint

CREATE TABLE `finops_ta_resource_snapshots` (
  `resource_key` text PRIMARY KEY NOT NULL,
  `account_snapshot_id` text NOT NULL,
  `check_id` text NOT NULL,
  `resource_id` text NOT NULL,
  `region` text,
  `status` text NOT NULL CHECK (`status` IN ('ok', 'warning', 'error')),
  `suppressed` integer NOT NULL CHECK (`suppressed` IN (0, 1)),
  `metadata_json` text NOT NULL,
  `metadata_sha256` text NOT NULL,
  FOREIGN KEY (`account_snapshot_id`, `check_id`) REFERENCES `finops_ta_check_snapshots`(`account_snapshot_id`, `check_id`),
  UNIQUE (`account_snapshot_id`, `check_id`, `resource_key`),
  CHECK (length(`resource_key`) = 64 AND `resource_key` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`resource_id`) BETWEEN 1 AND 2048),
  CHECK (`region` IS NULL OR length(`region`) BETWEEN 1 AND 128),
  CHECK (length(`metadata_json`) BETWEEN 2 AND 1048576),
  CHECK (length(`metadata_sha256`) = 64 AND `metadata_sha256` NOT GLOB '*[^a-f0-9]*')
);
--> statement-breakpoint
CREATE INDEX `finops_ta_resources_filter_idx`
  ON `finops_ta_resource_snapshots` (`account_snapshot_id`, `check_id`, `status`, `region`, `resource_key`);
--> statement-breakpoint

CREATE TABLE `finops_ta_organization_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `manifest_id` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `anchor_connection_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('complete', 'partial', 'failed')),
  `content_sha256` text NOT NULL,
  `collected_at` text NOT NULL,
  `data_through_at` text,
  `expected_account_count` integer NOT NULL,
  `accepted_account_count` integer NOT NULL,
  `rejected_account_count` integer NOT NULL,
  `check_count` integer NOT NULL,
  `resource_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`manifest_id`) REFERENCES `finops_ta_collection_manifests`(`manifest_id`),
  UNIQUE (`org_id`, `customer_id`, `anchor_connection_id`, `generation_id`),
  UNIQUE (`manifest_id`),
  CHECK (length(`generation_id`) = 68 AND substr(`generation_id`, 1, 4) = 'tao_'
    AND substr(`generation_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`collected_at`) = 24),
  CHECK (`data_through_at` IS NULL OR (length(`data_through_at`) = 24 AND `data_through_at` <= `collected_at`)),
  CHECK (`expected_account_count` BETWEEN 1 AND 10000),
  CHECK (`accepted_account_count` BETWEEN 0 AND `expected_account_count`),
  CHECK (`rejected_account_count` = `expected_account_count` - `accepted_account_count`),
  CHECK (`check_count` BETWEEN 0 AND 5120000),
  CHECK (`resource_count` BETWEEN 0 AND 250000000),
  CHECK (`status` <> 'complete' OR (`data_through_at` IS NOT NULL
    AND `accepted_account_count` = `expected_account_count` AND `rejected_account_count` = 0)),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `finops_ta_org_snapshots_history_idx` ON `finops_ta_organization_snapshots`
  (`org_id`, `customer_id`, `anchor_connection_id`, `collected_at` DESC, `generation_id` DESC);
--> statement-breakpoint

CREATE TABLE `finops_ta_organization_snapshot_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `anchor_connection_id` text NOT NULL,
  `active_generation_id` text NOT NULL,
  `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `customer_id`, `anchor_connection_id`),
  FOREIGN KEY (`active_generation_id`) REFERENCES `finops_ta_organization_snapshots`(`generation_id`),
  UNIQUE (`active_generation_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint

CREATE TRIGGER `finops_ta_manifest_update_guard`
BEFORE UPDATE ON `finops_ta_collection_manifests`
WHEN NEW.`manifest_id` <> OLD.`manifest_id` OR NEW.`org_id` <> OLD.`org_id`
  OR NEW.`customer_id` <> OLD.`customer_id` OR NEW.`anchor_connection_id` <> OLD.`anchor_connection_id`
  OR NEW.`job_id` <> OLD.`job_id` OR NEW.`taxonomy_snapshot_id` <> OLD.`taxonomy_snapshot_id`
  OR NEW.`taxonomy_sha256` <> OLD.`taxonomy_sha256` OR NEW.`account_set_sha256` <> OLD.`account_set_sha256`
  OR NEW.`expected_account_count` <> OLD.`expected_account_count` OR NEW.`created_at` <> OLD.`created_at`
  OR NOT ((OLD.`status` = 'pending' AND NEW.`status` IN ('collecting', 'failed'))
    OR (OLD.`status` = 'collecting' AND NEW.`status` IN ('finalizing', 'partial', 'failed'))
    OR (OLD.`status` = 'finalizing' AND NEW.`status` IN ('complete', 'partial', 'failed')))
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_MANIFEST_TRANSITION_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_manifest_complete_guard`
BEFORE UPDATE ON `finops_ta_collection_manifests`
WHEN NEW.`status` = 'complete' AND (
  (SELECT count(*) FROM `finops_ta_manifest_accounts` a WHERE a.`manifest_id` = NEW.`manifest_id`)
    <> NEW.`expected_account_count`
  OR EXISTS (SELECT 1 FROM `finops_ta_manifest_accounts` a
    WHERE a.`manifest_id` = NEW.`manifest_id` AND a.`status` <> 'accepted')
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_MANIFEST_INCOMPLETE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_manifest_delete_guard` BEFORE DELETE ON `finops_ta_collection_manifests`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_MANIFEST_IMMUTABLE'); END;
--> statement-breakpoint

CREATE TRIGGER `finops_ta_manifest_account_update_guard`
BEFORE UPDATE ON `finops_ta_manifest_accounts`
WHEN NEW.`manifest_id` <> OLD.`manifest_id` OR NEW.`org_id` <> OLD.`org_id`
  OR NEW.`customer_id` <> OLD.`customer_id` OR NEW.`anchor_connection_id` <> OLD.`anchor_connection_id`
  OR NEW.`account_id` <> OLD.`account_id` OR NEW.`account_position` <> OLD.`account_position`
  OR NEW.`target_connection_id` IS NOT OLD.`target_connection_id`
  OR NOT ((OLD.`status` = 'pending' AND NEW.`status` IN ('running', 'failed', 'unconfigured'))
    OR (OLD.`status` = 'running' AND NEW.`status` IN ('accepted', 'partial', 'failed')))
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_ACCOUNT_TRANSITION_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_manifest_account_accept_guard`
BEFORE UPDATE ON `finops_ta_manifest_accounts`
WHEN NEW.`status` IN ('accepted', 'partial') AND NOT EXISTS (
  SELECT 1 FROM `finops_ta_account_snapshots` s
   WHERE s.`manifest_id` = NEW.`manifest_id` AND s.`account_id` = NEW.`account_id`
     AND s.`account_snapshot_id` = NEW.`account_snapshot_id`
     AND ((NEW.`status` = 'accepted' AND s.`status` = 'complete')
       OR (NEW.`status` = 'partial' AND s.`status` = 'partial'))
     AND s.`check_count` = (SELECT count(*) FROM `finops_ta_check_snapshots` c
       WHERE c.`account_snapshot_id` = s.`account_snapshot_id`)
     AND s.`resource_count` = (SELECT count(*) FROM `finops_ta_resource_snapshots` r
       WHERE r.`account_snapshot_id` = s.`account_snapshot_id`)
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_ACCOUNT_SNAPSHOT_NOT_ACCEPTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_manifest_account_delete_guard` BEFORE DELETE ON `finops_ta_manifest_accounts`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_MANIFEST_ACCOUNT_IMMUTABLE'); END;
--> statement-breakpoint

CREATE TRIGGER `finops_ta_account_snapshot_immutable_update` BEFORE UPDATE ON `finops_ta_account_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_ACCOUNT_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_account_snapshot_immutable_delete` BEFORE DELETE ON `finops_ta_account_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_ACCOUNT_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_check_snapshot_immutable_update` BEFORE UPDATE ON `finops_ta_check_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_CHECK_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_check_snapshot_immutable_delete` BEFORE DELETE ON `finops_ta_check_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_CHECK_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_resource_snapshot_immutable_update` BEFORE UPDATE ON `finops_ta_resource_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_RESOURCE_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_resource_snapshot_immutable_delete` BEFORE DELETE ON `finops_ta_resource_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_RESOURCE_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_org_snapshot_immutable_update` BEFORE UPDATE ON `finops_ta_organization_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_ORGANIZATION_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_org_snapshot_immutable_delete` BEFORE DELETE ON `finops_ta_organization_snapshots`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_ORGANIZATION_SNAPSHOT_IMMUTABLE'); END;
--> statement-breakpoint

CREATE TRIGGER `finops_ta_org_snapshot_complete_guard`
BEFORE INSERT ON `finops_ta_organization_snapshots`
WHEN NEW.`status` = 'complete' AND NOT EXISTS (
  SELECT 1 FROM `finops_ta_collection_manifests` m
   WHERE m.`manifest_id` = NEW.`manifest_id` AND m.`status` = 'finalizing'
     AND m.`org_id` = NEW.`org_id` AND m.`customer_id` = NEW.`customer_id`
     AND m.`anchor_connection_id` = NEW.`anchor_connection_id`
     AND m.`expected_account_count` = NEW.`expected_account_count`
     AND NEW.`accepted_account_count` = m.`expected_account_count`
     AND NOT EXISTS (SELECT 1 FROM `finops_ta_manifest_accounts` a
       WHERE a.`manifest_id` = m.`manifest_id` AND a.`status` <> 'accepted')
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_ORGANIZATION_SNAPSHOT_INCOMPLETE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_org_head_insert_guard`
BEFORE INSERT ON `finops_ta_organization_snapshot_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_ta_organization_snapshots` s
  WHERE s.`generation_id` = NEW.`active_generation_id` AND s.`org_id` = NEW.`org_id`
    AND s.`customer_id` = NEW.`customer_id` AND s.`anchor_connection_id` = NEW.`anchor_connection_id`
    AND s.`status` = 'complete' AND s.`created_at` <= NEW.`advanced_at`)
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_HEAD_SNAPSHOT_NOT_ACCEPTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_org_head_update_guard`
BEFORE UPDATE ON `finops_ta_organization_snapshot_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`anchor_connection_id` <> OLD.`anchor_connection_id` OR NEW.`advanced_at` < OLD.`advanced_at`
  OR NOT EXISTS (
    SELECT 1 FROM `finops_ta_organization_snapshots` candidate
    JOIN `finops_ta_organization_snapshots` active ON active.`generation_id` = OLD.`active_generation_id`
    WHERE candidate.`generation_id` = NEW.`active_generation_id` AND candidate.`status` = 'complete'
      AND candidate.`org_id` = NEW.`org_id` AND candidate.`customer_id` = NEW.`customer_id`
      AND candidate.`anchor_connection_id` = NEW.`anchor_connection_id`
      AND (candidate.`data_through_at` > active.`data_through_at`
        OR (candidate.`data_through_at` = active.`data_through_at`
          AND candidate.`collected_at` > active.`collected_at`))
  )
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_HEAD_ADVANCE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_ta_org_head_delete_guard` BEFORE DELETE ON `finops_ta_organization_snapshot_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_TA_HEAD_IMMUTABLE'); END;
