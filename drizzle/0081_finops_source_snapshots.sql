-- Immutable, tenant-scoped FinOps source generations. Provider payloads stay
-- in the private evidence store; this ledger retains only a content hash and
-- an application-encrypted reference to that object.
CREATE TABLE `finops_source_snapshots` (
  `generation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `source_id` text NOT NULL,
  `job_id` text NOT NULL,
  `attempt` integer NOT NULL CHECK (`attempt` BETWEEN 1 AND 100),
  `status` text NOT NULL CHECK (
    `status` IN ('ready', 'complete', 'partial', 'failed', 'stale')
  ),
  `content_sha256` text NOT NULL,
  `schema_version` text NOT NULL,
  `collected_at` text NOT NULL,
  `data_through_at` text NOT NULL,
  `coverage_assessment` text NOT NULL CHECK (
    `coverage_assessment` IN ('complete', 'partial', 'unknown')
  ),
  `coverage_expected_records` integer,
  `coverage_observed_records` integer NOT NULL,
  `coverage_missing_records` integer,
  `reconciliation_expected_records` integer,
  `reconciliation_accepted_records` integer NOT NULL,
  `reconciliation_rejected_records` integer NOT NULL,
  `reconciliation_outcome` text NOT NULL CHECK (
    `reconciliation_outcome` IN ('matched', 'mismatched', 'not_run')
  ),
  `evidence_reference_ciphertext` text NOT NULL,
  `evidence_reference_key_version` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (
    `org_id`, `customer_id`, `connection_id`, `source_id`, `job_id`, `attempt`
  ) REFERENCES `finops_source_job_attempts` (
    `org_id`, `customer_id`, `connection_id`, `source_id`, `job_id`, `attempt`
  ),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `source_id`, `generation_id`),
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `source_id`, `job_id`, `attempt`),
  CHECK (
    length(`generation_id`) = 68
    AND substr(`generation_id`, 1, 4) = 'fss_'
    AND substr(`generation_id`, 5) NOT GLOB '*[^a-f0-9]*'
  ),
  CHECK (length(`org_id`) BETWEEN 1 AND 256),
  CHECK (length(`customer_id`) BETWEEN 1 AND 256),
  CHECK (length(`connection_id`) = 37 AND substr(`connection_id`, 1, 5) = 'conn_'),
  CHECK (length(`source_id`) BETWEEN 1 AND 64),
  CHECK (length(`job_id`) BETWEEN 1 AND 256),
  CHECK (
    length(`content_sha256`) = 64
    AND `content_sha256` NOT GLOB '*[^a-f0-9]*'
  ),
  CHECK (length(`schema_version`) BETWEEN 1 AND 128),
  CHECK (length(`collected_at`) = 24),
  CHECK (length(`data_through_at`) = 24),
  CHECK (`data_through_at` <= `collected_at`),
  CHECK (
    (`coverage_expected_records` IS NULL
      OR `coverage_expected_records` BETWEEN 0 AND 9007199254740991)
    AND `coverage_observed_records` BETWEEN 0 AND 9007199254740991
    AND (`coverage_missing_records` IS NULL
      OR `coverage_missing_records` BETWEEN 0 AND 9007199254740991)
    AND (
      (`coverage_expected_records` IS NULL AND `coverage_missing_records` IS NULL)
      OR (
        `coverage_expected_records` IS NOT NULL
        AND `coverage_missing_records` IS NOT NULL
        AND `coverage_observed_records` + `coverage_missing_records`
          = `coverage_expected_records`
      )
    )
    AND (`coverage_assessment` <> 'unknown'
      OR (`coverage_expected_records` IS NULL AND `coverage_missing_records` IS NULL))
    AND (`coverage_assessment` <> 'complete'
      OR COALESCE(`coverage_missing_records`, 0) = 0)
  ),
  CHECK (
    (`reconciliation_expected_records` IS NULL
      OR `reconciliation_expected_records` BETWEEN 0 AND 9007199254740991)
    AND `reconciliation_accepted_records` BETWEEN 0 AND 9007199254740991
    AND `reconciliation_rejected_records` BETWEEN 0 AND 9007199254740991
    AND (
      `reconciliation_expected_records` IS NULL
      OR `reconciliation_accepted_records` + `reconciliation_rejected_records`
        <= `reconciliation_expected_records`
    )
  ),
  CHECK (
    `status` NOT IN ('ready', 'complete')
    OR (
      `coverage_assessment` = 'complete'
      AND COALESCE(`coverage_missing_records`, 0) = 0
      AND `reconciliation_outcome` = 'matched'
      AND `reconciliation_rejected_records` = 0
      AND (`reconciliation_expected_records` IS NULL
        OR `reconciliation_accepted_records` = `reconciliation_expected_records`)
    )
  ),
  CHECK (
    length(`evidence_reference_ciphertext`) BETWEEN 32 AND 8192
    AND substr(`evidence_reference_ciphertext`, 1, 6) = 'fsev1.'
    AND substr(`evidence_reference_ciphertext`, 7) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CHECK (length(`evidence_reference_key_version`) BETWEEN 1 AND 128),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `finops_source_snapshots_scope_source_time_idx`
  ON `finops_source_snapshots` (
    `org_id`, `customer_id`, `connection_id`, `source_id`,
    `data_through_at` DESC, `collected_at` DESC, `generation_id` DESC
  );
--> statement-breakpoint
CREATE INDEX `finops_source_snapshots_job_attempt_idx`
  ON `finops_source_snapshots` (
    `org_id`, `customer_id`, `connection_id`, `source_id`, `job_id`, `attempt`
  );
--> statement-breakpoint

-- The one mutable row per source. It can point only at an accepted immutable
-- generation in the same exact tenant/customer/connection/source scope.
CREATE TABLE `finops_source_snapshot_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `source_id` text NOT NULL,
  `active_generation_id` text NOT NULL,
  `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`, `source_id`),
  FOREIGN KEY (
    `org_id`, `customer_id`, `connection_id`, `source_id`, `active_generation_id`
  ) REFERENCES `finops_source_snapshots` (
    `org_id`, `customer_id`, `connection_id`, `source_id`, `generation_id`
  ),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finops_source_snapshot_heads_generation_uq`
  ON `finops_source_snapshot_heads` (`active_generation_id`);
--> statement-breakpoint

CREATE TRIGGER `finops_source_snapshots_attempt_guard`
BEFORE INSERT ON `finops_source_snapshots`
WHEN NOT EXISTS (
  SELECT 1
    FROM `finops_source_job_attempts` a
   WHERE a.`org_id` = NEW.`org_id`
     AND a.`customer_id` = NEW.`customer_id`
     AND a.`connection_id` = NEW.`connection_id`
     AND a.`source_id` = NEW.`source_id`
     AND a.`job_id` = NEW.`job_id`
     AND a.`attempt` = NEW.`attempt`
     AND a.`status` IN ('succeeded', 'partial', 'failed', 'cancelled')
     AND (a.`accepted_records` IS NULL
       OR a.`accepted_records` = NEW.`reconciliation_accepted_records`)
     AND (a.`rejected_records` IS NULL
       OR a.`rejected_records` = NEW.`reconciliation_rejected_records`)
     AND (a.`expected_records` IS NULL
       OR a.`expected_records` = NEW.`reconciliation_expected_records`)
     AND (
       (NEW.`status` IN ('ready', 'complete')
         AND a.`status` = 'succeeded'
         AND a.`reconciliation_outcome` = 'matched')
       OR (NEW.`status` = 'partial' AND a.`status` = 'partial')
       OR (NEW.`status` = 'failed' AND a.`status` IN ('failed', 'cancelled'))
       OR (NEW.`status` = 'stale' AND a.`status` IN ('succeeded', 'partial'))
     )
)
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_SNAPSHOT_ATTEMPT_REJECTED');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_source_snapshots_immutable_update`
BEFORE UPDATE ON `finops_source_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_SNAPSHOT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_source_snapshots_immutable_delete`
BEFORE DELETE ON `finops_source_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_SNAPSHOT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_source_snapshot_heads_insert_guard`
BEFORE INSERT ON `finops_source_snapshot_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_source_snapshots` s
   WHERE s.`org_id` = NEW.`org_id`
     AND s.`customer_id` = NEW.`customer_id`
     AND s.`connection_id` = NEW.`connection_id`
     AND s.`source_id` = NEW.`source_id`
     AND s.`generation_id` = NEW.`active_generation_id`
     AND s.`created_at` <= NEW.`advanced_at`
     AND s.`status` IN ('ready', 'complete')
     AND s.`coverage_assessment` = 'complete'
     AND COALESCE(s.`coverage_missing_records`, 0) = 0
     AND s.`reconciliation_outcome` = 'matched'
     AND s.`reconciliation_rejected_records` = 0
     AND (s.`reconciliation_expected_records` IS NULL
       OR s.`reconciliation_accepted_records` = s.`reconciliation_expected_records`)
)
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_SNAPSHOT_NOT_ACCEPTED');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_source_snapshot_heads_update_guard`
BEFORE UPDATE ON `finops_source_snapshot_heads`
WHEN
  NEW.`org_id` <> OLD.`org_id`
  OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`connection_id` <> OLD.`connection_id`
  OR NEW.`source_id` <> OLD.`source_id`
  OR NEW.`advanced_at` < OLD.`advanced_at`
  OR NOT EXISTS (
    SELECT 1
      FROM `finops_source_snapshots` candidate
      JOIN `finops_source_snapshots` active
        ON active.`org_id` = OLD.`org_id`
       AND active.`customer_id` = OLD.`customer_id`
       AND active.`connection_id` = OLD.`connection_id`
       AND active.`source_id` = OLD.`source_id`
       AND active.`generation_id` = OLD.`active_generation_id`
     WHERE candidate.`org_id` = NEW.`org_id`
       AND candidate.`customer_id` = NEW.`customer_id`
       AND candidate.`connection_id` = NEW.`connection_id`
       AND candidate.`source_id` = NEW.`source_id`
       AND candidate.`generation_id` = NEW.`active_generation_id`
       AND candidate.`created_at` <= NEW.`advanced_at`
       AND candidate.`status` IN ('ready', 'complete')
       AND candidate.`coverage_assessment` = 'complete'
       AND COALESCE(candidate.`coverage_missing_records`, 0) = 0
       AND candidate.`reconciliation_outcome` = 'matched'
       AND candidate.`reconciliation_rejected_records` = 0
       AND (candidate.`reconciliation_expected_records` IS NULL
         OR candidate.`reconciliation_accepted_records`
           = candidate.`reconciliation_expected_records`)
       AND (
         candidate.`data_through_at` > active.`data_through_at`
         OR (
           candidate.`data_through_at` = active.`data_through_at`
           AND candidate.`collected_at` > active.`collected_at`
         )
       )
  )
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_SNAPSHOT_HEAD_ADVANCE_REJECTED');
END;
--> statement-breakpoint
CREATE TRIGGER `finops_source_snapshot_heads_immutable_delete`
BEFORE DELETE ON `finops_source_snapshot_heads`
BEGIN
  SELECT RAISE(ABORT, 'FINOPS_SOURCE_SNAPSHOT_HEAD_IMMUTABLE');
END;
