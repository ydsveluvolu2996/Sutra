-- Durable, tenant-scoped Data Collection Monitor attempts.
-- Identity and queue evidence are immutable; only the bounded lifecycle
-- queued -> running -> terminal may update a row.
CREATE TABLE `finops_source_job_attempts` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `source_id` text NOT NULL,
  `job_id` text NOT NULL,
  `attempt` integer NOT NULL CHECK (`attempt` BETWEEN 1 AND 100),
  `idempotency_key` text NOT NULL,
  `status` text NOT NULL CHECK (
    `status` IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')
  ),
  `queued_at` text NOT NULL,
  `started_at` text,
  `finished_at` text,
  `accepted_records` integer,
  `rejected_records` integer,
  `expected_records` integer,
  `processed_bytes` integer,
  `reconciliation_outcome` text CHECK (
    `reconciliation_outcome` IS NULL
    OR `reconciliation_outcome` IN ('matched', 'mismatched')
  ),
  `reconciliation_evidence_reference` text,
  `error_code` text CHECK (
    `error_code` IS NULL OR `error_code` IN (
      'AUTHORIZATION_FAILED',
      'SOURCE_UNAVAILABLE',
      'THROTTLED',
      'TIMEOUT',
      'SCHEMA_MISMATCH',
      'RECONCILIATION_FAILED',
      'CANCELLED',
      'INTERNAL_ERROR'
    )
  ),
  `error_message` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY (
    `org_id`, `customer_id`, `connection_id`, `source_id`, `job_id`, `attempt`
  ),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (
    `org_id`, `customer_id`, `connection_id`, `source_id`, `idempotency_key`
  ),
  CHECK (length(`org_id`) BETWEEN 1 AND 256),
  CHECK (length(`customer_id`) BETWEEN 1 AND 256),
  CHECK (length(`connection_id`) BETWEEN 1 AND 256),
  CHECK (length(`source_id`) BETWEEN 1 AND 64),
  CHECK (length(`job_id`) BETWEEN 1 AND 256),
  CHECK (length(`idempotency_key`) BETWEEN 1 AND 256),
  CHECK (length(`queued_at`) = 24),
  CHECK (`started_at` IS NULL OR length(`started_at`) = 24),
  CHECK (`finished_at` IS NULL OR length(`finished_at`) = 24),
  CHECK (`started_at` IS NULL OR `started_at` >= `queued_at`),
  CHECK (
    `finished_at` IS NULL
    OR (`started_at` IS NOT NULL AND `finished_at` >= `started_at`)
  ),
  CHECK (
    (`status` = 'queued' AND `started_at` IS NULL AND `finished_at` IS NULL)
    OR (`status` = 'running' AND `started_at` IS NOT NULL AND `finished_at` IS NULL)
    OR (
      `status` IN ('succeeded', 'partial', 'failed', 'cancelled')
      AND `started_at` IS NOT NULL
      AND `finished_at` IS NOT NULL
    )
  ),
  CHECK (
    (`accepted_records` IS NULL OR `accepted_records` BETWEEN 0 AND 9007199254740991)
    AND (`rejected_records` IS NULL OR `rejected_records` BETWEEN 0 AND 9007199254740991)
    AND (`expected_records` IS NULL OR `expected_records` BETWEEN 0 AND 9007199254740991)
    AND (`processed_bytes` IS NULL OR `processed_bytes` BETWEEN 0 AND 9007199254740991)
  ),
  CHECK (
    `expected_records` IS NULL
    OR `accepted_records` IS NULL
    OR `rejected_records` IS NULL
    OR `accepted_records` + `rejected_records` <= `expected_records`
  ),
  CHECK (
    (`reconciliation_outcome` IS NULL AND `reconciliation_evidence_reference` IS NULL)
    OR (
      `reconciliation_outcome` IS NOT NULL
      AND `reconciliation_evidence_reference` IS NOT NULL
      AND length(`reconciliation_evidence_reference`) BETWEEN 1 AND 1024
    )
  ),
  CHECK (
    (`error_code` IS NULL AND `error_message` IS NULL)
    OR (`error_code` = 'AUTHORIZATION_FAILED'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'Collection authorization was rejected')
    OR (`error_code` = 'SOURCE_UNAVAILABLE'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'The configured collection source was unavailable')
    OR (`error_code` = 'THROTTLED'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'Collection was delayed by a bounded service quota')
    OR (`error_code` = 'TIMEOUT'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'Collection exceeded its bounded execution window')
    OR (`error_code` = 'SCHEMA_MISMATCH'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'Collected data did not match the accepted schema')
    OR (`error_code` = 'RECONCILIATION_FAILED'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'Collected data did not pass reconciliation')
    OR (`error_code` = 'CANCELLED'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'Collection was cancelled')
    OR (`error_code` = 'INTERNAL_ERROR'
      AND `error_message` IS NOT NULL
      AND `error_message` = 'Collection failed because of an internal processing error')
  ),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`status` <> 'failed' OR `error_code` IS NOT NULL),
  CHECK (`status` <> 'cancelled' OR `error_code` = 'CANCELLED'),
  CHECK (`error_code` <> 'CANCELLED' OR `status` = 'cancelled'),
  CHECK (`status` <> 'succeeded' OR (
    `error_code` IS NULL
    AND COALESCE(`reconciliation_outcome`, 'matched') <> 'mismatched'
  )),
  CHECK (
    `status` NOT IN ('queued', 'running')
    OR (
      `accepted_records` IS NULL
      AND `rejected_records` IS NULL
      AND `expected_records` IS NULL
      AND `processed_bytes` IS NULL
      AND `reconciliation_outcome` IS NULL
      AND `reconciliation_evidence_reference` IS NULL
      AND `error_code` IS NULL
      AND `error_message` IS NULL
    )
  )
);
--> statement-breakpoint
CREATE INDEX `finops_source_job_attempts_scope_page_idx`
  ON `finops_source_job_attempts` (
    `org_id`, `customer_id`, `connection_id`,
    `queued_at` DESC, `source_id` DESC, `job_id` DESC, `attempt` DESC
  );
