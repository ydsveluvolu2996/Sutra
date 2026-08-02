-- Immutable encrypted, single-Region Compute Optimizer organization export plans.
-- Plaintext plan JSON, buckets, prefixes, and object keys are prohibited.
CREATE TABLE `finops_co_export_plans` (
  `plan_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `discovery_run_id` text NOT NULL,
  `content_sha256` text NOT NULL,
  `requester_account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `region` text NOT NULL,
  `region_count` integer NOT NULL,
  `export_family_count` integer NOT NULL,
  `target_count` integer NOT NULL,
  `sealed_envelope_format` text NOT NULL,
  `sealed_envelope_ciphertext` text NOT NULL,
  `sealed_envelope_key_version` text NOT NULL,
  `sealed_envelope_sha256` text NOT NULL,
  `binding_sha256` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`org_id`,`customer_id`,`connection_id`,`discovery_run_id`)
    REFERENCES `finops_co_discovery_runs`(`org_id`,`customer_id`,`connection_id`,`run_id`)
    ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`plan_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`discovery_run_id`,`plan_id`),
  CHECK (length(`plan_id`) = 69 AND substr(`plan_id`,1,5) = 'cope_'
    AND substr(`plan_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64
    AND `content_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`plan_id`,6) = `content_sha256`),
  CHECK (length(`discovery_run_id`) = 68 AND substr(`discovery_run_id`,1,4) = 'cor_'
    AND substr(`discovery_run_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`requester_account_id`) = 12
    AND `requester_account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`region`) BETWEEN 9 AND 32
    AND `region` NOT GLOB '*[^a-z0-9-]*'),
  CHECK ((`partition` = 'aws-cn' AND substr(`region`,1,3) = 'cn-')
    OR (`partition` = 'aws-us-gov' AND substr(`region`,1,7) = 'us-gov-')
    OR (`partition` = 'aws' AND substr(`region`,1,3) != 'cn-'
      AND substr(`region`,1,7) != 'us-gov-')),
  CHECK (`region_count` = 1),
  CHECK (`export_family_count` BETWEEN 1 AND 8),
  CHECK (`target_count` BETWEEN 1 AND 8
    AND `target_count` = `region_count` * `export_family_count`),
  CHECK (`sealed_envelope_format` = 'sutra.compute-optimizer-export-plan-envelope.v1'),
  CHECK (length(`sealed_envelope_ciphertext`) BETWEEN 40 AND 22369659
    AND `sealed_envelope_ciphertext` NOT GLOB '*[^A-Za-z0-9_-]*'
    AND (length(`sealed_envelope_ciphertext`) % 4 = 0
      OR (length(`sealed_envelope_ciphertext`) % 4 = 2
        AND substr(`sealed_envelope_ciphertext`,-1) GLOB '[AQgw]')
      OR (length(`sealed_envelope_ciphertext`) % 4 = 3
        AND substr(`sealed_envelope_ciphertext`,-1) GLOB '[AEIMQUYcgkosw048]'))),
  CHECK (length(`sealed_envelope_key_version`) BETWEEN 1 AND 128
    AND substr(`sealed_envelope_key_version`,1,1) GLOB '[A-Za-z0-9]'
    AND `sealed_envelope_key_version` NOT GLOB '*[^A-Za-z0-9._:@+-]*'),
  CHECK (length(`sealed_envelope_sha256`) = 64
    AND `sealed_envelope_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`binding_sha256`) = 64
    AND `binding_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`created_at` BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `finops_co_export_plans_history_idx`
  ON `finops_co_export_plans`
  (`org_id`,`customer_id`,`connection_id`,`created_at` DESC,`plan_id` DESC);
--> statement-breakpoint
CREATE INDEX `finops_co_export_plans_discovery_idx`
  ON `finops_co_export_plans`
  (`org_id`,`customer_id`,`connection_id`,`discovery_run_id`);
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plans_scope_guard`
BEFORE INSERT ON `finops_co_export_plans`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_discovery_runs` d
  JOIN `aws_connections` c ON c.`id` = d.`connection_id`
    AND c.`org_id` = d.`org_id` AND c.`customer_id` = d.`customer_id`
  JOIN `organizations` o ON o.`id` = d.`org_id` AND o.`status` = 'active'
  JOIN `customers` cu ON cu.`id` = d.`customer_id` AND cu.`org_id` = d.`org_id`
    AND cu.`status` = 'active'
  WHERE d.`org_id` = NEW.`org_id` AND d.`customer_id` = NEW.`customer_id`
    AND d.`connection_id` = NEW.`connection_id` AND d.`run_id` = NEW.`discovery_run_id`
    AND d.`account_id` = NEW.`requester_account_id` AND d.`partition` = NEW.`partition`
    AND d.`region` = NEW.`region`
    AND d.`status` IN ('complete','partial') AND d.`content_sha256` IS NOT NULL
    AND d.`finalized_at` IS NOT NULL
    AND c.`aws_account_id` = NEW.`requester_account_id` AND c.`partition` = NEW.`partition`
    AND c.`source_kind` = 'aws_trust_role' AND c.`status` = 'active'
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plans_update_guard`
BEFORE UPDATE ON `finops_co_export_plans`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plans_delete_guard`
BEFORE DELETE ON `finops_co_export_plans`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_IMMUTABLE'); END;
