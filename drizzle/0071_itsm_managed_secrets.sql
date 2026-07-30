ALTER TABLE `itsm_connectors` ADD `secret_storage` text DEFAULT 'local' NOT NULL
  CHECK (`secret_storage` IN ('local', 'managed'));
--> statement-breakpoint
ALTER TABLE `itsm_connectors` ADD `secret_reference` text;
--> statement-breakpoint
ALTER TABLE `itsm_connectors` ADD `secret_preview` text DEFAULT 'local' NOT NULL;
--> statement-breakpoint
CREATE INDEX `itsm_connectors_secret_storage_idx`
  ON `itsm_connectors` (`org_id`, `customer_id`, `enabled`, `secret_storage`);
