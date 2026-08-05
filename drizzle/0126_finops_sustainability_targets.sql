-- ADD-08 governed sustainability proxy targets. Every version is append-only;
-- the head may advance only to a version linked to the current head.
CREATE TABLE `finops_sustainability_target_versions` (
  `version_id` text PRIMARY KEY NOT NULL,
  `target_id` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `metric` text NOT NULL,
  `workload_tag_key` text,
  `workload_tag_value` text,
  `period_start` text NOT NULL,
  `target_value_micros` text,
  `unit` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('ACTIVE','REVOKED')),
  `reason` text NOT NULL,
  `actor_id` text NOT NULL,
  `prior_version_id` text,
  `content_sha256` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`prior_version_id`) REFERENCES `finops_sustainability_target_versions`(`version_id`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`target_id`,`version_id`),
  CHECK (length(`version_id`)=69 AND substr(`version_id`,1,5)='stgv_' AND substr(`version_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`target_id`)=69 AND substr(`target_id`,1,5)='stgt_' AND substr(`target_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (`metric` IN ('COMPUTE_VCPU_HOURS','COMPUTE_MEMORY_GB_HOURS','LAMBDA_GB_SECONDS','STORAGE_GB_HOURS','STORAGE_REQUESTS','DATA_TRANSFER_GB','DATABASE_VCPU_HOURS')),
  CHECK ((`workload_tag_key` IS NULL)=(`workload_tag_value` IS NULL)),
  CHECK (length(`period_start`)=7 AND substr(`period_start`,5,1)='-'),
  CHECK (`unit` IN ('vCPU-hours','GB-hours','GB-seconds','requests','GB')),
  CHECK ((`state`='ACTIVE' AND `target_value_micros` IS NOT NULL) OR (`state`='REVOKED' AND `target_value_micros` IS NULL)),
  CHECK (`target_value_micros` IS NULL OR (`target_value_micros`<>'' AND `target_value_micros` NOT GLOB '*[^0-9]*')),
  CHECK (length(`reason`) BETWEEN 1 AND 1024),
  CHECK (length(`actor_id`) BETWEEN 1 AND 256),
  CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `finops_sustainability_target_history_idx` ON `finops_sustainability_target_versions` (`org_id`,`customer_id`,`connection_id`,`target_id`,`created_at` DESC);
--> statement-breakpoint
CREATE TABLE `finops_sustainability_target_heads` (
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `target_id` text NOT NULL, `active_version_id` text NOT NULL UNIQUE, `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`,`target_id`),
  FOREIGN KEY (`active_version_id`) REFERENCES `finops_sustainability_target_versions`(`version_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_target_versions_update_guard` BEFORE UPDATE ON `finops_sustainability_target_versions` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_TARGET_VERSION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_target_versions_delete_guard` BEFORE DELETE ON `finops_sustainability_target_versions` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_TARGET_VERSION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_target_heads_insert_guard` BEFORE INSERT ON `finops_sustainability_target_heads` WHEN NOT EXISTS (SELECT 1 FROM `finops_sustainability_target_versions` v WHERE v.`version_id`=NEW.`active_version_id` AND v.`target_id`=NEW.`target_id` AND v.`org_id`=NEW.`org_id` AND v.`customer_id`=NEW.`customer_id` AND v.`connection_id`=NEW.`connection_id` AND v.`prior_version_id` IS NULL) BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_TARGET_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_target_heads_update_guard` BEFORE UPDATE ON `finops_sustainability_target_heads` WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id` OR NEW.`target_id`<>OLD.`target_id` OR NOT EXISTS (SELECT 1 FROM `finops_sustainability_target_versions` v WHERE v.`version_id`=NEW.`active_version_id` AND v.`target_id`=OLD.`target_id` AND v.`org_id`=OLD.`org_id` AND v.`customer_id`=OLD.`customer_id` AND v.`connection_id`=OLD.`connection_id` AND v.`prior_version_id`=OLD.`active_version_id` AND v.`created_at`>=OLD.`advanced_at`) BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_TARGET_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_target_heads_delete_guard` BEFORE DELETE ON `finops_sustainability_target_heads` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_TARGET_HEAD_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TABLE `finops_sustainability_runtime_attempts` (
 `request_id` text PRIMARY KEY NOT NULL,`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,
 `scheduled_window` text NOT NULL,`source_boundary_sha256` text NOT NULL,`snapshot_generation_id` text NOT NULL,
 `evidence_generation_id` text NOT NULL,`evidence_object_id` text NOT NULL,`evidence_content_sha256` text NOT NULL,
 `accepted_json` text NOT NULL,`accepted_sha256` text NOT NULL,`created_at` integer NOT NULL,
 FOREIGN KEY (`snapshot_generation_id`) REFERENCES `finops_sustainability_snapshots`(`generation_id`),
 FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
 FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
 FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
 CHECK(length(`request_id`)=68 AND substr(`request_id`,1,4)='scr_' AND substr(`request_id`,5) NOT GLOB '*[^a-f0-9]*'),
 CHECK(length(`source_boundary_sha256`)=64 AND `source_boundary_sha256` NOT GLOB '*[^a-f0-9]*'),
 CHECK(length(`snapshot_generation_id`)=68 AND substr(`snapshot_generation_id`,1,4)='scg_'),
 CHECK(length(`evidence_generation_id`)=68 AND substr(`evidence_generation_id`,1,4)='fss_'),
 CHECK(length(`evidence_object_id`)=37 AND substr(`evidence_object_id`,1,5)='eobj_'),
 CHECK(length(`evidence_content_sha256`)=64 AND `evidence_content_sha256` NOT GLOB '*[^a-f0-9]*'),
 CHECK(length(`accepted_json`) BETWEEN 2 AND 117440512),
 CHECK(length(`accepted_sha256`)=64 AND `accepted_sha256` NOT GLOB '*[^a-f0-9]*'),
 CHECK(`created_at` BETWEEN 0 AND 9007199254740991),
 UNIQUE(`org_id`,`customer_id`,`connection_id`,`request_id`)
);
--> statement-breakpoint
CREATE TABLE `finops_sustainability_runtime_failures` (
 `failure_id` text PRIMARY KEY NOT NULL,`org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,
 `request_id` text NOT NULL,`scheduled_window` text NOT NULL,`failure_code` text NOT NULL,`completed_at` integer NOT NULL,
 CHECK(length(`failure_id`)=68 AND substr(`failure_id`,1,4)='srf_' AND substr(`failure_id`,5) NOT GLOB '*[^a-f0-9]*'),
 CHECK(`failure_code` IN ('MATERIALIZER_UNAVAILABLE','MATERIALIZER_TIMEOUT','MATERIALIZER_AUTHENTICATION_FAILED','CAPTURE_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED')),
 CHECK(`completed_at` BETWEEN 0 AND 9007199254740991),
 UNIQUE(`org_id`,`customer_id`,`connection_id`,`request_id`,`failure_id`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_runtime_attempts_update_guard` BEFORE UPDATE ON `finops_sustainability_runtime_attempts` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_RUNTIME_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_runtime_attempts_delete_guard` BEFORE DELETE ON `finops_sustainability_runtime_attempts` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_RUNTIME_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_runtime_failures_update_guard` BEFORE UPDATE ON `finops_sustainability_runtime_failures` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_RUNTIME_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_sustainability_runtime_failures_delete_guard` BEFORE DELETE ON `finops_sustainability_runtime_failures` BEGIN SELECT RAISE(ABORT,'FINOPS_SUSTAINABILITY_RUNTIME_IMMUTABLE'); END;
