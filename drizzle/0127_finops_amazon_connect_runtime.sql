CREATE TABLE `finops_amazon_connect_runtime_attempts` (
  `request_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `source_boundary_sha256` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  `lease_token` text,
  `lease_expires_at` integer,
  `generation_id` text,
  `evidence_generation_id` text,
  `evidence_object_id` text,
  `evidence_content_sha256` text,
  `evidence_reference` text,
  `evidence_key_version` text,
  `failure_code` text CHECK (`failure_code` IS NULL OR `failure_code` IN ('MATERIALIZER_AUTHENTICATION_FAILED','MATERIALIZER_TIMEOUT','MATERIALIZER_UNAVAILABLE','CAPTURE_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED')),
  `started_at` integer NOT NULL CHECK (`started_at` BETWEEN 0 AND 9007199254740991),
  `completed_at` integer,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`generation_id`) REFERENCES `finops_amazon_connect_cost_snapshots`(`generation_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`scheduled_window`,`source_boundary_sha256`),
  CHECK (length(`request_id`)=68 AND substr(`request_id`,1,4)='acr_' AND substr(`request_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`source_boundary_sha256`)=64 AND `source_boundary_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`scheduled_window`)=24),
  CHECK (`completed_at` IS NULL OR (`completed_at` BETWEEN `started_at` AND 9007199254740991)),
  CHECK ((`state`='IN_PROGRESS' AND `lease_token` IS NOT NULL AND `lease_expires_at` IS NOT NULL AND `generation_id` IS NULL AND `failure_code` IS NULL AND `completed_at` IS NULL)
      OR (`state`='SUCCEEDED' AND `lease_token` IS NULL AND `lease_expires_at` IS NULL AND `generation_id` IS NOT NULL AND `evidence_generation_id` IS NOT NULL AND `evidence_object_id` IS NOT NULL AND `evidence_content_sha256` IS NOT NULL AND `evidence_reference` IS NOT NULL AND `evidence_key_version` IS NOT NULL AND `failure_code` IS NULL AND `completed_at` IS NOT NULL)
      OR (`state`='FAILED' AND `lease_token` IS NULL AND `lease_expires_at` IS NULL AND `generation_id` IS NULL AND `evidence_generation_id` IS NULL AND `evidence_object_id` IS NULL AND `evidence_content_sha256` IS NULL AND `evidence_reference` IS NULL AND `evidence_key_version` IS NULL AND `failure_code` IS NOT NULL AND `completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_amazon_connect_runtime_status_idx` ON `finops_amazon_connect_runtime_attempts` (`org_id`,`customer_id`,`connection_id`,`updated_at` DESC,`request_id` DESC);
--> statement-breakpoint
CREATE TABLE `finops_amazon_connect_runtime_failures` (
  `failure_id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `failure_code` text NOT NULL,
  `content_sha256` text NOT NULL,
  `failed_at` integer NOT NULL CHECK (`failed_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`request_id`) REFERENCES `finops_amazon_connect_runtime_attempts`(`request_id`) ON DELETE CASCADE,
  UNIQUE (`request_id`,`failed_at`,`content_sha256`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_amazon_connect_runtime_failure_update_guard` BEFORE UPDATE ON `finops_amazon_connect_runtime_failures` BEGIN SELECT RAISE(ABORT,'FINOPS_AMAZON_CONNECT_RUNTIME_FAILURE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_amazon_connect_runtime_failure_delete_guard` BEFORE DELETE ON `finops_amazon_connect_runtime_failures` BEGIN SELECT RAISE(ABORT,'FINOPS_AMAZON_CONNECT_RUNTIME_FAILURE_IMMUTABLE'); END;
