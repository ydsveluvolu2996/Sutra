-- Immutable, server-owned discovery/outbox records for canonical billing ingest.
-- Browser/API callers may select an observation id, but can never supply AWS
-- object coordinates or reconciliation totals to the durable job.
CREATE TABLE `finops_data_export_observations` (
  `id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `customer_id` text NOT NULL REFERENCES `customers`(`id`) ON DELETE CASCADE,
  `connection_id` text NOT NULL REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  `payload_json` text NOT NULL,
  `payload_sha256` text NOT NULL,
  `producer_key_id` text NOT NULL,
  `producer_operation_id` text NOT NULL,
  `producer_nonce` text NOT NULL,
  `producer_body_sha256` text NOT NULL,
  `observed_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `payload_sha256`),
  CHECK (
    `id` GLOB 'fdo_*'
    AND length(`id`) = 36
    AND substr(`id`, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(`payload_json`) BETWEEN 2 AND 24576),
  CHECK (
    length(`payload_sha256`) = 64
    AND `payload_sha256` NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(`producer_key_id`) BETWEEN 1 AND 64),
  CHECK (length(`producer_operation_id`) BETWEEN 1 AND 128),
  CHECK (length(`producer_nonce`) BETWEEN 22 AND 128),
  CHECK (
    length(`producer_body_sha256`) = 64
    AND `producer_body_sha256` NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (`observed_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `finops_data_export_observations_scope_idx`
  ON `finops_data_export_observations`
  (`org_id`, `customer_id`, `connection_id`, `observed_at` DESC, `id` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_data_export_observations_no_update`
BEFORE UPDATE ON `finops_data_export_observations`
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_DATA_EXPORT_OBSERVATION_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_data_export_observations_no_delete`
BEFORE DELETE ON `finops_data_export_observations`
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_DATA_EXPORT_OBSERVATION_IMMUTABLE');
END;
