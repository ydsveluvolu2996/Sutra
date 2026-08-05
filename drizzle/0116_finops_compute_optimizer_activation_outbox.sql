-- Separate .8.5 Compute Optimizer capability, daily activation checkpoint and
-- deterministic materializer outbox. Provider topology is deliberately absent
-- from capability/activation rows; the outbox retains only the already-validated
-- materializer queue contract, whose regional contract values are opaque IDs.
CREATE TABLE `finops_co_materialization_capabilities` (
  `capability_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `permission_pack_version` text NOT NULL CHECK (`permission_pack_version`='standard-2026-08.5'),
  `regions_json` text NOT NULL,
  `region_count` integer NOT NULL CHECK (`region_count` BETWEEN 1 AND 50),
  `manifest_sha256` text NOT NULL,
  `verified_at` integer NOT NULL CHECK (`verified_at` BETWEEN 0 AND 8640000000000000),
  `state` text NOT NULL CHECK (`state` IN ('ENABLED','DISABLED')),
  `content_sha256` text NOT NULL,
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`capability_id`),
  CHECK (length(`capability_id`)=69 AND substr(`capability_id`,1,5)='cocp_'
    AND substr(`capability_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_id`)=12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (json_valid(`regions_json`) AND json_type(`regions_json`)='array'
    AND json_array_length(`regions_json`)=`region_count`
    AND length(`regions_json`) BETWEEN 12 AND 1751),
  CHECK (length(`manifest_sha256`)=64 AND `manifest_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`capability_id`,6)=`content_sha256`)
);
--> statement-breakpoint
CREATE TABLE `finops_co_materialization_capability_heads` (
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `active_capability_id` text NOT NULL UNIQUE,
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (`org_id`,`customer_id`,`connection_id`),
  FOREIGN KEY (`active_capability_id`) REFERENCES `finops_co_materialization_capabilities`(`capability_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `finops_co_activation_runs` (
  `activation_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `capability_id` text NOT NULL,
  `account_id` text NOT NULL,
  `partition` text NOT NULL CHECK (`partition` IN ('aws','aws-us-gov','aws-cn')),
  `scheduled_window` text NOT NULL,
  `sealed_at` integer NOT NULL CHECK (`sealed_at` BETWEEN 0 AND 8640000000000000),
  `attempt` integer NOT NULL CHECK (`attempt` BETWEEN 1 AND 25),
  `state` text NOT NULL CHECK (`state` IN (
    'SEALED','RECONCILING','DISCOVERY_PENDING','MATERIALIZATION_PENDING','COMPLETE','FAILED'
  )),
  `activation_content_sha256` text NOT NULL,
  `plan_checkpoint_id` text,
  `plan_checkpoint_sha256` text,
  `plan_set_id` text,
  `discovery_lineage_sha256` text,
  `failure_code_sha256` text,
  `revision` integer NOT NULL CHECK (`revision` BETWEEN 0 AND 1000),
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 8640000000000000),
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`connection_id`) REFERENCES `aws_connections`(`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`capability_id`) REFERENCES `finops_co_materialization_capabilities`(`capability_id`) ON DELETE RESTRICT,
  FOREIGN KEY (`plan_set_id`) REFERENCES `finops_co_export_plan_sets`(`plan_set_id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`scheduled_window`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`activation_id`),
  CHECK (length(`activation_id`)=70 AND substr(`activation_id`,1,6)='comra_'
    AND substr(`activation_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`account_id`)=12 AND `account_id` NOT GLOB '*[^0-9]*'),
  CHECK (length(`scheduled_window`)=24 AND substr(`scheduled_window`,12)='00:00:00.000Z'),
  CHECK (length(`activation_content_sha256`)=64
    AND `activation_content_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`activation_id`,7)=`activation_content_sha256`),
  CHECK (`plan_checkpoint_id` IS NULL OR (length(`plan_checkpoint_id`)=70
    AND substr(`plan_checkpoint_id`,1,6)='comrp_'
    AND substr(`plan_checkpoint_id`,7) NOT GLOB '*[^a-f0-9]*')),
  CHECK (`plan_checkpoint_sha256` IS NULL OR (length(`plan_checkpoint_sha256`)=64
    AND `plan_checkpoint_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`plan_checkpoint_id`,7)=`plan_checkpoint_sha256`)),
  CHECK (`discovery_lineage_sha256` IS NULL OR (length(`discovery_lineage_sha256`)=64
    AND `discovery_lineage_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK (`failure_code_sha256` IS NULL OR (length(`failure_code_sha256`)=64
    AND `failure_code_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK ((`state` IN ('MATERIALIZATION_PENDING','COMPLETE')
      AND `plan_checkpoint_id` IS NOT NULL AND `plan_checkpoint_sha256` IS NOT NULL
      AND `plan_set_id` IS NOT NULL AND `discovery_lineage_sha256` IS NOT NULL)
    OR (`state` NOT IN ('MATERIALIZATION_PENDING','COMPLETE')
      AND `plan_checkpoint_id` IS NULL AND `plan_checkpoint_sha256` IS NULL
      AND `plan_set_id` IS NULL AND `discovery_lineage_sha256` IS NULL)),
  CHECK ((`state`='FAILED' AND `failure_code_sha256` IS NOT NULL)
    OR (`state`<>'FAILED' AND `failure_code_sha256` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `finops_co_activation_launch_checkpoints` (
  `checkpoint_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `activation_id` text NOT NULL,
  `region` text NOT NULL,
  `attempt` integer NOT NULL CHECK (`attempt` BETWEEN 1 AND 25),
  `launch_attempt_id` text NOT NULL,
  `launch_attempt_sha256` text NOT NULL,
  `execution_id` text NOT NULL,
  `execution_sha256` text NOT NULL,
  `launch_outcome_proof_sha256` text NOT NULL,
  `content_sha256` text NOT NULL,
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (`activation_id`) REFERENCES `finops_co_activation_runs`(`activation_id`) ON DELETE RESTRICT,
  UNIQUE (`activation_id`,`region`),
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`checkpoint_id`),
  CHECK (length(`checkpoint_id`)=70 AND substr(`checkpoint_id`,1,6)='coalc_'
    AND substr(`checkpoint_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`region`) BETWEEN 9 AND 32 AND `region` NOT GLOB '*[^a-z0-9-]*'),
  CHECK (length(`launch_attempt_id`)=70 AND substr(`launch_attempt_id`,1,6)='coela_'
    AND substr(`launch_attempt_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`launch_attempt_sha256`)=64
    AND `launch_attempt_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`launch_attempt_id`,7)=`launch_attempt_sha256`),
  CHECK (length(`execution_id`)=70 AND substr(`execution_id`,1,6)='coele_'
    AND substr(`execution_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`execution_sha256`)=64 AND `execution_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`execution_id`,7)=`execution_sha256`),
  CHECK (length(`launch_outcome_proof_sha256`)=64
    AND `launch_outcome_proof_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`content_sha256`)=64 AND `content_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`checkpoint_id`,7)=`content_sha256`)
);
--> statement-breakpoint
CREATE TABLE `finops_co_discovery_evidence_seals` (
  `seal_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `run_id` text NOT NULL UNIQUE,
  `evidence_content_sha256` text NOT NULL,
  `object_id` text NOT NULL UNIQUE,
  `binding_sha256` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('RESERVING','SEALED')),
  `claim_token_sha256` text NOT NULL,
  `lease_expires_at` integer NOT NULL CHECK (`lease_expires_at` BETWEEN 0 AND 8640000000000000),
  `ciphertext` text,
  `key_version` text,
  `ciphertext_sha256` text,
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 8640000000000000),
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (`run_id`) REFERENCES `finops_co_discovery_runs`(`run_id`) ON DELETE RESTRICT,
  FOREIGN KEY (`object_id`) REFERENCES `evidence_objects`(`id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`seal_id`),
  CHECK (length(`seal_id`)=69 AND substr(`seal_id`,1,5)='cose_'
    AND substr(`seal_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`evidence_content_sha256`)=64
    AND `evidence_content_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`binding_sha256`)=64 AND `binding_sha256` NOT GLOB '*[^a-f0-9]*'
    AND substr(`seal_id`,6)=`binding_sha256`),
  CHECK (length(`claim_token_sha256`)=64
    AND `claim_token_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`ciphertext_sha256` IS NULL OR (length(`ciphertext_sha256`)=64
    AND `ciphertext_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK ((`state`='RESERVING' AND `ciphertext` IS NULL AND `key_version` IS NULL
      AND `ciphertext_sha256` IS NULL)
    OR (`state`='SEALED' AND length(`ciphertext`) BETWEEN 32 AND 8192
      AND `ciphertext` GLOB 'fsev1.*' AND length(`key_version`) BETWEEN 1 AND 128
      AND `ciphertext_sha256` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `finops_co_materializer_outbox` (
  `outbox_id` text PRIMARY KEY NOT NULL,
  `org_id` text NOT NULL,
  `customer_id` text NOT NULL,
  `connection_id` text NOT NULL,
  `activation_id` text NOT NULL UNIQUE,
  `plan_checkpoint_id` text NOT NULL,
  `plan_set_id` text NOT NULL,
  `discovery_lineage_sha256` text NOT NULL,
  `payload_json` text NOT NULL,
  `payload_sha256` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('PENDING','LEASED','RECOVERABLE','DISPATCHED')),
  `delivery_attempt` integer NOT NULL CHECK (`delivery_attempt` BETWEEN 0 AND 25),
  `lease_token_sha256` text,
  `lease_expires_at` integer,
  `dispatched_at` integer,
  `created_at` integer NOT NULL CHECK (`created_at` BETWEEN 0 AND 8640000000000000),
  `updated_at` integer NOT NULL CHECK (`updated_at` BETWEEN 0 AND 8640000000000000),
  FOREIGN KEY (`activation_id`) REFERENCES `finops_co_activation_runs`(`activation_id`) ON DELETE RESTRICT,
  FOREIGN KEY (`plan_set_id`) REFERENCES `finops_co_export_plan_sets`(`plan_set_id`) ON DELETE RESTRICT,
  UNIQUE (`org_id`,`customer_id`,`connection_id`,`outbox_id`),
  CHECK (length(`outbox_id`)=69 AND substr(`outbox_id`,1,5)='coob_'
    AND substr(`outbox_id`,6) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`plan_checkpoint_id`)=70 AND substr(`plan_checkpoint_id`,1,6)='comrp_'
    AND substr(`plan_checkpoint_id`,7) NOT GLOB '*[^a-f0-9]*'),
  CHECK (length(`discovery_lineage_sha256`)=64
    AND `discovery_lineage_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (json_valid(`payload_json`) AND json_type(`payload_json`)='object'
    AND length(`payload_json`) BETWEEN 2 AND 245760),
  CHECK (length(`payload_sha256`)=64 AND `payload_sha256` NOT GLOB '*[^a-f0-9]*'),
  CHECK (`lease_token_sha256` IS NULL OR (length(`lease_token_sha256`)=64
    AND `lease_token_sha256` NOT GLOB '*[^a-f0-9]*')),
  CHECK (`lease_expires_at` IS NULL OR `lease_expires_at` BETWEEN 0 AND 8640000000000000),
  CHECK (`dispatched_at` IS NULL OR `dispatched_at` BETWEEN 0 AND 8640000000000000),
  CHECK ((`state` IN ('PENDING','RECOVERABLE') AND `lease_token_sha256` IS NULL
      AND `lease_expires_at` IS NULL AND `dispatched_at` IS NULL)
    OR (`state`='LEASED' AND `lease_token_sha256` IS NOT NULL
      AND `lease_expires_at` IS NOT NULL AND `dispatched_at` IS NULL)
    OR (`state`='DISPATCHED' AND `lease_token_sha256` IS NOT NULL
      AND `lease_expires_at` IS NOT NULL AND `dispatched_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `finops_co_capabilities_history_idx` ON `finops_co_materialization_capabilities`
  (`org_id`,`customer_id`,`connection_id`,`verified_at` DESC,`capability_id` DESC);
--> statement-breakpoint
CREATE INDEX `finops_co_activation_runs_history_idx` ON `finops_co_activation_runs`
  (`org_id`,`customer_id`,`connection_id`,`scheduled_window` DESC);
--> statement-breakpoint
CREATE INDEX `finops_co_launch_checkpoints_activation_idx`
  ON `finops_co_activation_launch_checkpoints` (`activation_id`,`region`);
--> statement-breakpoint
CREATE INDEX `finops_co_discovery_evidence_seals_recovery_idx`
  ON `finops_co_discovery_evidence_seals` (`state`,`lease_expires_at`,`seal_id`);
--> statement-breakpoint
CREATE INDEX `finops_co_materializer_outbox_dispatch_idx` ON `finops_co_materializer_outbox`
  (`state`,`created_at`,`outbox_id`);
--> statement-breakpoint
CREATE TRIGGER `finops_co_capability_scope_guard` BEFORE INSERT ON `finops_co_materialization_capabilities`
WHEN NOT EXISTS (
  SELECT 1 FROM `aws_connections` c
  JOIN `organizations` o ON o.`id`=c.`org_id` AND o.`status`='active'
  JOIN `customers` cu ON cu.`id`=c.`customer_id` AND cu.`org_id`=c.`org_id` AND cu.`status`='active'
  WHERE c.`org_id`=NEW.`org_id` AND c.`customer_id`=NEW.`customer_id`
    AND c.`id`=NEW.`connection_id` AND c.`aws_account_id`=NEW.`account_id`
    AND c.`partition`=NEW.`partition` AND c.`source_kind`='aws_trust_role' AND c.`status`='active'
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_CAPABILITY_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_capability_immutable` BEFORE UPDATE ON `finops_co_materialization_capabilities`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_CAPABILITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_capability_delete_guard` BEFORE DELETE ON `finops_co_materialization_capabilities`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_CAPABILITY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_capability_head_insert_guard` BEFORE INSERT ON `finops_co_materialization_capability_heads`
WHEN NOT EXISTS (SELECT 1 FROM `finops_co_materialization_capabilities` c
  WHERE c.`capability_id`=NEW.`active_capability_id` AND c.`org_id`=NEW.`org_id`
    AND c.`customer_id`=NEW.`customer_id` AND c.`connection_id`=NEW.`connection_id`)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_CAPABILITY_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_capability_head_update_guard` BEFORE UPDATE ON `finops_co_materialization_capability_heads`
WHEN NEW.`org_id`<>OLD.`org_id` OR NEW.`customer_id`<>OLD.`customer_id`
  OR NEW.`connection_id`<>OLD.`connection_id` OR NEW.`updated_at`<OLD.`updated_at`
  OR NOT EXISTS (SELECT 1 FROM `finops_co_materialization_capabilities` c
    WHERE c.`capability_id`=NEW.`active_capability_id` AND c.`org_id`=OLD.`org_id`
      AND c.`customer_id`=OLD.`customer_id` AND c.`connection_id`=OLD.`connection_id`)
  OR NOT EXISTS (
    SELECT 1 FROM `finops_co_materialization_capabilities` current
    JOIN `finops_co_materialization_capabilities` candidate
      ON candidate.`capability_id`=NEW.`active_capability_id`
    WHERE current.`capability_id`=OLD.`active_capability_id`
      AND (candidate.`verified_at`>current.`verified_at`
        OR (candidate.`verified_at`=current.`verified_at`
          AND candidate.`created_at`>current.`created_at`)
        OR candidate.`capability_id`=current.`capability_id`)
  )
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_CAPABILITY_HEAD_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_capability_head_delete_guard` BEFORE DELETE ON `finops_co_materialization_capability_heads`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_CAPABILITY_HEAD_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_activation_insert_guard` BEFORE INSERT ON `finops_co_activation_runs`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_materialization_capability_heads` h
  JOIN `finops_co_materialization_capabilities` c ON c.`capability_id`=h.`active_capability_id`
  WHERE h.`org_id`=NEW.`org_id` AND h.`customer_id`=NEW.`customer_id`
    AND h.`connection_id`=NEW.`connection_id` AND c.`capability_id`=NEW.`capability_id`
    AND c.`state`='ENABLED' AND c.`account_id`=NEW.`account_id` AND c.`partition`=NEW.`partition`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_ACTIVATION_CAPABILITY_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_activation_update_guard` BEFORE UPDATE ON `finops_co_activation_runs`
WHEN NEW.`activation_id`<>OLD.`activation_id` OR NEW.`org_id`<>OLD.`org_id`
  OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id`
  OR NEW.`capability_id`<>OLD.`capability_id` OR NEW.`account_id`<>OLD.`account_id`
  OR NEW.`partition`<>OLD.`partition` OR NEW.`scheduled_window`<>OLD.`scheduled_window`
  OR NEW.`sealed_at`<>OLD.`sealed_at` OR NEW.`activation_content_sha256`<>OLD.`activation_content_sha256`
  OR NEW.`created_at`<>OLD.`created_at` OR NEW.`revision`<>OLD.`revision`+1
  OR NEW.`updated_at`<OLD.`updated_at` OR NEW.`attempt`<OLD.`attempt` OR NEW.`attempt`>OLD.`attempt`+1
  OR (NEW.`state`=OLD.`state` AND NEW.`attempt`<>OLD.`attempt`+1)
  OR NOT (
    (OLD.`state`='SEALED' AND NEW.`state`='FAILED')
    OR (OLD.`state`='SEALED' AND NEW.`state`='DISCOVERY_PENDING'
      AND (SELECT count(*) FROM `finops_co_activation_launch_checkpoints` k
        WHERE k.`activation_id`=OLD.`activation_id` AND k.`attempt`=OLD.`attempt`)
        = (SELECT c.`region_count` FROM `finops_co_materialization_capabilities` c
          WHERE c.`capability_id`=OLD.`capability_id`))
    OR (OLD.`state`='RECONCILING' AND NEW.`state` IN ('RECONCILING','DISCOVERY_PENDING','MATERIALIZATION_PENDING','FAILED'))
    OR (OLD.`state`='DISCOVERY_PENDING' AND NEW.`state` IN ('DISCOVERY_PENDING','RECONCILING','FAILED'))
    OR (OLD.`state`='MATERIALIZATION_PENDING' AND NEW.`state` IN ('MATERIALIZATION_PENDING','COMPLETE','FAILED'))
  )
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_ACTIVATION_TRANSITION_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_activation_delete_guard` BEFORE DELETE ON `finops_co_activation_runs`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_ACTIVATION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_launch_checkpoint_insert_guard`
BEFORE INSERT ON `finops_co_activation_launch_checkpoints`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_activation_runs` a
  JOIN `finops_co_materialization_capabilities` c ON c.`capability_id`=a.`capability_id`
  WHERE a.`activation_id`=NEW.`activation_id` AND a.`org_id`=NEW.`org_id`
    AND a.`customer_id`=NEW.`customer_id` AND a.`connection_id`=NEW.`connection_id`
    AND a.`state`='SEALED' AND a.`attempt`=NEW.`attempt`
    AND EXISTS (SELECT 1 FROM json_each(c.`regions_json`) r WHERE r.`value`=NEW.`region`)
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_LAUNCH_CHECKPOINT_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_launch_checkpoint_update_guard`
BEFORE UPDATE ON `finops_co_activation_launch_checkpoints`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_LAUNCH_CHECKPOINT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_launch_checkpoint_delete_guard`
BEFORE DELETE ON `finops_co_activation_launch_checkpoints`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_LAUNCH_CHECKPOINT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_discovery_evidence_seal_insert_guard`
BEFORE INSERT ON `finops_co_discovery_evidence_seals`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_discovery_runs` r
  JOIN `evidence_objects` e ON e.`id`=NEW.`object_id`
  WHERE r.`run_id`=NEW.`run_id` AND r.`org_id`=NEW.`org_id`
    AND r.`customer_id`=NEW.`customer_id` AND r.`connection_id`=NEW.`connection_id`
    AND r.`status`='running' AND e.`org_id`=NEW.`org_id`
    AND e.`customer_id`=NEW.`customer_id` AND e.`connection_id`=NEW.`connection_id`
    AND e.`run_id`=NEW.`run_id` AND e.`content_sha256`=NEW.`evidence_content_sha256`
    AND e.`status`='available'
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_DISCOVERY_SEAL_SCOPE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_discovery_evidence_seal_update_guard`
BEFORE UPDATE ON `finops_co_discovery_evidence_seals`
WHEN NEW.`seal_id`<>OLD.`seal_id` OR NEW.`org_id`<>OLD.`org_id`
  OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id`
  OR NEW.`run_id`<>OLD.`run_id` OR NEW.`evidence_content_sha256`<>OLD.`evidence_content_sha256`
  OR NEW.`object_id`<>OLD.`object_id` OR NEW.`binding_sha256`<>OLD.`binding_sha256`
  OR NEW.`created_at`<>OLD.`created_at` OR NEW.`updated_at`<OLD.`updated_at`
  OR NOT (
    (OLD.`state`='RESERVING' AND NEW.`state`='RESERVING'
      AND NEW.`updated_at`>=OLD.`lease_expires_at`
      AND NEW.`claim_token_sha256`<>OLD.`claim_token_sha256`
      AND NEW.`lease_expires_at`>OLD.`lease_expires_at`)
    OR (OLD.`state`='RESERVING' AND NEW.`state`='SEALED'
      AND NEW.`claim_token_sha256`=OLD.`claim_token_sha256`
      AND NEW.`lease_expires_at`=OLD.`lease_expires_at`
      AND NEW.`updated_at`<=OLD.`lease_expires_at`)
  )
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_DISCOVERY_SEAL_TRANSITION_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_discovery_evidence_seal_delete_guard`
BEFORE DELETE ON `finops_co_discovery_evidence_seals`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_DISCOVERY_SEAL_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_outbox_insert_guard` BEFORE INSERT ON `finops_co_materializer_outbox`
WHEN NOT EXISTS (
  SELECT 1 FROM `finops_co_activation_runs` a
  JOIN `finops_co_export_plan_sets` p ON p.`plan_set_id`=a.`plan_set_id` AND p.`finalized`=1
  WHERE a.`activation_id`=NEW.`activation_id` AND a.`org_id`=NEW.`org_id`
    AND a.`customer_id`=NEW.`customer_id` AND a.`connection_id`=NEW.`connection_id`
    AND a.`state`='MATERIALIZATION_PENDING' AND a.`plan_checkpoint_id`=NEW.`plan_checkpoint_id`
    AND a.`plan_set_id`=NEW.`plan_set_id`
    AND a.`discovery_lineage_sha256`=NEW.`discovery_lineage_sha256`
    AND p.`org_id`=NEW.`org_id` AND p.`customer_id`=NEW.`customer_id`
    AND p.`connection_id`=NEW.`connection_id`
)
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_OUTBOX_LINEAGE_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_outbox_update_guard` BEFORE UPDATE ON `finops_co_materializer_outbox`
WHEN NEW.`outbox_id`<>OLD.`outbox_id` OR NEW.`org_id`<>OLD.`org_id`
  OR NEW.`customer_id`<>OLD.`customer_id` OR NEW.`connection_id`<>OLD.`connection_id`
  OR NEW.`activation_id`<>OLD.`activation_id` OR NEW.`plan_checkpoint_id`<>OLD.`plan_checkpoint_id`
  OR NEW.`plan_set_id`<>OLD.`plan_set_id`
  OR NEW.`discovery_lineage_sha256`<>OLD.`discovery_lineage_sha256`
  OR NEW.`payload_json`<>OLD.`payload_json` OR NEW.`payload_sha256`<>OLD.`payload_sha256`
  OR NEW.`created_at`<>OLD.`created_at` OR NEW.`updated_at`<OLD.`updated_at`
  OR NOT (
    (OLD.`state`='PENDING' AND NEW.`state`='LEASED'
      AND NEW.`delivery_attempt`=OLD.`delivery_attempt`+1)
    OR (OLD.`state`='LEASED' AND NEW.`state`='DISPATCHED'
      AND NEW.`delivery_attempt`=OLD.`delivery_attempt`)
    OR (OLD.`state`='LEASED' AND NEW.`state`='RECOVERABLE'
      AND NEW.`delivery_attempt`=OLD.`delivery_attempt` AND NEW.`updated_at`>=OLD.`lease_expires_at`)
    OR (OLD.`state`='RECOVERABLE' AND NEW.`state`='PENDING'
      AND NEW.`delivery_attempt`=OLD.`delivery_attempt`)
  )
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_OUTBOX_TRANSITION_REJECTED'); END;
--> statement-breakpoint
CREATE TRIGGER `finops_co_outbox_delete_guard` BEFORE DELETE ON `finops_co_materializer_outbox`
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_OUTBOX_IMMUTABLE'); END;
