CREATE TABLE `finops_kubecost_runtime_attempts` (
  `execution_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `billing_period` text NOT NULL, `active_cur2_generation_id` text NOT NULL,
  `scope_sha256` text NOT NULL, `destination_sha256` text NOT NULL, `active_cur2_sha256` text NOT NULL,
  `account_count` integer NOT NULL, `cluster_count` integer NOT NULL,
  `request_id` text NOT NULL, `job_id` text NOT NULL, `job_attempt` integer NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('CONFIGURATION_REQUIRED','WAITING_FIRST_DELIVERY','UNKNOWN','ERROR','EMPTY','PARTIAL','STALE','READY','FAILED')),
  `generation_id` text, `capture_id` text,
  `request_body_sha256` text NOT NULL, `response_body_sha256` text, `broker_key_id` text,
  `failure_code` text CHECK (`failure_code` IN ('BROKER_AUTHENTICATION_FAILED','BROKER_TIMEOUT','BROKER_UNAVAILABLE','BROKER_RESPONSE_INVALID','SCOPE_REJECTED','DESTINATION_REJECTED','VERSION_PIN_REJECTED','CUR2_LINEAGE_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED','INTERNAL_ERROR')),
  `content_sha256` text NOT NULL, `completed_at` integer NOT NULL, `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`generation_id`) REFERENCES `finops_kubecost_snapshots`(`generation_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`request_id`,`job_attempt`),
  CHECK (length(`execution_id`)=68 AND substr(`execution_id`,1,4)='kue_' AND substr(`execution_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`request_id`)=68 AND substr(`request_id`,1,4)='kur_' AND substr(`request_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`job_id`)=36 AND substr(`job_id`,1,4)='job_' AND substr(`job_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`billing_period`)=7),
  CHECK (length(`active_cur2_generation_id`)=68 AND substr(`active_cur2_generation_id`,1,4)='fbg_'),
  CHECK (length(`scope_sha256`)=64 AND `scope_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`destination_sha256`)=64 AND `destination_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`active_cur2_sha256`)=64 AND `active_cur2_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`request_body_sha256`)=64 AND `request_body_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`response_body_sha256` IS NULL OR (length(`response_body_sha256`)=64 AND `response_body_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK (`generation_id` IS NULL OR (length(`generation_id`)=68 AND substr(`generation_id`,1,4)='kcg_' AND substr(`generation_id`,5) NOT GLOB '*[^a-f0-9]*')),
  CHECK (`capture_id` IS NULL OR (length(`capture_id`)=73 AND substr(`capture_id`,1,9)='kubecost_' AND substr(`capture_id`,10) NOT GLOB '*[^a-f0-9]*')),
  CHECK (`account_count` BETWEEN 1 AND 10000 AND `cluster_count` BETWEEN 1 AND 5000),
  CHECK (`job_attempt` BETWEEN 1 AND 25 AND length(`scheduled_window`)=24),
  CHECK ((`state`='FAILED' AND `generation_id` IS NULL AND `capture_id` IS NULL
    AND `response_body_sha256` IS NULL AND `broker_key_id` IS NULL AND `failure_code` IS NOT NULL)
    OR (`state`<>'FAILED' AND `generation_id` IS NOT NULL AND `capture_id` IS NOT NULL
    AND `response_body_sha256` IS NOT NULL AND `broker_key_id` IS NOT NULL AND `failure_code` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_kubecost_runtime_attempts_history_idx` ON `finops_kubecost_runtime_attempts`
  (`org_id`,`customer_id`,`connection_id`,`completed_at` DESC,`execution_id` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_runtime_attempts_scope_guard` BEFORE INSERT ON `finops_kubecost_runtime_attempts`
WHEN NEW.`state`<>'FAILED' AND NOT EXISTS (
  SELECT 1 FROM `finops_kubecost_snapshots` s WHERE s.`generation_id`=NEW.`generation_id`
    AND s.`org_id`=NEW.`org_id` AND s.`customer_id`=NEW.`customer_id`
    AND s.`connection_id`=NEW.`connection_id` AND s.`partition`=NEW.`partition`
    AND s.`billing_period`=NEW.`billing_period`
    AND s.`active_cur2_generation_id`=NEW.`active_cur2_generation_id`
    AND s.`source_capture_id`=NEW.`capture_id` AND s.`source_state`=NEW.`state`
) BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_RUNTIME_ATTEMPT_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_runtime_attempts_update_guard` BEFORE UPDATE ON `finops_kubecost_runtime_attempts`
BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_RUNTIME_ATTEMPT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_kubecost_runtime_attempts_delete_guard` BEFORE DELETE ON `finops_kubecost_runtime_attempts`
BEGIN SELECT RAISE(ABORT,'FINOPS_KUBECOST_RUNTIME_ATTEMPT_IMMUTABLE'); END;
