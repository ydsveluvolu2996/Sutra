CREATE TABLE `finops_config_compliance_runtime_configuration`(
  `org_id` text NOT NULL,`customer_id` text NOT NULL,`connection_id` text NOT NULL,
  `aggregator_name` text NOT NULL,`aggregator_arn` text NOT NULL,`aws_organization_id` text NOT NULL,
  `accounts_evidence_id` text NOT NULL,`accounts_observed_at` text NOT NULL,
  `active_account_ids_json` text NOT NULL,`expected_regions_json` text NOT NULL,
  `activity_evidence_json` text,`cur2_evidence_json` text,`enabled` integer NOT NULL DEFAULT 0 CHECK(`enabled` IN(0,1)),
  `updated_at` integer NOT NULL CHECK(`updated_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY(`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  CHECK(length(`aggregator_name`) BETWEEN 1 AND 256),CHECK(length(`aggregator_arn`) BETWEEN 20 AND 1024),
  CHECK(length(`aws_organization_id`) BETWEEN 12 AND 34),CHECK(length(`accounts_evidence_id`) BETWEEN 1 AND 512),
  CHECK(length(`accounts_observed_at`)=24),CHECK(length(`active_account_ids_json`) BETWEEN 16 AND 160001),
  CHECK(length(`expected_regions_json`) BETWEEN 4 AND 2049),
  CHECK(`activity_evidence_json` IS NULL OR length(`activity_evidence_json`) BETWEEN 2 AND 67108864),
  CHECK(`cur2_evidence_json` IS NULL OR length(`cur2_evidence_json`) BETWEEN 2 AND 33554432)
);
--> statement-breakpoint
CREATE TABLE `finops_config_compliance_runtime_attempts`(
  `replay_key` text PRIMARY KEY NOT NULL,`job_id` text NOT NULL,`org_id` text NOT NULL,
  `customer_id` text NOT NULL,`connection_id` text NOT NULL,`scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK(`state` IN('IN_PROGRESS','SUCCEEDED','FAILED')),
  `failure_code` text,`result_json` text,`result_sha256` text,`lease_token` text NOT NULL,
  `lease_expires_at` integer NOT NULL,`started_at` integer NOT NULL,`completed_at` integer,`updated_at` integer NOT NULL,
  FOREIGN KEY(`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  CHECK(length(`replay_key`) BETWEEN 32 AND 1024),CHECK(length(`job_id`)=36),CHECK(length(`scheduled_window`)=24),
  CHECK(length(`lease_token`)=64),CHECK(`result_json` IS NULL OR length(`result_json`) BETWEEN 2 AND 2048),
  CHECK((`state`='SUCCEEDED')=(`result_json` IS NOT NULL AND `result_sha256` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_config_compliance_runtime_status_idx` ON `finops_config_compliance_runtime_attempts`
 (`org_id`,`customer_id`,`connection_id`,`updated_at` DESC);
