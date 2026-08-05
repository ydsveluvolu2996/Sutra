ALTER TABLE `cmdb_change_events` ADD `projection_applied` integer DEFAULT 1 NOT NULL
  CHECK (`projection_applied` IN (0, 1));
--> statement-breakpoint
CREATE TABLE `cmdb_resource_projection_states` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `resource_key` text NOT NULL,
  `lifecycle_state` text DEFAULT 'active' NOT NULL
    CHECK (`lifecycle_state` IN ('active', 'retirement_pending', 'retired')),
  `consecutive_complete_misses` integer DEFAULT 0 NOT NULL
    CHECK (`consecutive_complete_misses` >= 0),
  `last_observed_resource_id` text NOT NULL,
  `last_observed_snapshot_id` text NOT NULL,
  `first_missing_snapshot_id` text,
  `state_changed_snapshot_id` text NOT NULL,
  `last_complete_run_id` text NOT NULL,
  `last_complete_run_created_at` integer NOT NULL,
  `retirement_pending_at` integer,
  `retired_at` integer,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `connection_id`, `resource_key`),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`),
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`),
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`),
  FOREIGN KEY (`last_observed_resource_id`) REFERENCES `cmdb_resources`(`id`),
  FOREIGN KEY (`last_observed_snapshot_id`) REFERENCES `cmdb_snapshots`(`id`),
  FOREIGN KEY (`first_missing_snapshot_id`) REFERENCES `cmdb_snapshots`(`id`),
  FOREIGN KEY (`state_changed_snapshot_id`) REFERENCES `cmdb_snapshots`(`id`),
  FOREIGN KEY (`last_complete_run_id`) REFERENCES `sync_runs`(`id`)
);
--> statement-breakpoint
CREATE INDEX `cmdb_resource_projection_scope_state_idx`
  ON `cmdb_resource_projection_states`
  (`org_id`, `customer_id`, `connection_id`, `lifecycle_state`, `resource_key`);
--> statement-breakpoint
INSERT OR IGNORE INTO `cmdb_resource_projection_states`
  (`org_id`, `customer_id`, `connection_id`, `resource_key`,
   `lifecycle_state`, `consecutive_complete_misses`,
   `last_observed_resource_id`, `last_observed_snapshot_id`,
   `first_missing_snapshot_id`, `state_changed_snapshot_id`,
   `last_complete_run_id`, `last_complete_run_created_at`,
   `retirement_pending_at`, `retired_at`, `updated_at`)
SELECT h.org_id, h.customer_id, h.connection_id, r.resource_key,
       'active', 0, r.id, s.id, NULL, s.id, sr.id, sr.created_at,
       NULL, NULL, COALESCE(h.updated_at, s.completed_at, s.collected_at)
  FROM connection_heads h
  JOIN cmdb_snapshots s
    ON s.id = h.snapshot_id AND s.org_id = h.org_id
   AND s.customer_id = h.customer_id AND s.connection_id = h.connection_id
   AND s.status = 'complete'
  JOIN sync_runs sr
    ON sr.id = s.sync_run_id AND sr.org_id = s.org_id
   AND sr.customer_id = s.customer_id AND sr.connection_id = s.connection_id
  JOIN cmdb_resources r
    ON r.snapshot_id = s.id AND r.org_id = s.org_id
   AND r.customer_id = s.customer_id AND r.connection_id = s.connection_id;
