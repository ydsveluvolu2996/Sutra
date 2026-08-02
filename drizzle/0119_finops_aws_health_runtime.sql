CREATE TABLE `finops_aws_health_runtime_attempts` (
  `request_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  `failure_code` text,
  `generation_id` text,
  `lease_token` text NOT NULL,
  `lease_expires_at` integer NOT NULL CHECK (`lease_expires_at` BETWEEN 0 AND 9007199254740991),
  `started_at` integer NOT NULL CHECK (`started_at` BETWEEN 0 AND 9007199254740991),
  `completed_at` integer,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`generation_id`) REFERENCES `finops_aws_health_snapshots`(`generation_id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`scheduled_window`),
  CHECK (length(`request_id`)=68 AND substr(`request_id`,1,4)='hrr_' AND substr(`request_id`,5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`scheduled_window`)=24),
  CHECK (length(`lease_token`)=64 AND `lease_token` NOT GLOB '*[^a-f0-9]*'),
  CHECK ((`state`='IN_PROGRESS' AND `failure_code` IS NULL AND `generation_id` IS NULL AND `completed_at` IS NULL) OR (`state`='FAILED' AND `failure_code` IS NOT NULL AND `generation_id` IS NULL AND `completed_at` IS NOT NULL) OR (`state`='SUCCEEDED' AND `failure_code` IS NULL AND `generation_id` IS NOT NULL AND `completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_aws_health_runtime_attempt_scope_idx` ON `finops_aws_health_runtime_attempts` (`org_id`,`customer_id`,`connection_id`,`updated_at` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_aws_health_runtime_attempt_identity_immutable` BEFORE UPDATE ON `finops_aws_health_runtime_attempts` WHEN OLD.`request_id`<>NEW.`request_id` OR OLD.`org_id`<>NEW.`org_id` OR OLD.`customer_id`<>NEW.`customer_id` OR OLD.`connection_id`<>NEW.`connection_id` OR OLD.`scheduled_window`<>NEW.`scheduled_window` OR OLD.`started_at`<>NEW.`started_at` BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_HEALTH_RUNTIME_IDENTITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_aws_health_runtime_success_immutable` BEFORE UPDATE ON `finops_aws_health_runtime_attempts` WHEN OLD.`state`='SUCCEEDED' BEGIN SELECT RAISE(ABORT,'FINOPS_AWS_HEALTH_RUNTIME_SUCCESS_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TABLE `finops_aws_health_runtime_configuration` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `last_organization_view_status` text NOT NULL CHECK (`last_organization_view_status` IN ('ENABLED','DISABLED','PENDING','UNKNOWN')),
  `enabled_observed_since` text,
  `last_verified_at` text NOT NULL,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  CHECK (length(`last_verified_at`)=24),
  CHECK (`enabled_observed_since` IS NULL OR length(`enabled_observed_since`)=24),
  CHECK ((`last_organization_view_status`='ENABLED') OR `enabled_observed_since` IS NULL)
);
