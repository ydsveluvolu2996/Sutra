CREATE TABLE `security_source_cases` (
  `id` text PRIMARY KEY NOT NULL,
  `case_number` text NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `source_type` text NOT NULL,
  `source_id` text NOT NULL,
  `evidence_sha256` text NOT NULL,
  `title` text NOT NULL,
  `severity` text NOT NULL,
  `priority` text NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `due_at` integer NOT NULL,
  `created_by_user_id` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_id`) REFERENCES `falco_runtime_events`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_source_cases_org_number_uq`
  ON `security_source_cases` (`org_id`, `case_number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_source_cases_active_source_uq`
  ON `security_source_cases` (`org_id`, `customer_id`, `connection_id`, `cluster_id`, `source_type`, `source_id`)
  WHERE `status` != 'closed';
--> statement-breakpoint
CREATE INDEX `security_source_cases_scope_status_idx`
  ON `security_source_cases` (`org_id`, `customer_id`, `connection_id`, `cluster_id`, `status`, `updated_at`);
