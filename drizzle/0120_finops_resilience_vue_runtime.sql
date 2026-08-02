CREATE TABLE `finops_resilience_vue_runtime_attempts` (
  `request_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-cn','aws-us-gov')),
  `region` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  `failure_code` text,
  `generation_id` text,
  `evidence_generation_id` text,
  `evidence_object_id` text,
  `evidence_content_sha256` text,
  `evidence_reference_ciphertext` text,
  `evidence_reference_key_version` text,
  `lease_token_sha256` text NOT NULL,
  `lease_expires_at` integer NOT NULL CHECK (`lease_expires_at` BETWEEN 0 AND 8640000000000000),
  `started_at` integer NOT NULL CHECK (`started_at` BETWEEN 0 AND 8640000000000000),
  `completed_at` integer,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`generation_id`) REFERENCES `finops_resilience_vue_snapshots`(`generation_id`) ON DELETE RESTRICT,
  FOREIGN KEY (`evidence_object_id`) REFERENCES `evidence_objects`(`id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`account_id`,`partition`,`region`,`scheduled_window`),
  CHECK (length(`request_id`)=68 AND substr(`request_id`,1,4)='rvr_' AND substr(`request_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_id`)=12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`region`) BETWEEN 9 AND 32 AND `region` NOT GLOB '*[^a-z0-9-]*'),
  CHECK (length(`scheduled_window`)=24 AND substr(`scheduled_window`,12)='00:00:00.000Z'),
  CHECK (length(`lease_token_sha256`)=64 AND `lease_token_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`completed_at` IS NULL OR `completed_at` BETWEEN 0 AND 8640000000000000),
  CHECK ((`state`='IN_PROGRESS' AND `failure_code` IS NULL AND `generation_id` IS NULL AND `completed_at` IS NULL)
    OR (`state`='FAILED' AND `failure_code` IS NOT NULL AND `generation_id` IS NULL AND `completed_at` IS NOT NULL)
    OR (`state`='SUCCEEDED' AND `failure_code` IS NULL AND `generation_id` IS NOT NULL
      AND `evidence_generation_id` IS NOT NULL AND `evidence_object_id` IS NOT NULL
      AND `evidence_content_sha256` IS NOT NULL AND `evidence_reference_ciphertext` IS NOT NULL
      AND `evidence_reference_key_version` IS NOT NULL AND `completed_at` IS NOT NULL)),
  CHECK (`state`='SUCCEEDED' OR (`evidence_generation_id` IS NULL AND `evidence_object_id` IS NULL
    AND `evidence_content_sha256` IS NULL AND `evidence_reference_ciphertext` IS NULL
    AND `evidence_reference_key_version` IS NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_resilience_vue_runtime_scope_idx` ON `finops_resilience_vue_runtime_attempts`
  (`org_id`,`customer_id`,`connection_id`,`updated_at` DESC,`request_id` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_runtime_scope_guard` BEFORE INSERT ON `finops_resilience_vue_runtime_attempts`
WHEN NOT EXISTS (SELECT 1 FROM `aws_connections` c
  JOIN `organizations` o ON o.`id`=c.`org_id` AND o.`status`='active'
  JOIN `customers` cu ON cu.`id`=c.`customer_id` AND cu.`org_id`=c.`org_id` AND cu.`status` IN ('active','trial')
  WHERE c.`org_id`=NEW.`org_id` AND c.`customer_id`=NEW.`customer_id` AND c.`id`=NEW.`connection_id`
    AND c.`aws_account_id`=NEW.`account_id` AND c.`partition`=NEW.`partition`
    AND c.`source_kind`='aws_trust_role' AND c.`status`='active')
BEGIN SELECT RAISE(ABORT,'FINOPS_RESILIENCE_VUE_RUNTIME_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_runtime_success_immutable` BEFORE UPDATE ON `finops_resilience_vue_runtime_attempts`
WHEN OLD.`state`='SUCCEEDED' OR NEW.`request_id`<>OLD.`request_id` OR NEW.`org_id`<>OLD.`org_id`
  OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id`
  OR NEW.`account_id`<>OLD.`account_id` OR NEW.`partition`<>OLD.`partition`
  OR NEW.`region`<>OLD.`region` OR NEW.`scheduled_window`<>OLD.`scheduled_window`
  OR NEW.`started_at`<>OLD.`started_at` OR NEW.`updated_at`<OLD.`updated_at`
BEGIN SELECT RAISE(ABORT,'FINOPS_RESILIENCE_VUE_RUNTIME_SUCCESS_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_resilience_vue_runtime_delete_guard` BEFORE DELETE ON `finops_resilience_vue_runtime_attempts`
BEGIN SELECT RAISE(ABORT,'FINOPS_RESILIENCE_VUE_RUNTIME_IMMUTABLE'); END;
