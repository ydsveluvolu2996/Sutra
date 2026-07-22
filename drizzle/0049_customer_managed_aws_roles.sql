ALTER TABLE `aws_connections` ADD `role_provisioning_mode` text DEFAULT 'sutra_template' NOT NULL;
--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `expected_role_path` text DEFAULT '/sutra/' NOT NULL;
--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `expected_role_name` text DEFAULT 'SutraReadOnlyRole' NOT NULL;
--> statement-breakpoint
ALTER TABLE `aws_connections` ADD `permission_capabilities_json` text;
