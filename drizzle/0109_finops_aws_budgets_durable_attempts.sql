-- ADV-08 immutable signed-broker attempt evidence. Provider budgets remain in
-- finops_aws_budget_snapshots; this table proves scheduler/transport execution.
CREATE TABLE `finops_aws_budget_job_attempts` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `request_id` text NOT NULL,
  `job_id` text NOT NULL,
  `job_attempt` integer NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('ready','partial','configuration_required','unavailable','failed')),
  `generation_id` text,
  `capture_id` text,
  `hierarchy_evidence_id` text,
  `request_body_sha256` text,
  `response_body_sha256` text,
  `broker_key_id` text,
  `failure_code` text CHECK (`failure_code` IN (
    'BROKER_AUTHENTICATION_FAILED','BROKER_TIMEOUT','BROKER_UNAVAILABLE',
    'BROKER_RESPONSE_INVALID','SCOPE_REJECTED','EVIDENCE_REJECTED',
    'PERSISTENCE_REJECTED','INTERNAL_ERROR'
  )),
  `content_sha256` text NOT NULL,
  `completed_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`generation_id`) REFERENCES `finops_aws_budget_snapshots`(`generation_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`request_id`,`job_attempt`),
  CHECK (length(`execution_id`) = 68 AND substr(`execution_id`,1,4) = 'abe_'
    AND substr(`execution_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`request_id`) = 68 AND substr(`request_id`,1,4) = 'abr_'
    AND substr(`request_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`job_id`) = 36 AND substr(`job_id`,1,4) = 'job_'
    AND substr(`job_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (`job_attempt` BETWEEN 1 AND 25),
  CHECK (length(`scheduled_window`) = 24),
  CHECK (length(`account_id`) = 12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`completed_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK ((`state` = 'failed' AND `generation_id` IS NULL AND `capture_id` IS NULL
      AND `hierarchy_evidence_id` IS NULL AND `response_body_sha256` IS NULL
      AND `broker_key_id` IS NULL AND `failure_code` IS NOT NULL)
    OR (`state` <> 'failed' AND `generation_id` IS NOT NULL AND `capture_id` IS NOT NULL
      AND `request_body_sha256` IS NOT NULL AND `response_body_sha256` IS NOT NULL
      AND `broker_key_id` IS NOT NULL AND `failure_code` IS NULL
      AND (`state` <> 'ready' OR `hierarchy_evidence_id` IS NOT NULL)))
);
--> statement-breakpoint
CREATE INDEX `finops_aws_budget_job_attempts_history_idx`
  ON `finops_aws_budget_job_attempts`
  (`org_id`,`customer_id`,`connection_id`,`completed_at` DESC,`execution_id` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_aws_budget_job_attempts_scope_guard`
BEFORE INSERT ON `finops_aws_budget_job_attempts`
WHEN NEW.`state` <> 'failed' AND NOT EXISTS (
  SELECT 1 FROM `finops_aws_budget_snapshots` s
   WHERE s.`generation_id` = NEW.`generation_id`
     AND s.`org_id` = NEW.`org_id` AND s.`customer_id` = NEW.`customer_id`
     AND s.`connection_id` = NEW.`connection_id`
     AND s.`account_id` = NEW.`account_id` AND s.`partition` = NEW.`partition`
     AND s.`source_capture_id` = NEW.`capture_id`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_BUDGET_JOB_ATTEMPT_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_budget_job_attempts_update_guard`
BEFORE UPDATE ON `finops_aws_budget_job_attempts`
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_BUDGET_JOB_ATTEMPT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_budget_job_attempts_delete_guard`
BEFORE DELETE ON `finops_aws_budget_job_attempts`
BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_BUDGET_JOB_ATTEMPT_IMMUTABLE'); END;
