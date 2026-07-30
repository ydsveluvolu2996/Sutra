CREATE TABLE `evidence_objects` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL REFERENCES `organizations`(`id`),
  `customer_id` text NOT NULL REFERENCES `customers`(`id`),
  `connection_id` text NOT NULL REFERENCES `aws_connections`(`id`),
  `run_id` text NOT NULL,
  `snapshot_id` text,
  `artifact_kind` text NOT NULL CHECK (`artifact_kind` IN ('aws_snapshot_raw', 'export_json', 'export_csv')),
  `object_key` text NOT NULL,
  `content_type` text NOT NULL,
  `content_sha256` text NOT NULL,
  `byte_size` integer NOT NULL CHECK (`byte_size` > 0 AND `byte_size` <= 12582912),
  `status` text DEFAULT 'staging' NOT NULL CHECK (`status` IN ('staging', 'available', 'failed')),
  `retention_until` integer NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `available_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_objects_key_uq` ON `evidence_objects` (`object_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_objects_run_kind_uq`
  ON `evidence_objects` (`org_id`, `connection_id`, `run_id`, `artifact_kind`);
--> statement-breakpoint
CREATE INDEX `evidence_objects_scope_time_idx`
  ON `evidence_objects` (`org_id`, `customer_id`, `connection_id`, `created_at`, `id`);
--> statement-breakpoint
CREATE TABLE `evidence_download_grants` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL REFERENCES `organizations`(`id`),
  `customer_id` text NOT NULL REFERENCES `customers`(`id`),
  `object_id` text NOT NULL REFERENCES `evidence_objects`(`id`),
  `actor_id` text NOT NULL,
  `purpose` text NOT NULL CHECK (`purpose` IN ('raw_evidence_review', 'export_download')),
  `token_sha256` text NOT NULL,
  `expires_at` integer NOT NULL,
  `consumed_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_download_grants_token_uq`
  ON `evidence_download_grants` (`token_sha256`);
--> statement-breakpoint
CREATE INDEX `evidence_download_grants_scope_expiry_idx`
  ON `evidence_download_grants` (`org_id`, `customer_id`, `actor_id`, `expires_at`);
--> statement-breakpoint
-- Used only by explicit local/development mode. Managed production stores no
-- payload bytes in PostgreSQL/D1; it uses the private SSE-KMS S3 bucket.
CREATE TABLE `evidence_local_payloads` (
  `object_id` text PRIMARY KEY NOT NULL REFERENCES `evidence_objects`(`id`),
  `content_sha256` text NOT NULL,
  `byte_size` integer NOT NULL,
  `body_base64` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `evidence_objects_immutable_identity`
BEFORE UPDATE OF `org_id`, `customer_id`, `connection_id`, `run_id`, `snapshot_id`,
  `artifact_kind`, `object_key`, `content_type`, `content_sha256`, `byte_size`,
  `retention_until`, `created_by`, `created_at`
ON `evidence_objects`
BEGIN
  SELECT RAISE(ABORT, 'immutable evidence identity');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_objects_no_delete`
BEFORE DELETE ON `evidence_objects`
BEGIN
  SELECT RAISE(ABORT, 'immutable evidence object');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_download_grants_immutable_binding`
BEFORE UPDATE OF `org_id`, `customer_id`, `object_id`, `actor_id`, `purpose`,
  `token_sha256`, `expires_at`, `created_at`
ON `evidence_download_grants`
BEGIN
  SELECT RAISE(ABORT, 'immutable evidence grant binding');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_download_grants_no_delete`
BEFORE DELETE ON `evidence_download_grants`
BEGIN
  SELECT RAISE(ABORT, 'immutable evidence grant');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_local_payloads_no_update`
BEFORE UPDATE ON `evidence_local_payloads`
BEGIN
  SELECT RAISE(ABORT, 'immutable local evidence payload');
END;
--> statement-breakpoint
CREATE TRIGGER `evidence_local_payloads_no_delete`
BEFORE DELETE ON `evidence_local_payloads`
BEGIN
  SELECT RAISE(ABORT, 'immutable local evidence payload');
END;
