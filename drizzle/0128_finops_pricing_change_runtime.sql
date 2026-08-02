-- ADD-13 immutable accepted replay ledger and redacted failure audit.
CREATE TABLE `finops_pricing_change_runtime_acceptances` (
  `request_key` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `job_id` text NOT NULL, `policy_id` text NOT NULL, `snapshot_id` text NOT NULL,
  `evidence_generation_id` text NOT NULL, `content_sha256` text NOT NULL,
  `active_cur2_generation_id` text NOT NULL, `captured_at` text NOT NULL,
  `became_active` integer NOT NULL, `accepted_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`snapshot_id`) REFERENCES `finops_pricing_change_materializations`(`snapshot_id`),
  CHECK(length(`request_key`)=69 AND substr(`request_key`,1,5)='pcrt_' AND substr(`request_key`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(`snapshot_id`)=68 AND substr(`snapshot_id`,1,4)='pca_' AND substr(`snapshot_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(`evidence_generation_id`)=68 AND substr(`evidence_generation_id`,1,4)='fss_' AND substr(`evidence_generation_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(`active_cur2_generation_id`)=68 AND substr(`active_cur2_generation_id`,1,4)='fbg_' AND substr(`active_cur2_generation_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK(`became_active` IN (0,1)), CHECK(`accepted_at` BETWEEN 0 AND 9007199254740991),
  UNIQUE(`org_id`,`customer_id`,`connection_id`,`job_id`)
);
--> statement-breakpoint
CREATE TABLE `finops_pricing_change_runtime_failures` (
  `failure_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL, `customer_id` text NOT NULL, `connection_id` text NOT NULL,
  `request_key` text NOT NULL, `job_id` text NOT NULL, `policy_id` text NOT NULL,
  `attempt` integer NOT NULL, `failure_code` text NOT NULL, `failed_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  CHECK(length(`failure_id`)=69 AND substr(`failure_id`,1,5)='pcrf_' AND substr(`failure_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK(length(`request_key`)=69 AND substr(`request_key`,1,5)='pcrt_' AND substr(`request_key`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK(`attempt` BETWEEN 1 AND 5),
  CHECK(`failure_code` IN ('POLICY_UNAVAILABLE','CUR2_UNAVAILABLE','PROVIDER_UNAVAILABLE','MATERIALIZATION_REJECTED','EVIDENCE_REJECTED','PERSISTENCE_REJECTED')),
  CHECK(`failed_at` BETWEEN 0 AND 9007199254740991),
  UNIQUE(`org_id`,`customer_id`,`connection_id`,`job_id`,`attempt`)
);
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_runtime_acceptances_update_guard` BEFORE UPDATE ON `finops_pricing_change_runtime_acceptances` BEGIN SELECT RAISE(ABORT,'FINOPS_PRICING_CHANGE_RUNTIME_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_runtime_acceptances_delete_guard` BEFORE DELETE ON `finops_pricing_change_runtime_acceptances` BEGIN SELECT RAISE(ABORT,'FINOPS_PRICING_CHANGE_RUNTIME_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_runtime_failures_update_guard` BEFORE UPDATE ON `finops_pricing_change_runtime_failures` BEGIN SELECT RAISE(ABORT,'FINOPS_PRICING_CHANGE_RUNTIME_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_runtime_failures_delete_guard` BEFORE DELETE ON `finops_pricing_change_runtime_failures` BEGIN SELECT RAISE(ABORT,'FINOPS_PRICING_CHANGE_RUNTIME_IMMUTABLE'); END;
