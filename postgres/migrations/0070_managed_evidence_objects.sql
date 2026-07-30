CREATE TABLE IF NOT EXISTS evidence_objects (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  run_id text NOT NULL,
  snapshot_id text,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('aws_snapshot_raw', 'export_json', 'export_csv')),
  object_key text NOT NULL,
  content_type text NOT NULL,
  content_sha256 text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 12582912),
  status text DEFAULT 'staging' NOT NULL CHECK (status IN ('staging', 'available', 'failed')),
  retention_until bigint NOT NULL,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  available_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS evidence_objects_key_uq ON evidence_objects (object_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS evidence_objects_run_kind_uq
  ON evidence_objects (org_id, connection_id, run_id, artifact_kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_objects_scope_time_idx
  ON evidence_objects (org_id, customer_id, connection_id, created_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_download_grants (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  object_id text NOT NULL REFERENCES evidence_objects(id),
  actor_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('raw_evidence_review', 'export_download')),
  token_sha256 text NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint,
  created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS evidence_download_grants_token_uq
  ON evidence_download_grants (token_sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_download_grants_scope_expiry_idx
  ON evidence_download_grants (org_id, customer_id, actor_id, expires_at);
--> statement-breakpoint
-- Used only by explicit local/development mode. Managed production stores no
-- payload bytes in PostgreSQL; it uses the private SSE-KMS S3 bucket.
CREATE TABLE IF NOT EXISTS evidence_local_payloads (
  object_id text PRIMARY KEY NOT NULL REFERENCES evidence_objects(id),
  content_sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  body_base64 text NOT NULL,
  created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_immutable_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable evidence mutation rejected';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER evidence_objects_immutable_identity
BEFORE UPDATE OF org_id, customer_id, connection_id, run_id, snapshot_id,
  artifact_kind, object_key, content_type, content_sha256, byte_size,
  retention_until, created_by, created_at
ON evidence_objects
FOR EACH ROW EXECUTE FUNCTION sutra_reject_immutable_evidence();
--> statement-breakpoint
CREATE TRIGGER evidence_objects_no_delete
BEFORE DELETE ON evidence_objects
FOR EACH ROW EXECUTE FUNCTION sutra_reject_immutable_evidence();
--> statement-breakpoint
CREATE TRIGGER evidence_download_grants_immutable_binding
BEFORE UPDATE OF org_id, customer_id, object_id, actor_id, purpose,
  token_sha256, expires_at, created_at
ON evidence_download_grants
FOR EACH ROW EXECUTE FUNCTION sutra_reject_immutable_evidence();
--> statement-breakpoint
CREATE TRIGGER evidence_download_grants_no_delete
BEFORE DELETE ON evidence_download_grants
FOR EACH ROW EXECUTE FUNCTION sutra_reject_immutable_evidence();
--> statement-breakpoint
CREATE TRIGGER evidence_local_payloads_no_update
BEFORE UPDATE ON evidence_local_payloads
FOR EACH ROW EXECUTE FUNCTION sutra_reject_immutable_evidence();
--> statement-breakpoint
CREATE TRIGGER evidence_local_payloads_no_delete
BEFORE DELETE ON evidence_local_payloads
FOR EACH ROW EXECUTE FUNCTION sutra_reject_immutable_evidence();
