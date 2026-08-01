-- PostgreSQL parity for immutable, server-owned billing discovery records.
CREATE TABLE finops_data_export_observations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  connection_id text NOT NULL REFERENCES aws_connections(id) ON DELETE CASCADE,
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL,
  producer_key_id text NOT NULL,
  producer_operation_id text NOT NULL,
  producer_nonce text NOT NULL,
  producer_body_sha256 text NOT NULL,
  observed_at bigint NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (org_id, customer_id, connection_id, payload_sha256),
  CHECK (id ~ '^fdo_[0-9a-f]{32}$'),
  CHECK (char_length(payload_json) BETWEEN 2 AND 24576),
  CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (char_length(producer_key_id) BETWEEN 1 AND 64),
  CHECK (char_length(producer_operation_id) BETWEEN 1 AND 128),
  CHECK (char_length(producer_nonce) BETWEEN 22 AND 128),
  CHECK (producer_body_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (observed_at BETWEEN 0 AND 9007199254740991),
  CHECK (created_at BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX finops_data_export_observations_scope_idx
  ON finops_data_export_observations
  (org_id, customer_id, connection_id, observed_at DESC, id DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_finops_data_export_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FINOPS_DATA_EXPORT_OBSERVATION_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finops_data_export_observations_no_update
BEFORE UPDATE ON finops_data_export_observations
FOR EACH ROW EXECUTE FUNCTION reject_finops_data_export_observation_mutation();
--> statement-breakpoint
CREATE TRIGGER finops_data_export_observations_no_delete
BEFORE DELETE ON finops_data_export_observations
FOR EACH ROW EXECUTE FUNCTION reject_finops_data_export_observation_mutation();
--> statement-breakpoint
REVOKE ALL ON finops_data_export_observations FROM PUBLIC;