--> statement-breakpoint
CREATE INDEX `finops_source_job_attempts_scope_source_health_idx`
  ON `finops_source_job_attempts` (
    `org_id`, `customer_id`, `connection_id`,
    `source_id`, `status`, `queued_at` DESC
  );
--> statement-breakpoint
CREATE TRIGGER `finops_source_job_attempts_identity_immutable`
BEFORE UPDATE ON `finops_source_job_attempts`
WHEN
  NEW.`org_id` <> OLD.`org_id`
  OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`connection_id` <> OLD.`connection_id`
  OR NEW.`source_id` <> OLD.`source_id`
  OR NEW.`job_id` <> OLD.`job_id`
  OR NEW.`attempt` <> OLD.`attempt`
  OR NEW.`idempotency_key` <> OLD.`idempotency_key`
  OR NEW.`queued_at` <> OLD.`queued_at`
  OR NEW.`created_at` <> OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_JOB_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_source_job_attempts_transition_guard`
BEFORE UPDATE ON `finops_source_job_attempts`
WHEN
  NEW.`org_id` = OLD.`org_id`
  AND NEW.`customer_id` = OLD.`customer_id`
  AND NEW.`connection_id` = OLD.`connection_id`
  AND NEW.`source_id` = OLD.`source_id`
  AND NEW.`job_id` = OLD.`job_id`
  AND NEW.`attempt` = OLD.`attempt`
  AND NEW.`idempotency_key` = OLD.`idempotency_key`
  AND NEW.`queued_at` = OLD.`queued_at`
  AND NEW.`created_at` = OLD.`created_at`
  AND NOT (
  (
    OLD.`status` = 'queued'
    AND NEW.`status` = 'running'
    AND OLD.`started_at` IS NULL
    AND NEW.`started_at` IS NOT NULL
  )
  OR (
    OLD.`status` = 'running'
    AND NEW.`status` IN ('succeeded', 'partial', 'failed', 'cancelled')
    AND NEW.`started_at` = OLD.`started_at`
  )
  )
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_JOB_INVALID_TRANSITION');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_source_job_attempts_immutable_delete`
BEFORE DELETE ON `finops_source_job_attempts`
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_JOB_ATTEMPT_IMMUTABLE');
END;
