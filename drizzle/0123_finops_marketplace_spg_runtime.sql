CREATE TABLE `finops_marketplace_spg_runtime_boundaries` (
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `boundary_json` text NOT NULL, `content_sha256` text NOT NULL, `updated_at` integer NOT NULL,
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  CHECK (`content_sha256` GLOB '[0-9a-f]*' AND length(`content_sha256`)=64),
  CHECK (length(CAST(`boundary_json` AS BLOB)) BETWEEN 2 AND 33554432)
);
CREATE TABLE `finops_marketplace_spg_runtime_attempts` (
  `request_id` text PRIMARY KEY NOT NULL, `org_id` text NOT NULL, `customer_id` text NOT NULL,
  `connection_id` text NOT NULL, `scheduled_window` text, `source_boundary_sha256` text,
  `state` text NOT NULL, `failure_code` text, `generation_id` text,
  `evidence_generation_id` text, `evidence_object_id` text, `evidence_content_sha256` text,
  `evidence_reference_ciphertext` text, `evidence_reference_key_version` text,
  `lease_token_sha256` text NOT NULL, `lease_expires_at` integer NOT NULL,
  `started_at` integer NOT NULL, `completed_at` integer, `updated_at` integer NOT NULL,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`generation_id`) REFERENCES `finops_marketplace_spg_snapshots`(`generation_id`) ON DELETE RESTRICT,
  FOREIGN KEY (`evidence_object_id`) REFERENCES `evidence_objects`(`id`) ON DELETE RESTRICT,
  CHECK (`state` IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  CHECK (`request_id` GLOB 'mpr_*' AND length(`request_id`)=68),
  CHECK (`state`<>'SUCCEEDED' OR (`scheduled_window` IS NOT NULL AND `source_boundary_sha256` IS NOT NULL AND `generation_id` IS NOT NULL AND `evidence_generation_id` IS NOT NULL AND `evidence_object_id` IS NOT NULL AND `evidence_content_sha256` IS NOT NULL AND `evidence_reference_ciphertext` IS NOT NULL AND `evidence_reference_key_version` IS NOT NULL))
);
CREATE INDEX `finops_marketplace_spg_runtime_scope_idx` ON `finops_marketplace_spg_runtime_attempts` (`org_id`,`customer_id`,`connection_id`,`updated_at` DESC);
CREATE TRIGGER `finops_marketplace_spg_runtime_attempt_identity_immutable` BEFORE UPDATE ON `finops_marketplace_spg_runtime_attempts`
WHEN OLD.`request_id`<>NEW.`request_id` OR OLD.`org_id`<>NEW.`org_id` OR OLD.`customer_id`<>NEW.`customer_id` OR OLD.`connection_id`<>NEW.`connection_id` OR OLD.`started_at`<>NEW.`started_at`
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_RUNTIME_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER `finops_marketplace_spg_runtime_success_immutable` BEFORE UPDATE ON `finops_marketplace_spg_runtime_attempts` WHEN OLD.`state`='SUCCEEDED'
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_RUNTIME_SUCCESS_IMMUTABLE'); END;
CREATE TRIGGER `finops_marketplace_spg_runtime_attempt_delete_guard` BEFORE DELETE ON `finops_marketplace_spg_runtime_attempts`
BEGIN SELECT RAISE(ABORT,'FINOPS_MARKETPLACE_SPG_RUNTIME_ATTEMPT_IMMUTABLE'); END;
