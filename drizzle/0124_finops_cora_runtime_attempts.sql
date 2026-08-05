CREATE TABLE `finops_cora_runtime_attempts` (
  `request_key` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `customer_id` text NOT NULL REFERENCES `customers`(`id`) ON DELETE CASCADE,
  `connection_id` text NOT NULL REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  `job_id` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('IN_PROGRESS','SUCCEEDED','RETRYABLE_FAILED','FAILED')),
  `lease_token` text,
  `lease_expires_at` integer,
  `attempt_count` integer NOT NULL CHECK (`attempt_count` BETWEEN 1 AND 25),
  `generation_id` text REFERENCES `finops_cora_export_object_generations`(`generation_id`) ON DELETE RESTRICT,
  `failure_code` text CHECK (`failure_code` IS NULL OR `failure_code` IN ('ADAPTER_TIMEOUT','ADAPTER_UNAVAILABLE','CAPTURE_REJECTED','PERSISTENCE_REJECTED')),
  `started_at` integer NOT NULL CHECK (`started_at` BETWEEN 0 AND 9007199254740991),
  `completed_at` integer,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`scheduled_window`),
  CHECK (length(`request_key`)=71 AND substr(`request_key`,1,7)='corarq_' AND substr(`request_key`,8) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`job_id`) IN (36,68) AND substr(`job_id`,1,4)='job_'),
  CHECK (length(`scheduled_window`)=24),
  CHECK (`lease_token` IS NULL OR (length(`lease_token`)=38 AND substr(`lease_token`,1,6)='coral_' AND substr(`lease_token`,7) NOT GLOB '*[^a-f0-9]*')),
  CHECK (`state`<>'IN_PROGRESS' OR `lease_expires_at`>=`started_at`+1020000),
  CHECK ((`state`='IN_PROGRESS' AND `lease_token` IS NOT NULL AND `lease_expires_at` IS NOT NULL AND `generation_id` IS NULL AND `failure_code` IS NULL AND `completed_at` IS NULL)
    OR (`state`='SUCCEEDED' AND `lease_token` IS NULL AND `lease_expires_at` IS NULL AND `generation_id` IS NOT NULL AND `failure_code` IS NULL AND `completed_at` IS NOT NULL)
    OR (`state` IN ('RETRYABLE_FAILED','FAILED') AND `lease_token` IS NULL AND `lease_expires_at` IS NULL AND `generation_id` IS NULL AND `failure_code` IS NOT NULL AND `completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_cora_runtime_attempts_scope_idx` ON `finops_cora_runtime_attempts` (`org_id`,`customer_id`,`connection_id`,`updated_at`);
--> statement-breakpoint
CREATE TRIGGER `finops_cora_runtime_terminal_immutable` BEFORE UPDATE ON `finops_cora_runtime_attempts`
WHEN OLD.`state` IN ('SUCCEEDED','FAILED')
BEGIN SELECT RAISE(ABORT,'FINOPS_CORA_RUNTIME_TERMINAL_IMMUTABLE'); END;
