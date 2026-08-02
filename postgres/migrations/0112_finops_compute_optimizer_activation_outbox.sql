-- PostgreSQL parity for the separate .8.5 Compute Optimizer capability,
-- daily activation state and deterministic materializer outbox.
CREATE TABLE finops_co_materialization_capabilities (
  capability_id text PRIMARY KEY CHECK (capability_id ~ '^cocp_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  permission_pack_version text NOT NULL CHECK (permission_pack_version='standard-2026-08.5'),
  regions_json text NOT NULL CHECK (jsonb_typeof(regions_json::jsonb)='array'
    AND char_length(regions_json) BETWEEN 12 AND 1751),
  region_count integer NOT NULL CHECK (region_count BETWEEN 1 AND 50),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  verified_at bigint NOT NULL CHECK (verified_at BETWEEN 0 AND 8640000000000000),
  state text NOT NULL CHECK (state IN ('ENABLED','DISABLED')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (org_id,customer_id,connection_id,capability_id),
  CHECK (jsonb_array_length(regions_json::jsonb)=region_count),
  CHECK (capability_id='cocp_' || content_sha256)
);
--> statement-breakpoint
CREATE TABLE finops_co_materialization_capability_heads (
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  active_capability_id text NOT NULL UNIQUE REFERENCES finops_co_materialization_capabilities(capability_id) ON DELETE RESTRICT,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 8640000000000000),
  PRIMARY KEY (org_id,customer_id,connection_id)
);
--> statement-breakpoint
CREATE TABLE finops_co_activation_runs (
  activation_id text PRIMARY KEY CHECK (activation_id ~ '^comra_[a-f0-9]{64}$'),
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE RESTRICT,
  capability_id text NOT NULL REFERENCES finops_co_materialization_capabilities(capability_id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
  partition text NOT NULL CHECK (partition IN ('aws','aws-us-gov','aws-cn')),
  scheduled_window text NOT NULL CHECK (scheduled_window ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00[.]000Z$'),
  sealed_at bigint NOT NULL CHECK (sealed_at BETWEEN 0 AND 8640000000000000),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 25),
  state text NOT NULL CHECK (state IN (
    'SEALED','RECONCILING','DISCOVERY_PENDING','MATERIALIZATION_PENDING','COMPLETE','FAILED'
  )),
  activation_content_sha256 text NOT NULL CHECK (activation_content_sha256 ~ '^[a-f0-9]{64}$'),
  plan_checkpoint_id text CHECK (plan_checkpoint_id IS NULL OR plan_checkpoint_id ~ '^comrp_[a-f0-9]{64}$'),
  plan_checkpoint_sha256 text CHECK (plan_checkpoint_sha256 IS NULL OR plan_checkpoint_sha256 ~ '^[a-f0-9]{64}$'),
  plan_set_id text REFERENCES finops_co_export_plan_sets(plan_set_id) ON DELETE RESTRICT,
  discovery_lineage_sha256 text CHECK (discovery_lineage_sha256 IS NULL OR discovery_lineage_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code_sha256 text CHECK (failure_code_sha256 IS NULL OR failure_code_sha256 ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision BETWEEN 0 AND 1000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (org_id,customer_id,connection_id,scheduled_window),
  UNIQUE (org_id,customer_id,connection_id,activation_id),
  CHECK (activation_id='comra_' || activation_content_sha256),
  CHECK (plan_checkpoint_sha256 IS NULL OR plan_checkpoint_id='comrp_' || plan_checkpoint_sha256),
  CHECK ((state IN ('MATERIALIZATION_PENDING','COMPLETE')
      AND plan_checkpoint_id IS NOT NULL AND plan_checkpoint_sha256 IS NOT NULL
      AND plan_set_id IS NOT NULL AND discovery_lineage_sha256 IS NOT NULL)
    OR (state NOT IN ('MATERIALIZATION_PENDING','COMPLETE')
      AND plan_checkpoint_id IS NULL AND plan_checkpoint_sha256 IS NULL
      AND plan_set_id IS NULL AND discovery_lineage_sha256 IS NULL)),
  CHECK ((state='FAILED' AND failure_code_sha256 IS NOT NULL)
    OR (state<>'FAILED' AND failure_code_sha256 IS NULL))
);
--> statement-breakpoint
CREATE TABLE finops_co_activation_launch_checkpoints (
  checkpoint_id text PRIMARY KEY CHECK (checkpoint_id ~ '^coalc_[a-f0-9]{64}$'),
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  activation_id text NOT NULL REFERENCES finops_co_activation_runs(activation_id) ON DELETE RESTRICT,
  region text NOT NULL CHECK (region ~ '^[a-z]{2}(-gov)?-[a-z]+-[0-9]$'),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 25),
  launch_attempt_id text NOT NULL CHECK (launch_attempt_id ~ '^coela_[a-f0-9]{64}$'),
  launch_attempt_sha256 text NOT NULL CHECK (launch_attempt_sha256 ~ '^[a-f0-9]{64}$'),
  execution_id text NOT NULL CHECK (execution_id ~ '^coele_[a-f0-9]{64}$'),
  execution_sha256 text NOT NULL CHECK (execution_sha256 ~ '^[a-f0-9]{64}$'),
  launch_outcome_proof_sha256 text NOT NULL CHECK (launch_outcome_proof_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (activation_id,region),
  UNIQUE (org_id,customer_id,connection_id,checkpoint_id),
  CHECK (launch_attempt_id='coela_' || launch_attempt_sha256),
  CHECK (execution_id='coele_' || execution_sha256),
  CHECK (checkpoint_id='coalc_' || content_sha256)
);
--> statement-breakpoint
CREATE TABLE finops_co_discovery_evidence_seals (
  seal_id text PRIMARY KEY CHECK (seal_id ~ '^cose_[a-f0-9]{64}$'),
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  run_id text NOT NULL UNIQUE REFERENCES finops_co_discovery_runs(run_id) ON DELETE RESTRICT,
  evidence_content_sha256 text NOT NULL CHECK (evidence_content_sha256 ~ '^[a-f0-9]{64}$'),
  object_id text NOT NULL UNIQUE REFERENCES evidence_objects(id) ON DELETE RESTRICT,
  binding_sha256 text NOT NULL CHECK (binding_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('RESERVING','SEALED')),
  claim_token_sha256 text NOT NULL CHECK (claim_token_sha256 ~ '^[a-f0-9]{64}$'),
  lease_expires_at bigint NOT NULL CHECK (lease_expires_at BETWEEN 0 AND 8640000000000000),
  ciphertext text,
  key_version text,
  ciphertext_sha256 text CHECK (ciphertext_sha256 IS NULL OR ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (org_id,customer_id,connection_id,seal_id),
  CHECK (seal_id='cose_' || binding_sha256),
  CHECK ((state='RESERVING' AND ciphertext IS NULL AND key_version IS NULL
      AND ciphertext_sha256 IS NULL)
    OR (state='SEALED' AND char_length(ciphertext) BETWEEN 32 AND 8192
      AND ciphertext ~ '^fsev1[.][A-Za-z0-9_-]{26,8186}$'
      AND char_length(key_version) BETWEEN 1 AND 128 AND ciphertext_sha256 IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE finops_co_materializer_outbox (
  outbox_id text PRIMARY KEY CHECK (outbox_id ~ '^coob_[a-f0-9]{64}$'),
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  activation_id text NOT NULL UNIQUE REFERENCES finops_co_activation_runs(activation_id) ON DELETE RESTRICT,
  plan_checkpoint_id text NOT NULL CHECK (plan_checkpoint_id ~ '^comrp_[a-f0-9]{64}$'),
  plan_set_id text NOT NULL REFERENCES finops_co_export_plan_sets(plan_set_id) ON DELETE RESTRICT,
  discovery_lineage_sha256 text NOT NULL CHECK (discovery_lineage_sha256 ~ '^[a-f0-9]{64}$'),
  payload_json text NOT NULL CHECK (jsonb_typeof(payload_json::jsonb)='object'
    AND char_length(payload_json) BETWEEN 2 AND 245760),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('PENDING','LEASED','RECOVERABLE','DISPATCHED')),
  delivery_attempt integer NOT NULL CHECK (delivery_attempt BETWEEN 0 AND 25),
  lease_token_sha256 text CHECK (lease_token_sha256 IS NULL OR lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  lease_expires_at bigint CHECK (lease_expires_at IS NULL OR lease_expires_at BETWEEN 0 AND 8640000000000000),
  dispatched_at bigint CHECK (dispatched_at IS NULL OR dispatched_at BETWEEN 0 AND 8640000000000000),
  created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 8640000000000000),
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 8640000000000000),
  UNIQUE (org_id,customer_id,connection_id,outbox_id),
  CHECK ((state IN ('PENDING','RECOVERABLE') AND lease_token_sha256 IS NULL
      AND lease_expires_at IS NULL AND dispatched_at IS NULL)
    OR (state='LEASED' AND lease_token_sha256 IS NOT NULL
      AND lease_expires_at IS NOT NULL AND dispatched_at IS NULL)
    OR (state='DISPATCHED' AND lease_token_sha256 IS NOT NULL
      AND lease_expires_at IS NOT NULL AND dispatched_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX finops_co_capabilities_history_idx ON finops_co_materialization_capabilities
  (org_id,customer_id,connection_id,verified_at DESC,capability_id DESC);
CREATE INDEX finops_co_activation_runs_history_idx ON finops_co_activation_runs
  (org_id,customer_id,connection_id,scheduled_window DESC);
CREATE INDEX finops_co_launch_checkpoints_activation_idx
  ON finops_co_activation_launch_checkpoints (activation_id,region);
CREATE INDEX finops_co_discovery_evidence_seals_recovery_idx
  ON finops_co_discovery_evidence_seals (state,lease_expires_at,seal_id);
CREATE INDEX finops_co_materializer_outbox_dispatch_idx ON finops_co_materializer_outbox
  (state,created_at,outbox_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_capability_scope_guard_fn() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM aws_connections c
    JOIN organizations o ON o.id=c.org_id AND o.status='active'
    JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
    WHERE c.org_id=NEW.org_id AND c.customer_id=NEW.customer_id
      AND c.id=NEW.connection_id AND c.aws_account_id=NEW.account_id
      AND c.partition=NEW.partition AND c.source_kind='aws_trust_role' AND c.status='active'
  ) THEN RAISE EXCEPTION 'FINOPS_CO_CAPABILITY_SCOPE_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_co_capability_scope_guard BEFORE INSERT ON finops_co_materialization_capabilities
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_scope_guard_fn();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_capability_immutable_fn() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'FINOPS_CO_CAPABILITY_IMMUTABLE'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_co_capability_immutable BEFORE UPDATE ON finops_co_materialization_capabilities
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
CREATE TRIGGER finops_co_capability_delete_guard BEFORE DELETE ON finops_co_materialization_capabilities
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_capability_head_guard_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.org_id<>OLD.org_id OR NEW.customer_id<>OLD.customer_id
      OR NEW.connection_id<>OLD.connection_id OR NEW.updated_at<OLD.updated_at) THEN
    RAISE EXCEPTION 'FINOPS_CO_CAPABILITY_HEAD_REJECTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finops_co_materialization_capabilities c
    WHERE c.capability_id=NEW.active_capability_id AND c.org_id=NEW.org_id
      AND c.customer_id=NEW.customer_id AND c.connection_id=NEW.connection_id) THEN
    RAISE EXCEPTION 'FINOPS_CO_CAPABILITY_HEAD_REJECTED';
  END IF;
  IF TG_OP='UPDATE' AND NOT EXISTS (
    SELECT 1 FROM finops_co_materialization_capabilities current
    JOIN finops_co_materialization_capabilities candidate
      ON candidate.capability_id=NEW.active_capability_id
    WHERE current.capability_id=OLD.active_capability_id
      AND (candidate.verified_at>current.verified_at
        OR (candidate.verified_at=current.verified_at
          AND candidate.created_at>current.created_at)
        OR candidate.capability_id=current.capability_id)
  ) THEN RAISE EXCEPTION 'FINOPS_CO_CAPABILITY_HEAD_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_co_capability_head_guard BEFORE INSERT OR UPDATE ON finops_co_materialization_capability_heads
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_head_guard_fn();
CREATE TRIGGER finops_co_capability_head_delete_guard BEFORE DELETE ON finops_co_materialization_capability_heads
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_activation_guard_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finops_co_materialization_capability_heads h
      JOIN finops_co_materialization_capabilities c ON c.capability_id=h.active_capability_id
      WHERE h.org_id=NEW.org_id AND h.customer_id=NEW.customer_id
        AND h.connection_id=NEW.connection_id AND c.capability_id=NEW.capability_id
        AND c.state='ENABLED' AND c.account_id=NEW.account_id AND c.partition=NEW.partition
    ) THEN RAISE EXCEPTION 'FINOPS_CO_ACTIVATION_CAPABILITY_REJECTED'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.activation_id<>OLD.activation_id OR NEW.org_id<>OLD.org_id
    OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id
    OR NEW.capability_id<>OLD.capability_id OR NEW.account_id<>OLD.account_id
    OR NEW.partition<>OLD.partition OR NEW.scheduled_window<>OLD.scheduled_window
    OR NEW.sealed_at<>OLD.sealed_at OR NEW.activation_content_sha256<>OLD.activation_content_sha256
    OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1
    OR NEW.updated_at<OLD.updated_at OR NEW.attempt<OLD.attempt OR NEW.attempt>OLD.attempt+1
    OR (NEW.state=OLD.state AND NEW.attempt<>OLD.attempt+1)
    OR NOT (
      (OLD.state='SEALED' AND NEW.state='FAILED')
      OR (OLD.state='SEALED' AND NEW.state='DISCOVERY_PENDING'
        AND (SELECT count(*) FROM finops_co_activation_launch_checkpoints k
          WHERE k.activation_id=OLD.activation_id AND k.attempt=OLD.attempt)
          = (SELECT c.region_count FROM finops_co_materialization_capabilities c
            WHERE c.capability_id=OLD.capability_id))
      OR (OLD.state='RECONCILING' AND NEW.state IN ('RECONCILING','DISCOVERY_PENDING','MATERIALIZATION_PENDING','FAILED'))
      OR (OLD.state='DISCOVERY_PENDING' AND NEW.state IN ('DISCOVERY_PENDING','RECONCILING','FAILED'))
      OR (OLD.state='MATERIALIZATION_PENDING' AND NEW.state IN ('MATERIALIZATION_PENDING','COMPLETE','FAILED'))
    ) THEN RAISE EXCEPTION 'FINOPS_CO_ACTIVATION_TRANSITION_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_co_activation_insert_guard BEFORE INSERT ON finops_co_activation_runs
  FOR EACH ROW EXECUTE FUNCTION finops_co_activation_guard_fn();
CREATE TRIGGER finops_co_activation_update_guard BEFORE UPDATE ON finops_co_activation_runs
  FOR EACH ROW EXECUTE FUNCTION finops_co_activation_guard_fn();
CREATE TRIGGER finops_co_activation_delete_guard BEFORE DELETE ON finops_co_activation_runs
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_launch_checkpoint_guard_fn() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finops_co_activation_runs a
    JOIN finops_co_materialization_capabilities c ON c.capability_id=a.capability_id
    WHERE a.activation_id=NEW.activation_id AND a.org_id=NEW.org_id
      AND a.customer_id=NEW.customer_id AND a.connection_id=NEW.connection_id
      AND a.state='SEALED' AND a.attempt=NEW.attempt
      AND c.regions_json::jsonb ? NEW.region
  ) THEN RAISE EXCEPTION 'FINOPS_CO_LAUNCH_CHECKPOINT_SCOPE_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_co_launch_checkpoint_insert_guard
  BEFORE INSERT ON finops_co_activation_launch_checkpoints
  FOR EACH ROW EXECUTE FUNCTION finops_co_launch_checkpoint_guard_fn();
CREATE TRIGGER finops_co_launch_checkpoint_update_guard
  BEFORE UPDATE ON finops_co_activation_launch_checkpoints
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
CREATE TRIGGER finops_co_launch_checkpoint_delete_guard
  BEFORE DELETE ON finops_co_activation_launch_checkpoints
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_discovery_evidence_seal_guard_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finops_co_discovery_runs r
      JOIN evidence_objects e ON e.id=NEW.object_id
      WHERE r.run_id=NEW.run_id AND r.org_id=NEW.org_id
        AND r.customer_id=NEW.customer_id AND r.connection_id=NEW.connection_id
        AND r.status='running' AND e.org_id=NEW.org_id
        AND e.customer_id=NEW.customer_id AND e.connection_id=NEW.connection_id
        AND e.run_id=NEW.run_id AND e.content_sha256=NEW.evidence_content_sha256
        AND e.status='available'
    ) THEN RAISE EXCEPTION 'FINOPS_CO_DISCOVERY_SEAL_SCOPE_REJECTED'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.seal_id<>OLD.seal_id OR NEW.org_id<>OLD.org_id
    OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id
    OR NEW.run_id<>OLD.run_id OR NEW.evidence_content_sha256<>OLD.evidence_content_sha256
    OR NEW.object_id<>OLD.object_id OR NEW.binding_sha256<>OLD.binding_sha256
    OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at
    OR NOT (
      (OLD.state='RESERVING' AND NEW.state='RESERVING'
        AND NEW.updated_at>=OLD.lease_expires_at
        AND NEW.claim_token_sha256<>OLD.claim_token_sha256
        AND NEW.lease_expires_at>OLD.lease_expires_at)
      OR (OLD.state='RESERVING' AND NEW.state='SEALED'
        AND NEW.claim_token_sha256=OLD.claim_token_sha256
        AND NEW.lease_expires_at=OLD.lease_expires_at
        AND NEW.updated_at<=OLD.lease_expires_at)
    ) THEN RAISE EXCEPTION 'FINOPS_CO_DISCOVERY_SEAL_TRANSITION_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_co_discovery_evidence_seal_insert_guard
  BEFORE INSERT ON finops_co_discovery_evidence_seals
  FOR EACH ROW EXECUTE FUNCTION finops_co_discovery_evidence_seal_guard_fn();
CREATE TRIGGER finops_co_discovery_evidence_seal_update_guard
  BEFORE UPDATE ON finops_co_discovery_evidence_seals
  FOR EACH ROW EXECUTE FUNCTION finops_co_discovery_evidence_seal_guard_fn();
CREATE TRIGGER finops_co_discovery_evidence_seal_delete_guard
  BEFORE DELETE ON finops_co_discovery_evidence_seals
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION finops_co_outbox_guard_fn() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finops_co_activation_runs a
      JOIN finops_co_export_plan_sets p ON p.plan_set_id=a.plan_set_id AND p.finalized=true
      WHERE a.activation_id=NEW.activation_id AND a.org_id=NEW.org_id
        AND a.customer_id=NEW.customer_id AND a.connection_id=NEW.connection_id
        AND a.state='MATERIALIZATION_PENDING' AND a.plan_checkpoint_id=NEW.plan_checkpoint_id
        AND a.plan_set_id=NEW.plan_set_id AND a.discovery_lineage_sha256=NEW.discovery_lineage_sha256
        AND p.org_id=NEW.org_id AND p.customer_id=NEW.customer_id AND p.connection_id=NEW.connection_id
    ) THEN RAISE EXCEPTION 'FINOPS_CO_OUTBOX_LINEAGE_REJECTED'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.outbox_id<>OLD.outbox_id OR NEW.org_id<>OLD.org_id
    OR NEW.customer_id<>OLD.customer_id OR NEW.connection_id<>OLD.connection_id
    OR NEW.activation_id<>OLD.activation_id OR NEW.plan_checkpoint_id<>OLD.plan_checkpoint_id
    OR NEW.plan_set_id<>OLD.plan_set_id OR NEW.discovery_lineage_sha256<>OLD.discovery_lineage_sha256
    OR NEW.payload_json<>OLD.payload_json OR NEW.payload_sha256<>OLD.payload_sha256
    OR NEW.created_at<>OLD.created_at OR NEW.updated_at<OLD.updated_at
    OR NOT (
      (OLD.state='PENDING' AND NEW.state='LEASED' AND NEW.delivery_attempt=OLD.delivery_attempt+1)
      OR (OLD.state='LEASED' AND NEW.state='DISPATCHED' AND NEW.delivery_attempt=OLD.delivery_attempt)
      OR (OLD.state='LEASED' AND NEW.state='RECOVERABLE'
        AND NEW.delivery_attempt=OLD.delivery_attempt AND NEW.updated_at>=OLD.lease_expires_at)
      OR (OLD.state='RECOVERABLE' AND NEW.state='PENDING'
        AND NEW.delivery_attempt=OLD.delivery_attempt)
    ) THEN RAISE EXCEPTION 'FINOPS_CO_OUTBOX_TRANSITION_REJECTED'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finops_co_outbox_insert_guard BEFORE INSERT ON finops_co_materializer_outbox
  FOR EACH ROW EXECUTE FUNCTION finops_co_outbox_guard_fn();
CREATE TRIGGER finops_co_outbox_update_guard BEFORE UPDATE ON finops_co_materializer_outbox
  FOR EACH ROW EXECUTE FUNCTION finops_co_outbox_guard_fn();
CREATE TRIGGER finops_co_outbox_delete_guard BEFORE DELETE ON finops_co_materializer_outbox
  FOR EACH ROW EXECUTE FUNCTION finops_co_capability_immutable_fn();
--> statement-breakpoint
REVOKE ALL ON finops_co_materialization_capabilities FROM PUBLIC;
REVOKE ALL ON finops_co_materialization_capability_heads FROM PUBLIC;
REVOKE ALL ON finops_co_activation_runs FROM PUBLIC;
REVOKE ALL ON finops_co_activation_launch_checkpoints FROM PUBLIC;
REVOKE ALL ON finops_co_discovery_evidence_seals FROM PUBLIC;
REVOKE ALL ON finops_co_materializer_outbox FROM PUBLIC;
