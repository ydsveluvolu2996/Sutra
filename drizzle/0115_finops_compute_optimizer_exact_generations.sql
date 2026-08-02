-- Exact, immutable Compute Optimizer export generation evidence. Evidence is
-- chunked below D1's 2 MB row limit; only a manifest makes an artifact visible.
CREATE TABLE `finops_co_exact_artifacts` (
  `artifact_id` text PRIMARY KEY NOT NULL,
  `record_kind` text NOT NULL CHECK (`record_kind` IN ('ATTEMPT','GENERATION')),
  `schema_version` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('PARTIAL','ALL_REGION_COMPLETE','ALL_REGION_ACCEPTED')),
  `accepted_head_eligible` integer NOT NULL CHECK (`accepted_head_eligible` IN (0,1)),
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `plan_set_id` text NOT NULL,
  `plan_set_content_sha256` text NOT NULL,
  `requester_account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `content_sha256` text NOT NULL,
  `evidence_sha256` text NOT NULL,
  `scheduled_window` text NOT NULL,
  `materialized_at` text NOT NULL,
  `data_through_at` text NOT NULL,
  `observed_at` text NOT NULL,
  `expected_target_count` integer NOT NULL,
  `mapped_target_count` integer NOT NULL,
  `recommendation_count` integer NOT NULL,
  `rejected_row_count` integer NOT NULL,
  `source_bytes` integer NOT NULL,
  `total_bytes` integer NOT NULL,
  `chunk_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`plan_set_id`) REFERENCES `finops_co_export_plan_sets`(`plan_set_id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`artifact_id`),
  CHECK ((`record_kind` = 'ATTEMPT'
      AND `schema_version` = 'sutra.compute-optimizer-export-generation-attempt.v1'
      AND length(`artifact_id`) = 68 AND substr(`artifact_id`,1,4) = 'coa_'
      AND `state` IN ('PARTIAL','ALL_REGION_COMPLETE') AND `accepted_head_eligible` = 0)
    OR (`record_kind` = 'GENERATION'
      AND `schema_version` = 'sutra.compute-optimizer-export-generation.v1'
      AND length(`artifact_id`) = 68 AND substr(`artifact_id`,1,4) = 'cog_'
      AND `state` = 'ALL_REGION_ACCEPTED' AND `accepted_head_eligible` = 1)),
  CHECK (substr(`artifact_id`,5) = `content_sha256`
    AND length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`evidence_sha256`) = 64 AND `evidence_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`plan_set_id`) = 70 AND substr(`plan_set_id`,1,6) = 'copes_'
    AND substr(`plan_set_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`plan_set_content_sha256`) = 64
    AND `plan_set_content_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`plan_set_id`,7) = `plan_set_content_sha256`),
  CHECK (length(`requester_account_id`) = 12
    AND `requester_account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`scheduled_window`) = 24 AND substr(`scheduled_window`,12) = '00:00:00.000Z'),
  CHECK (length(`materialized_at`) = 24 AND substr(`materialized_at`,24) = 'Z'),
  CHECK (length(`data_through_at`) = 24 AND substr(`data_through_at`,24) = 'Z'),
  CHECK (length(`observed_at`) = 24 AND substr(`observed_at`,24) = 'Z'),
  CHECK (`expected_target_count` BETWEEN 1 AND 400),
  CHECK (`mapped_target_count` BETWEEN 0 AND `expected_target_count`),
  CHECK (`recommendation_count` BETWEEN 0 AND 40000000),
  CHECK (`rejected_row_count` BETWEEN 0 AND 40000000),
  CHECK (`source_bytes` BETWEEN 0 AND 107793612800),
  CHECK (`total_bytes` BETWEEN 1 AND 268435456),
  CHECK (`chunk_count` BETWEEN 1 AND 274),
  CHECK (`created_at` BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE TABLE `finops_co_exact_artifact_chunks` (
  `artifact_id` text NOT NULL,
  `chunk_index` integer NOT NULL,
  `byte_count` integer NOT NULL,
  `chunk_sha256` text NOT NULL,
  `previous_chain_sha256` text NOT NULL,
  `chain_sha256` text NOT NULL,
  `payload_base64url` text NOT NULL,
  PRIMARY KEY (`artifact_id`,`chunk_index`),
  FOREIGN KEY (`artifact_id`) REFERENCES `finops_co_exact_artifacts`(`artifact_id`) ON DELETE RESTRICT,
  CHECK (`chunk_index` BETWEEN 0 AND 273),
  CHECK (`byte_count` BETWEEN 1 AND 983040),
  CHECK (length(`chunk_sha256`) = 64 AND `chunk_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`previous_chain_sha256`) = 64
    AND `previous_chain_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`chain_sha256`) = 64 AND `chain_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`payload_base64url`) = (`byte_count` / 3) * 4
      + CASE (`byte_count` % 3) WHEN 0 THEN 0 WHEN 1 THEN 2 ELSE 3 END
    AND length(`payload_base64url`) BETWEEN 2 AND 1310720
    AND `payload_base64url` NOT GLOB '*[^A-Za-z0-9_-]*')
);
--> statement-breakpoint
CREATE TABLE `finops_co_exact_artifact_manifests` (
  `artifact_id` text PRIMARY KEY NOT NULL,
  `evidence_sha256` text NOT NULL,
  `final_chain_sha256` text NOT NULL,
  `total_bytes` integer NOT NULL,
  `chunk_count` integer NOT NULL,
  `committed_at` integer NOT NULL,
  FOREIGN KEY (`artifact_id`) REFERENCES `finops_co_exact_artifacts`(`artifact_id`) ON DELETE RESTRICT,
  CHECK (length(`evidence_sha256`) = 64 AND `evidence_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`final_chain_sha256`) = 64
    AND `final_chain_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`total_bytes` BETWEEN 1 AND 268435456),
  CHECK (`chunk_count` BETWEEN 1 AND 274),
  CHECK (`committed_at` BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE TABLE `finops_co_exact_generation_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `generation_id` text NOT NULL,
  `data_through_at` text NOT NULL,
  `observed_at` text NOT NULL,
  `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`generation_id`) REFERENCES `finops_co_exact_artifacts`(`artifact_id`) ON DELETE RESTRICT,
  UNIQUE (`generation_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `finops_co_exact_artifacts_history_idx`
  ON `finops_co_exact_artifacts`
  (`org_id`,`customer_id`,`connection_id`,`data_through_at` DESC,`observed_at` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_artifacts_scope_guard`
BEFORE INSERT ON `finops_co_exact_artifacts`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_export_plan_sets` s
  JOIN `aws_connections` c ON c.`id` = s.`connection_id`
    AND c.`org_id` = s.`org_id` AND c.`customer_id` = s.`customer_id`
  JOIN `organizations` o ON o.`id` = s.`org_id` AND o.`status` = 'active'
  JOIN `customers` cu ON cu.`id` = s.`customer_id` AND cu.`org_id` = s.`org_id`
    AND cu.`status` = 'active'
  WHERE s.`plan_set_id` = NEW.`plan_set_id` AND s.`finalized` = 1
    AND s.`org_id` = NEW.`org_id` AND s.`customer_id` = NEW.`customer_id`
    AND s.`connection_id` = NEW.`connection_id`
    AND s.`content_sha256` = NEW.`plan_set_content_sha256`
    AND s.`requester_account_id` = NEW.`requester_account_id`
    AND s.`partition` = NEW.`partition`
    AND c.`source_kind` = 'aws_trust_role' AND c.`status` = 'active'
    AND c.`aws_account_id` = NEW.`requester_account_id`
    AND c.`partition` = NEW.`partition`
    AND (SELECT count(*) FROM `finops_co_export_plan_set_members` sm
      WHERE sm.`plan_set_id` = s.`plan_set_id`) = s.`plan_count`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_artifacts_update_guard`
BEFORE UPDATE ON `finops_co_exact_artifacts`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_ARTIFACT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_artifacts_delete_guard`
BEFORE DELETE ON `finops_co_exact_artifacts`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_ARTIFACT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_chunks_insert_guard`
BEFORE INSERT ON `finops_co_exact_artifact_chunks`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_exact_artifacts` a
  WHERE a.`artifact_id` = NEW.`artifact_id`
    AND NEW.`chunk_index` < a.`chunk_count`
    AND NOT EXISTS (SELECT 1 FROM `finops_co_exact_artifact_manifests` m
      WHERE m.`artifact_id` = NEW.`artifact_id`)
    AND ((NEW.`chunk_index` = 0 AND NEW.`previous_chain_sha256` =
          '0000000000000000000000000000000000000000000000000000000000000000')
      OR (NEW.`chunk_index` > 0 AND EXISTS (
        SELECT 1 FROM `finops_co_exact_artifact_chunks` p
        WHERE p.`artifact_id` = NEW.`artifact_id`
          AND p.`chunk_index` = NEW.`chunk_index` - 1
          AND p.`chain_sha256` = NEW.`previous_chain_sha256`)))
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_CHUNK_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_chunks_update_guard`
BEFORE UPDATE ON `finops_co_exact_artifact_chunks`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_CHUNK_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_chunks_delete_guard`
BEFORE DELETE ON `finops_co_exact_artifact_chunks`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_CHUNK_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_manifests_insert_guard`
BEFORE INSERT ON `finops_co_exact_artifact_manifests`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_exact_artifacts` a
  WHERE a.`artifact_id` = NEW.`artifact_id`
    AND a.`evidence_sha256` = NEW.`evidence_sha256`
    AND a.`total_bytes` = NEW.`total_bytes` AND a.`chunk_count` = NEW.`chunk_count`
    AND (SELECT count(*) FROM `finops_co_exact_artifact_chunks` c
      WHERE c.`artifact_id` = NEW.`artifact_id`) = a.`chunk_count`
    AND (SELECT sum(c.`byte_count`) FROM `finops_co_exact_artifact_chunks` c
      WHERE c.`artifact_id` = NEW.`artifact_id`) = a.`total_bytes`
    AND (SELECT c.`chain_sha256` FROM `finops_co_exact_artifact_chunks` c
      WHERE c.`artifact_id` = NEW.`artifact_id`
      ORDER BY c.`chunk_index` DESC LIMIT 1) = NEW.`final_chain_sha256`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_MANIFEST_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_manifests_update_guard`
BEFORE UPDATE ON `finops_co_exact_artifact_manifests`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_MANIFEST_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_manifests_delete_guard`
BEFORE DELETE ON `finops_co_exact_artifact_manifests`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_MANIFEST_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_heads_insert_guard`
BEFORE INSERT ON `finops_co_exact_generation_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_exact_artifacts` a
  JOIN `finops_co_exact_artifact_manifests` m ON m.`artifact_id` = a.`artifact_id`
  WHERE a.`artifact_id` = NEW.`generation_id` AND a.`record_kind` = 'GENERATION'
    AND a.`schema_version` = 'sutra.compute-optimizer-export-generation.v1'
    AND a.`state` = 'ALL_REGION_ACCEPTED' AND a.`accepted_head_eligible` = 1
    AND a.`org_id` = NEW.`org_id` AND a.`customer_id` = NEW.`customer_id`
    AND a.`connection_id` = NEW.`connection_id`
    AND a.`data_through_at` = NEW.`data_through_at`
    AND a.`observed_at` = NEW.`observed_at`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_heads_update_guard`
BEFORE UPDATE ON `finops_co_exact_generation_heads`
WHEN NOT (
  OLD.`org_id` = NEW.`org_id` AND OLD.`customer_id` = NEW.`customer_id`
  AND OLD.`connection_id` = NEW.`connection_id`
  AND (NEW.`data_through_at` > OLD.`data_through_at`
    OR (NEW.`data_through_at` = OLD.`data_through_at`
      AND NEW.`observed_at` > OLD.`observed_at`))
  AND EXISTS (
    SELECT 1 FROM `finops_co_exact_artifacts` a
    JOIN `finops_co_exact_artifact_manifests` m ON m.`artifact_id` = a.`artifact_id`
    WHERE a.`artifact_id` = NEW.`generation_id` AND a.`record_kind` = 'GENERATION'
      AND a.`schema_version` = 'sutra.compute-optimizer-export-generation.v1'
      AND a.`state` = 'ALL_REGION_ACCEPTED' AND a.`accepted_head_eligible` = 1
      AND a.`org_id` = NEW.`org_id` AND a.`customer_id` = NEW.`customer_id`
      AND a.`connection_id` = NEW.`connection_id`
      AND a.`data_through_at` = NEW.`data_through_at`
      AND a.`observed_at` = NEW.`observed_at`)
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_exact_heads_delete_guard`
BEFORE DELETE ON `finops_co_exact_generation_heads`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXACT_HEAD_IMMUTABLE'); END;
