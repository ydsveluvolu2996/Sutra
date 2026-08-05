CREATE TABLE `finops_dcf_module_bindings` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `module_id` text NOT NULL,
  `module_name` text NOT NULL,
  `source_id` text,
  `region` text NOT NULL,
  `state_machine_arn` text NOT NULL,
  `enabled` integer NOT NULL CHECK (`enabled` IN (0,1)),
  `expected_cadence_minutes` integer NOT NULL CHECK (`expected_cadence_minutes` BETWEEN 5 AND 10080),
  `verified_at` integer NOT NULL CHECK (`verified_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`,`module_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`state_machine_arn`),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  CHECK (length(`module_id`) BETWEEN 1 AND 128),
  CHECK (length(`module_name`) BETWEEN 1 AND 256),
  CHECK (`source_id` IS NULL OR length(`source_id`) BETWEEN 1 AND 128),
  CHECK (length(`region`) BETWEEN 9 AND 32),
  CHECK (length(`state_machine_arn`) BETWEEN 20 AND 256)
);
--> statement-breakpoint
CREATE INDEX `finops_dcf_module_bindings_scheduler_idx`
  ON `finops_dcf_module_bindings` (`enabled`,`connection_id`,`region`);
--> statement-breakpoint
CREATE TABLE `finops_dcf_runtime_attempts` (
  `idempotency_key` text PRIMARY KEY,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `job_id` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('IN_PROGRESS','COMPLETED','FAILED')),
  `lease_token` text NOT NULL,
  `lease_expires_at` integer NOT NULL CHECK (`lease_expires_at` BETWEEN 0 AND 9007199254740991),
  `result_json` text,
  `result_sha256` text,
  `failure_code` text,
  `started_at` integer NOT NULL CHECK (`started_at` BETWEEN 0 AND 9007199254740991),
  `completed_at` integer,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`scheduled_window`),
  CHECK (length(`idempotency_key`) BETWEEN 80 AND 1024),
  CHECK (length(`job_id`)=36 AND substr(`job_id`,1,4)='job_'),
  CHECK (length(`scheduled_window`)=24),
  CHECK (length(`lease_token`)=64),
  CHECK ((`state`='COMPLETED' AND `result_json` IS NOT NULL AND length(`result_json`) BETWEEN 2 AND 65536 AND length(`result_sha256`)=64 AND `failure_code` IS NULL AND `completed_at` IS NOT NULL)
      OR (`state`='FAILED' AND `result_json` IS NULL AND `result_sha256` IS NULL AND `failure_code`='DCF_STEP_FUNCTIONS_COLLECTION_FAILED' AND `completed_at` IS NOT NULL)
      OR (`state`='IN_PROGRESS' AND `result_json` IS NULL AND `result_sha256` IS NULL AND `failure_code` IS NULL AND `completed_at` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_dcf_runtime_status_idx`
  ON `finops_dcf_runtime_attempts` (`org_id`,`customer_id`,`connection_id`,`updated_at` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_dcf_module_binding_scope_insert_guard`
BEFORE INSERT ON `finops_dcf_module_bindings`
WHEN NOT EXISTS (
  SELECT 1 FROM `aws_connections` c
  WHERE c.`id`=NEW.`connection_id` AND c.`org_id`=NEW.`org_id`
    AND c.`customer_id`=NEW.`customer_id` AND c.`source_kind`='aws_trust_role'
    AND c.`status`='active' AND c.`permission_pack_version`='standard-2026-08.10'
    AND substr(NEW.`state_machine_arn`,1,length('arn:' || c.`partition` || ':states:' || NEW.`region` || ':' || c.`aws_account_id` || ':stateMachine:'))
      = 'arn:' || c.`partition` || ':states:' || NEW.`region` || ':' || c.`aws_account_id` || ':stateMachine:'
)
BEGIN SELECT RAISE(ABORT,'FINOPS_DCF_MODULE_BINDING_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_dcf_module_binding_scope_update_guard`
BEFORE UPDATE ON `finops_dcf_module_bindings`
WHEN NOT EXISTS (
  SELECT 1 FROM `aws_connections` c
  WHERE c.`id`=NEW.`connection_id` AND c.`org_id`=NEW.`org_id`
    AND c.`customer_id`=NEW.`customer_id` AND c.`source_kind`='aws_trust_role'
    AND c.`status`='active' AND c.`permission_pack_version`='standard-2026-08.10'
    AND substr(NEW.`state_machine_arn`,1,length('arn:' || c.`partition` || ':states:' || NEW.`region` || ':' || c.`aws_account_id` || ':stateMachine:'))
      = 'arn:' || c.`partition` || ':states:' || NEW.`region` || ':' || c.`aws_account_id` || ':stateMachine:'
)
BEGIN SELECT RAISE(ABORT,'FINOPS_DCF_MODULE_BINDING_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_dcf_runtime_scope_guard`
BEFORE INSERT ON `finops_dcf_runtime_attempts`
WHEN NOT EXISTS (
  SELECT 1 FROM `aws_connections` c
  WHERE c.`id`=NEW.`connection_id` AND c.`org_id`=NEW.`org_id`
    AND c.`customer_id`=NEW.`customer_id` AND c.`source_kind`='aws_trust_role'
    AND c.`status`='active' AND c.`permission_pack_version`='standard-2026-08.10'
)
BEGIN SELECT RAISE(ABORT,'FINOPS_DCF_RUNTIME_SCOPE_REJECTED'); END;
