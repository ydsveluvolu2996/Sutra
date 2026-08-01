-- Immutable metadata for Pricing Change Analysis captures. Sensitive CUR usage
-- remains in the managed evidence object; only a sealed reference is stored.
CREATE TABLE `finops_pricing_change_materializations` (
  `snapshot_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `evidence_generation_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN (
    'ready', 'partial', 'configuration_required', 'stale', 'no_usage'
  )),
  `content_sha256` text NOT NULL,
  `evidence_reference_ciphertext` text NOT NULL,
  `evidence_reference_key_version` text NOT NULL,
  `captured_at` text NOT NULL,
  `usage_period_start_at` text NOT NULL,
  `usage_period_end_at` text NOT NULL,
  `baseline_effective_at` text NOT NULL,
  `comparison_effective_at` text NOT NULL,
  `active_cur2_generation_id` text NOT NULL,
  `input_line_count` integer NOT NULL,
  `modeled_line_count` integer NOT NULL,
  `excluded_line_count` integer NOT NULL,
  `catalog_snapshot_count` integer NOT NULL,
  `catalog_term_count` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE CASCADE,
  UNIQUE (`org_id`, `customer_id`, `connection_id`, `snapshot_id`),
  UNIQUE (`evidence_generation_id`),
  CHECK (length(`snapshot_id`) = 68 AND substr(`snapshot_id`, 1, 4) = 'pca_'
    AND substr(`snapshot_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`evidence_generation_id`) = 68
    AND substr(`evidence_generation_id`, 1, 4) = 'fss_'
    AND substr(`evidence_generation_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`evidence_reference_ciphertext`) BETWEEN 32 AND 8192
    AND substr(`evidence_reference_ciphertext`, 1, 6) = 'fsev1.'
    AND substr(`evidence_reference_ciphertext`, 7) NOT GLOB '*[^A-Za-z0-9_-]*'),
  CHECK (length(`evidence_reference_key_version`) BETWEEN 1 AND 128),
  CHECK (length(`captured_at`) = 24),
  CHECK (length(`usage_period_start_at`) = 24),
  CHECK (length(`usage_period_end_at`) = 24 AND `usage_period_end_at` > `usage_period_start_at`),
  CHECK (length(`baseline_effective_at`) = 24),
  CHECK (length(`comparison_effective_at`) = 24 AND `comparison_effective_at` > `baseline_effective_at`),
  CHECK (length(`active_cur2_generation_id`) = 68
    AND substr(`active_cur2_generation_id`, 1, 4) = 'gen_'
    AND substr(`active_cur2_generation_id`, 5) NOT GLOB '*[^a-f0-9]*'),
  CHECK (`input_line_count` BETWEEN 0 AND 250000),
  CHECK (`modeled_line_count` BETWEEN 0 AND `input_line_count`),
  CHECK (`excluded_line_count` = `input_line_count` - `modeled_line_count`),
  CHECK (`catalog_snapshot_count` BETWEEN 0 AND 20000),
  CHECK (`catalog_term_count` BETWEEN 0 AND 500000),
  CHECK (`created_at` BETWEEN 0 AND 9007199254740991),
  CHECK (`state` <> 'ready' OR (`input_line_count` > 0
    AND `modeled_line_count` = `input_line_count` AND `excluded_line_count` = 0)),
  CHECK (`state` <> 'no_usage' OR (`input_line_count` = 0
    AND `modeled_line_count` = 0 AND `excluded_line_count` = 0))
);
--> statement-breakpoint
CREATE INDEX `finops_pricing_change_scope_time_idx`
  ON `finops_pricing_change_materializations`
  (`org_id`, `customer_id`, `connection_id`, `captured_at` DESC, `snapshot_id` DESC);
--> statement-breakpoint

CREATE TABLE `finops_pricing_change_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_snapshot_id` text NOT NULL,
  `advanced_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `customer_id`, `connection_id`),
  FOREIGN KEY (`active_snapshot_id`) REFERENCES `finops_pricing_change_materializations`(`snapshot_id`),
  UNIQUE (`active_snapshot_id`),
  CHECK (`advanced_at` BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint

CREATE TRIGGER `finops_pricing_change_immutable_update`
BEFORE UPDATE ON `finops_pricing_change_materializations`
BEGIN SELECT RAISE(ABORT, 'FINOPS_PRICING_CHANGE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_immutable_delete`
BEFORE DELETE ON `finops_pricing_change_materializations`
BEGIN SELECT RAISE(ABORT, 'FINOPS_PRICING_CHANGE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_head_insert_guard`
BEFORE INSERT ON `finops_pricing_change_heads`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_pricing_change_materializations` s
   WHERE s.`snapshot_id` = NEW.`active_snapshot_id`
     AND s.`org_id` = NEW.`org_id` AND s.`customer_id` = NEW.`customer_id`
     AND s.`connection_id` = NEW.`connection_id`
     AND s.`state` IN ('ready', 'no_usage')
)
BEGIN SELECT RAISE(ABORT, 'FINOPS_PRICING_CHANGE_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_head_update_guard`
BEFORE UPDATE ON `finops_pricing_change_heads`
WHEN NEW.`org_id` <> OLD.`org_id` OR NEW.`customer_id` <> OLD.`customer_id`
  OR NEW.`connection_id` <> OLD.`connection_id`
  OR NOT EXISTS (
    SELECT 1 FROM `finops_pricing_change_materializations` candidate
    JOIN `finops_pricing_change_materializations` active
      ON active.`snapshot_id` = OLD.`active_snapshot_id`
   WHERE candidate.`snapshot_id` = NEW.`active_snapshot_id`
     AND candidate.`org_id` = OLD.`org_id` AND candidate.`customer_id` = OLD.`customer_id`
     AND candidate.`connection_id` = OLD.`connection_id`
     AND candidate.`state` IN ('ready', 'no_usage')
     AND (candidate.`captured_at` > active.`captured_at`
       OR (candidate.`captured_at` = active.`captured_at`
         AND candidate.`snapshot_id` > active.`snapshot_id`))
  )
BEGIN SELECT RAISE(ABORT, 'FINOPS_PRICING_CHANGE_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_pricing_change_head_delete_guard`
BEFORE DELETE ON `finops_pricing_change_heads`
BEGIN SELECT RAISE(ABORT, 'FINOPS_PRICING_CHANGE_HEAD_REJECTED'); END;
