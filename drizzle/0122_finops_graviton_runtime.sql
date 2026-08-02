CREATE TABLE `finops_graviton_runtime_authorities` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `cur2_generation_id` text NOT NULL,
  `cur2_content_sha256` text NOT NULL,
  `pricing_catalog_version` text NOT NULL,
  `pricing_content_sha256` text NOT NULL,
  `compatibility_policy_version` text NOT NULL,
  `compatibility_content_sha256` text NOT NULL,
  `workload_attestation_set_id` text NOT NULL,
  `workload_attestation_sha256` text NOT NULL,
  `license_attestation_set_id` text NOT NULL,
  `license_attestation_sha256` text NOT NULL,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  CHECK (length(`cur2_generation_id`) BETWEEN 1 AND 128),
  CHECK (length(`pricing_catalog_version`) BETWEEN 1 AND 128),
  CHECK (length(`compatibility_policy_version`) BETWEEN 1 AND 128),
  CHECK (length(`workload_attestation_set_id`) BETWEEN 1 AND 128),
  CHECK (length(`license_attestation_set_id`) BETWEEN 1 AND 128),
  CHECK (length(`cur2_content_sha256`)=64 AND `cur2_content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`pricing_content_sha256`)=64 AND `pricing_content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`compatibility_content_sha256`)=64 AND `compatibility_content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`workload_attestation_sha256`)=64 AND `workload_attestation_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`license_attestation_sha256`)=64 AND `license_attestation_sha256` NOT GLOB '*[^a-f0-9]*')
);
--> statement-breakpoint
CREATE TABLE `finops_graviton_runtime_attempts` (
  `request_key` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  `failure_code` text,
  `generation_id` text,
  `receipt_json` text,
  `lease_token_sha256` text NOT NULL,
  `lease_expires_at` integer NOT NULL CHECK (`lease_expires_at` BETWEEN 0 AND 9007199254740991),
  `started_at` integer NOT NULL CHECK (`started_at` BETWEEN 0 AND 9007199254740991),
  `completed_at` integer,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`generation_id`) REFERENCES `finops_graviton_snapshots`(`generation_id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`scheduled_window`),
  CHECK (length(`request_key`)=69 AND substr(`request_key`,1,5)='gvrq_' AND substr(`request_key`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`scheduled_window`)=24),
  CHECK (length(`lease_token_sha256`)=64 AND `lease_token_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`receipt_json` IS NULL OR length(`receipt_json`) BETWEEN 2 AND 65536),
  CHECK ((`state`='IN_PROGRESS' AND `failure_code` IS NULL AND `generation_id` IS NULL AND `receipt_json` IS NULL AND `completed_at` IS NULL)
    OR (`state`='FAILED' AND `failure_code` IS NOT NULL AND `generation_id` IS NULL AND `receipt_json` IS NULL AND `completed_at` IS NOT NULL)
    OR (`state`='SUCCEEDED' AND `failure_code` IS NULL AND `generation_id` IS NOT NULL AND `receipt_json` IS NOT NULL AND `completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_graviton_runtime_attempt_scope_idx` ON `finops_graviton_runtime_attempts` (`org_id`,`customer_id`,`connection_id`,`updated_at` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_graviton_runtime_attempt_identity_immutable` BEFORE UPDATE ON `finops_graviton_runtime_attempts` WHEN OLD.`request_key`<>NEW.`request_key` OR OLD.`org_id`<>NEW.`org_id` OR OLD.`customer_id`<>NEW.`customer_id` OR OLD.`connection_id`<>NEW.`connection_id` OR OLD.`scheduled_window`<>NEW.`scheduled_window` OR OLD.`started_at`<>NEW.`started_at` BEGIN SELECT RAISE(ABORT,'FINOPS_GRAVITON_RUNTIME_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_graviton_runtime_success_immutable` BEFORE UPDATE ON `finops_graviton_runtime_attempts` WHEN OLD.`state`='SUCCEEDED' BEGIN SELECT RAISE(ABORT,'FINOPS_GRAVITON_RUNTIME_SUCCESS_IMMUTABLE'); END;
