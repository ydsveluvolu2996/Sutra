CREATE TABLE `scim_connectors` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `name` text NOT NULL,
  `token_prefix` text NOT NULL,
  `token_sha256` text NOT NULL,
  `identity_issuer` text NOT NULL,
  `subject_source` text NOT NULL,
  `role_mappings_json` text DEFAULT '{}' NOT NULL,
  `expires_at` integer,
  `last_used_at` integer,
  `rotated_at` integer,
  `revoked_at` integer,
  `created_by` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_connectors_token_sha256_uq` ON `scim_connectors` (`token_sha256`);
--> statement-breakpoint
CREATE INDEX `scim_connectors_org_created_idx` ON `scim_connectors` (`org_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `scim_user_links` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `user_id` text NOT NULL,
  `external_id` text,
  `version` integer DEFAULT 1 NOT NULL,
  `mutation_nonce` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connector_id`) REFERENCES `scim_connectors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_links_connector_user_uq` ON `scim_user_links` (`connector_id`,`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_links_connector_external_uq` ON `scim_user_links` (`connector_id`,`external_id`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `scim_user_links_scope_idx` ON `scim_user_links` (`org_id`,`connector_id`,`updated_at`,`id`);
--> statement-breakpoint
CREATE TABLE `scim_groups` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `external_id` text,
  `display_name` text NOT NULL,
  `mapped_role` text,
  `version` integer DEFAULT 1 NOT NULL,
  `mutation_nonce` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connector_id`) REFERENCES `scim_connectors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_groups_connector_external_uq` ON `scim_groups` (`connector_id`,`external_id`) WHERE `external_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `scim_groups_scope_name_idx` ON `scim_groups` (`org_id`,`connector_id`,`display_name`,`id`);
--> statement-breakpoint
CREATE TABLE `scim_group_members` (
  `org_id` text NOT NULL,
  `connector_id` text NOT NULL,
  `group_id` text NOT NULL,
  `scim_user_id` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY (`group_id`,`scim_user_id`),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connector_id`) REFERENCES `scim_connectors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`group_id`) REFERENCES `scim_groups`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`scim_user_id`) REFERENCES `scim_user_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scim_group_members_user_idx` ON `scim_group_members` (`org_id`,`connector_id`,`scim_user_id`,`group_id`);
--> statement-breakpoint
CREATE TABLE `scim_audit_events` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `connector_id` text,
  `actor_type` text NOT NULL,
  `actor_id` text NOT NULL,
  `action` text NOT NULL,
  `target_type` text NOT NULL,
  `target_id` text,
  `outcome` text NOT NULL,
  `request_id` text NOT NULL,
  `metadata_json` text DEFAULT '{}' NOT NULL,
  `occurred_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`connector_id`) REFERENCES `scim_connectors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_audit_events_org_request_uq` ON `scim_audit_events` (`org_id`,`request_id`);
--> statement-breakpoint
CREATE INDEX `scim_audit_events_scope_time_idx` ON `scim_audit_events` (`org_id`,`occurred_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `scim_audit_events_no_update` BEFORE UPDATE ON `scim_audit_events`
BEGIN SELECT RAISE(ABORT, 'SCIM audit events are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `scim_audit_events_no_delete` BEFORE DELETE ON `scim_audit_events`
BEGIN SELECT RAISE(ABORT, 'SCIM audit events are immutable'); END;
