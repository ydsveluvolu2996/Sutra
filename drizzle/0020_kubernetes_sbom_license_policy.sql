CREATE TABLE `kubernetes_sbom_license_policy_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `policy_id` text NOT NULL,
  `version` integer NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `policy_name` text NOT NULL,
  `policy_json` text NOT NULL,
  `policy_sha256` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_sbom_license_policy_version_uq`
  ON `kubernetes_sbom_license_policy_versions` (`policy_id`, `version`);
--> statement-breakpoint
CREATE INDEX `kubernetes_sbom_license_policy_scope_idx`
  ON `kubernetes_sbom_license_policy_versions`
  (`org_id`, `customer_id`, `cluster_id`, `policy_id`, `version`);
--> statement-breakpoint
CREATE TABLE `kubernetes_sbom_license_policy_heads` (
  `policy_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `cluster_id` text NOT NULL,
  `policy_name` text NOT NULL,
  `current_version` integer NOT NULL,
  `current_version_id` text NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`current_version_id`) REFERENCES `kubernetes_sbom_license_policy_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_sbom_license_policy_name_uq`
  ON `kubernetes_sbom_license_policy_heads`
  (`org_id`, `customer_id`, `cluster_id`, `policy_name`);
--> statement-breakpoint
CREATE TRIGGER `kubernetes_sbom_license_policy_version_no_update`
BEFORE UPDATE ON `kubernetes_sbom_license_policy_versions`
BEGIN SELECT RAISE(ABORT, 'kubernetes SBOM license policy version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_sbom_license_policy_version_no_delete`
BEFORE DELETE ON `kubernetes_sbom_license_policy_versions`
BEGIN SELECT RAISE(ABORT, 'kubernetes SBOM license policy version is immutable'); END;
