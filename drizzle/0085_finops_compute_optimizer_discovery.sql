-- Immutable, tenant-scoped AWS Compute Optimizer organization discovery.
-- This stores enrollment/member/export-job metadata only. It never grants
-- export or S3 authority and partial discoveries never advance the active head.
CREATE TABLE `finops_co_discovery_runs` (
  `run_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `job_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `region` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('pending','running','complete','partial','unavailable')),
  `content_sha256` text,
  `collected_at` text,
  `data_through_at` text,
  `enrollment_status` text CHECK (`enrollment_status` IS NULL OR `enrollment_status` IN ('ACTIVE','INACTIVE','PENDING','FAILED')),
  `enrollment_reason_code` text,
  `member_accounts_enrolled` integer CHECK (`member_accounts_enrolled` IS NULL OR `member_accounts_enrolled` IN (0,1)),
  `number_of_member_accounts_opted_in` integer,
  `enrollment_last_updated_at` text,
  `member_count` integer NOT NULL DEFAULT 0,
  `export_job_count` integer NOT NULL DEFAULT 0,
  `coverage_count` integer NOT NULL DEFAULT 0,
  `error_code` text,
  `limitations_json` text,
  `evidence_reference_ciphertext` text,
  `evidence_reference_key_version` text,
  `created_at` integer NOT NULL,
  `started_at` integer,
  `finalized_at` integer,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `job_id`),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `run_id`),
  CHECK (length(`run_id`) = 68 AND substr(`run_id`, 1, 4) = 'cor_' AND substr(`run_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`job_id`) BETWEEN 1 AND 256),
  CHECK (length(`account_id`) = 12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`region`) BETWEEN 9 AND 32),
  CHECK (`content_sha256` IS NULL OR (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK (`member_count` BETWEEN 0 AND 1000),
  CHECK (`export_job_count` BETWEEN 0 AND 5000),
  CHECK (`coverage_count` BETWEEN 0 AND 3),
  CHECK (`number_of_member_accounts_opted_in` IS NULL OR `number_of_member_accounts_opted_in` BETWEEN 0 AND 1000000000),
  CHECK (`error_code` IS NULL OR (length(`error_code`) BETWEEN 1 AND 96 AND `error_code` NOT GLOB '*[^A-Z0-9_]*')),
  CHECK (`limitations_json` IS NULL OR length(`limitations_json`) BETWEEN 2 AND 8192),
  CHECK (`evidence_reference_ciphertext` IS NULL OR (length(`evidence_reference_ciphertext`) BETWEEN 32 AND 8192 AND `evidence_reference_ciphertext` GLOB 'fsev1.*')),
  CHECK (`evidence_reference_key_version` IS NULL OR length(`evidence_reference_key_version`) BETWEEN 1 AND 128),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`started_at` IS NULL OR `started_at` BETWEEN `created_at` AND 9007199254740991),
  CHECK (`finalized_at` IS NULL OR (`started_at` IS NOT NULL AND `finalized_at` >= `started_at`)),
  CHECK ((`status` = 'pending' AND `started_at` IS NULL AND `finalized_at` IS NULL AND `content_sha256` IS NULL)
    OR (`status` = 'running' AND `started_at` IS NOT NULL AND `finalized_at` IS NULL AND `content_sha256` IS NULL)
    OR (`status` IN ('complete','partial','unavailable') AND `started_at` IS NOT NULL AND `finalized_at` IS NOT NULL
      AND `content_sha256` IS NOT NULL AND `collected_at` IS NOT NULL AND `limitations_json` IS NOT NULL
      AND `evidence_reference_ciphertext` IS NOT NULL AND `evidence_reference_key_version` IS NOT NULL)),
  CHECK (`status` <> 'complete' OR (`error_code` IS NULL AND `data_through_at` IS NOT NULL AND `limitations_json` = '[]')),
  CHECK (`status` <> 'partial' OR `error_code` IS NOT NULL),
  CHECK (`status` <> 'unavailable' OR (`error_code` IS NOT NULL AND `member_count` = 0 AND `export_job_count` = 0))
);
--> statement-breakpoint
CREATE INDEX `finops_co_runs_history_idx` ON `finops_co_discovery_runs`
  (`org_id`, `customer_id`, `connection_id`, `finalized_at` DESC, `run_id` DESC);
--> statement-breakpoint

CREATE TABLE `finops_co_member_enrollments` (
  `run_id` text NOT NULL REFERENCES `finops_co_discovery_runs`(`run_id`),
  `account_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('ACTIVE','INACTIVE','PENDING','FAILED')),
  `reason_code` text,
  `last_updated_at` text,
  PRIMARY KEY (`run_id`, `account_id`),
  CHECK (length(`account_id`) = 12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (`reason_code` IS NULL OR length(`reason_code`) BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE `finops_co_export_jobs` (
  `run_id` text NOT NULL REFERENCES `finops_co_discovery_runs`(`run_id`),
  `job_id` text NOT NULL,
  `resource_type` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('QUEUED','IN_PROGRESS','COMPLETE','FAILED')),
  `created_at_iso` text NOT NULL,
  `last_updated_at_iso` text NOT NULL,
  `failure_code` text,
  `bucket_sha256` text,
  `object_key_sha256` text,
  `metadata_key_sha256` text,
  PRIMARY KEY (`run_id`, `job_id`),
  CHECK (length(`job_id`) BETWEEN 1 AND 128),
  CHECK (length(`resource_type`) BETWEEN 1 AND 128),
  CHECK (`bucket_sha256` IS NULL OR (length(`bucket_sha256`) = 64 AND `bucket_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK (`object_key_sha256` IS NULL OR (length(`object_key_sha256`) = 64 AND `object_key_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK (`metadata_key_sha256` IS NULL OR (length(`metadata_key_sha256`) = 64 AND `metadata_key_sha256` NOT GLOB '*[^a-f0-9]*'))
);
--> statement-breakpoint
CREATE TABLE `finops_co_discovery_coverage` (
  `run_id` text NOT NULL REFERENCES `finops_co_discovery_runs`(`run_id`),
  `operation` text NOT NULL CHECK (`operation` IN ('GET_ENROLLMENT_STATUS','GET_ENROLLMENT_STATUSES_FOR_ORGANIZATION','DESCRIBE_RECOMMENDATION_EXPORT_JOBS')),
  `status` text NOT NULL CHECK (`status` IN ('SUCCEEDED','PARTIAL','FAILED')),
  `pages_observed` integer NOT NULL,
  `records_observed` integer NOT NULL,
  `records_accepted` integer NOT NULL,
  `records_rejected` integer NOT NULL,
  `records_omitted` integer NOT NULL,
  `error_code` text,
  PRIMARY KEY (`run_id`, `operation`),
  CHECK (`pages_observed` BETWEEN 0 AND 10),
  CHECK (`records_observed` BETWEEN 0 AND 1000000000),
  CHECK (`records_accepted` BETWEEN 0 AND 1000000000),
  CHECK (`records_rejected` BETWEEN 0 AND 1000000000),
  CHECK (`records_omitted` BETWEEN 0 AND 1000000000)
);
--> statement-breakpoint
CREATE TABLE `finops_co_discovery_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_run_id` text NOT NULL UNIQUE REFERENCES `finops_co_discovery_runs`(`run_id`),
  `advanced_at` integer NOT NULL CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`)
);
--> statement-breakpoint

CREATE TRIGGER `finops_co_run_update_guard` BEFORE UPDATE ON `finops_co_discovery_runs`
WHEN NEW.`run_id` <> OLD.`run_id` OR NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`connection_id` <> OLD.`connection_id` OR NEW.`job_id` <> OLD.`job_id`
  OR NEW.`account_id` <> OLD.`account_id` OR NEW.`partition` <> OLD.`partition` OR NEW.`region` <> OLD.`region`
  OR NEW.`created_at` <> OLD.`created_at`
  OR NOT ((OLD.`status` = 'pending' AND NEW.`status` = 'running')
    OR (OLD.`status` = 'running' AND NEW.`status` IN ('complete','partial','unavailable')))
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_RUN_TRANSITION_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_run_finalize_guard` BEFORE UPDATE ON `finops_co_discovery_runs`
WHEN OLD.`status` = 'running' AND NEW.`status` IN ('complete','partial','unavailable') AND (
  NEW.`member_count` <> (SELECT count(*) FROM `finops_co_member_enrollments` m WHERE m.`run_id` = NEW.`run_id`)
  OR NEW.`export_job_count` <> (SELECT count(*) FROM `finops_co_export_jobs` j WHERE j.`run_id` = NEW.`run_id`)
  OR NEW.`coverage_count` <> (SELECT count(*) FROM `finops_co_discovery_coverage` c WHERE c.`run_id` = NEW.`run_id`)
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_MATERIALIZATION_INCOMPLETE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_complete_binding_guard` BEFORE UPDATE ON `finops_co_discovery_runs`
WHEN OLD.`status` = 'running' AND NEW.`status` = 'complete'
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_EXPORT_OBJECT_BINDING_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_run_delete_guard` BEFORE DELETE ON `finops_co_discovery_runs`
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_member_insert_guard` BEFORE INSERT ON `finops_co_member_enrollments`
WHEN NOT EXISTS (SELECT 1 FROM `finops_co_discovery_runs` r WHERE r.`run_id` = NEW.`run_id` AND r.`status` = 'running')
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_RUN_NOT_RUNNING'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_insert_guard` BEFORE INSERT ON `finops_co_export_jobs`
WHEN NOT EXISTS (SELECT 1 FROM `finops_co_discovery_runs` r WHERE r.`run_id` = NEW.`run_id` AND r.`status` = 'running')
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_RUN_NOT_RUNNING'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_coverage_insert_guard` BEFORE INSERT ON `finops_co_discovery_coverage`
WHEN NOT EXISTS (SELECT 1 FROM `finops_co_discovery_runs` r WHERE r.`run_id` = NEW.`run_id` AND r.`status` = 'running')
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_RUN_NOT_RUNNING'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_member_update_guard` BEFORE UPDATE ON `finops_co_member_enrollments` BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_member_delete_guard` BEFORE DELETE ON `finops_co_member_enrollments` BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_update_guard` BEFORE UPDATE ON `finops_co_export_jobs` BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_delete_guard` BEFORE DELETE ON `finops_co_export_jobs` BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_coverage_update_guard` BEFORE UPDATE ON `finops_co_discovery_coverage` BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_coverage_delete_guard` BEFORE DELETE ON `finops_co_discovery_coverage` BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_head_insert_guard` BEFORE INSERT ON `finops_co_discovery_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_co_discovery_runs` r WHERE r.`run_id` = NEW.`active_run_id`
  AND r.`org_id` = NEW.`org_id` AND r.`customer_id` = NEW.`customer_id` AND r.`connection_id` = NEW.`connection_id` AND r.`status` = 'complete')
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_HEAD_ADVANCE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_head_update_guard` BEFORE UPDATE ON `finops_co_discovery_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id` OR NEW.`connection_id` <> OLD.`connection_id`
  OR NOT EXISTS (SELECT 1 FROM `finops_co_discovery_runs` r WHERE r.`run_id` = NEW.`active_run_id`
    AND r.`org_id` = NEW.`org_id` AND r.`customer_id` = NEW.`customer_id` AND r.`connection_id` = NEW.`connection_id` AND r.`status` = 'complete')
BEGIN SELECT RAISE(ABORT, 'FINOPS_CO_HEAD_ADVANCE_REJECTED'); END;
