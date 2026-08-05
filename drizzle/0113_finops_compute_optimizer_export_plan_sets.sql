-- Immutable all-Region activation sets over sealed regional Compute Optimizer plans.
-- No bucket, prefix, object key, or plaintext plan is stored here.
CREATE TABLE `finops_co_export_plan_sets` (
  `plan_set_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `content_sha256` text NOT NULL,
  `requester_account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `regions_json` text NOT NULL,
  `export_families_json` text NOT NULL,
  `plan_ids_json` text NOT NULL,
  `region_count` integer NOT NULL,
  `export_family_count` integer NOT NULL,
  `plan_count` integer NOT NULL,
  `binding_sha256` text NOT NULL,
  `finalized` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`plan_set_id`),
  CHECK (length(`plan_set_id`) = 70 AND substr(`plan_set_id`,1,6) = 'copes_'
    AND substr(`plan_set_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`) = 64
    AND `content_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`plan_set_id`,7) = `content_sha256`),
  CHECK (length(`requester_account_id`) = 12
    AND `requester_account_id` NOT GLOB '*[^0-9]*'),
  CHECK (json_valid(`regions_json`) AND json_type(`regions_json`) = 'array'
    AND length(`regions_json`) BETWEEN 12 AND 1751),
  CHECK (json_valid(`export_families_json`) AND json_type(`export_families_json`) = 'array'
    AND length(`export_families_json`) BETWEEN 4 AND 257),
  CHECK (json_valid(`plan_ids_json`) AND json_type(`plan_ids_json`) = 'array'
    AND length(`plan_ids_json`) BETWEEN 73 AND 3651),
  CHECK (`region_count` BETWEEN 1 AND 50
    AND json_array_length(`regions_json`) = `region_count`),
  CHECK (`export_family_count` BETWEEN 1 AND 8
    AND json_array_length(`export_families_json`) = `export_family_count`),
  CHECK (`plan_count` = `region_count`
    AND json_array_length(`plan_ids_json`) = `plan_count`),
  CHECK (length(`binding_sha256`) = 64
    AND `binding_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`finalized` IN (0,1)),
  CHECK (`created_at` BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE TABLE `finops_co_export_plan_set_members` (
  `plan_set_id` text NOT NULL,
  `position` integer NOT NULL,
  `region` text NOT NULL,
  `plan_id` text NOT NULL,
  PRIMARY KEY (`plan_set_id`,`position`),
  FOREIGN KEY (`plan_set_id`) REFERENCES `finops_co_export_plan_sets`(`plan_set_id`)
    ON DELETE RESTRICT,
  FOREIGN KEY (`plan_id`) REFERENCES `finops_co_export_plans`(`plan_id`) ON DELETE RESTRICT,
  UNIQUE (`plan_set_id`,`region`),
  UNIQUE (`plan_set_id`,`plan_id`),
  UNIQUE (`plan_id`),
  CHECK (`position` BETWEEN 0 AND 49),
  CHECK (length(`region`) BETWEEN 9 AND 32
    AND `region` NOT GLOB '*[^a-z0-9-]*'
    AND (
      (substr(`region`,3,1) = '-'
        AND substr(`region`,-2,1) = '-'
        AND substr(`region`,-1,1) GLOB '[0-9]'
        AND length(substr(`region`,4,length(`region`)-5)) >= 1
        AND substr(`region`,4,length(`region`)-5) NOT GLOB '*[^a-z]*')
      OR
      (substr(`region`,3,5) = '-gov-'
        AND substr(`region`,-2,1) = '-'
        AND substr(`region`,-1,1) GLOB '[0-9]'
        AND length(substr(`region`,8,length(`region`)-9)) >= 1
        AND substr(`region`,8,length(`region`)-9) NOT GLOB '*[^a-z]*')
    )),
  CHECK (length(`plan_id`) = 69 AND substr(`plan_id`,1,5) = 'cope_'
    AND substr(`plan_id`,6) NOT GLOB '*[^a-f0-9]*')
);
--> statement-breakpoint
CREATE INDEX `finops_co_export_plan_sets_history_idx`
  ON `finops_co_export_plan_sets`
  (`org_id`,`customer_id`,`connection_id`,`created_at` DESC,`plan_set_id` DESC);
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plan_sets_scope_guard`
BEFORE INSERT ON `finops_co_export_plan_sets`
WHEN NOT EXISTS (
  SELECT 1 FROM `aws_connections` c
  JOIN `organizations` o ON o.`id` = c.`org_id` AND o.`status` = 'active'
  JOIN `customers` cu ON cu.`id` = c.`customer_id` AND cu.`org_id` = c.`org_id`
    AND cu.`status` = 'active'
  WHERE c.`org_id` = NEW.`org_id` AND c.`customer_id` = NEW.`customer_id`
    AND c.`id` = NEW.`connection_id` AND c.`aws_account_id` = NEW.`requester_account_id`
    AND c.`partition` = NEW.`partition` AND c.`source_kind` = 'aws_trust_role'
    AND c.`status` = 'active'
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SET_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plan_set_members_scope_guard`
BEFORE INSERT ON `finops_co_export_plan_set_members`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_export_plan_sets` s
  JOIN `finops_co_export_plans` p ON p.`plan_id` = NEW.`plan_id`
  WHERE s.`plan_set_id` = NEW.`plan_set_id` AND s.`finalized` = 0
    AND NEW.`position` < s.`plan_count`
    AND json_extract(s.`regions_json`,'$[' || NEW.`position` || ']') = NEW.`region`
    AND json_extract(s.`plan_ids_json`,'$[' || NEW.`position` || ']') = NEW.`plan_id`
    AND p.`org_id` = s.`org_id` AND p.`customer_id` = s.`customer_id`
    AND p.`connection_id` = s.`connection_id`
    AND p.`requester_account_id` = s.`requester_account_id`
    AND p.`partition` = s.`partition` AND p.`region` = NEW.`region`
    AND p.`export_family_count` = s.`export_family_count`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SET_MEMBER_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plan_sets_finalize_guard`
BEFORE UPDATE OF `finalized` ON `finops_co_export_plan_sets`
WHEN NOT (
  OLD.`finalized` = 0 AND NEW.`finalized` = 1
  AND OLD.`plan_set_id` = NEW.`plan_set_id`
  AND OLD.`org_id` = NEW.`org_id` AND OLD.`customer_id` = NEW.`customer_id`
  AND OLD.`connection_id` = NEW.`connection_id`
  AND OLD.`content_sha256` = NEW.`content_sha256`
  AND OLD.`requester_account_id` = NEW.`requester_account_id`
  AND OLD.`partition` = NEW.`partition`
  AND OLD.`regions_json` = NEW.`regions_json`
  AND OLD.`export_families_json` = NEW.`export_families_json`
  AND OLD.`plan_ids_json` = NEW.`plan_ids_json`
  AND OLD.`region_count` = NEW.`region_count`
  AND OLD.`export_family_count` = NEW.`export_family_count`
  AND OLD.`plan_count` = NEW.`plan_count`
  AND OLD.`binding_sha256` = NEW.`binding_sha256`
  AND OLD.`created_at` = NEW.`created_at`
  AND (SELECT count(*) FROM `finops_co_export_plan_set_members` m
    WHERE m.`plan_set_id` = OLD.`plan_set_id`) = OLD.`plan_count`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SET_FINALIZE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plan_sets_update_guard`
BEFORE UPDATE ON `finops_co_export_plan_sets`
WHEN NOT (OLD.`finalized` = 0 AND NEW.`finalized` = 1)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plan_sets_delete_guard`
BEFORE DELETE ON `finops_co_export_plan_sets`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plan_set_members_update_guard`
BEFORE UPDATE ON `finops_co_export_plan_set_members`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_export_plan_set_members_delete_guard`
BEFORE DELETE ON `finops_co_export_plan_set_members`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_SET_IMMUTABLE'); END;
