CREATE TABLE IF NOT EXISTS compliance_exceptions (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  control_key text NOT NULL,
  finding_fingerprint text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id),
  requested_by text NOT NULL REFERENCES users(id),
  reviewed_by text REFERENCES users(id),
  rationale text NOT NULL,
  compensating_control text NOT NULL,
  review_note text,
  expires_at bigint NOT NULL,
  requested_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  reviewed_at bigint,
  revoked_at bigint,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS compliance_exceptions_active_finding_uq ON compliance_exceptions (org_id, connection_id, finding_fingerprint) WHERE status IN ('pending', 'approved');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS compliance_exceptions_scope_status_idx ON compliance_exceptions (org_id, customer_id, connection_id, status, expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS compliance_exception_events (
  id text PRIMARY KEY NOT NULL,
  exception_id text NOT NULL REFERENCES compliance_exceptions(id),
  org_id text NOT NULL REFERENCES organizations(id),
  actor_id text NOT NULL REFERENCES users(id),
  action text NOT NULL,
  note text,
  occurred_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS compliance_exception_events_scope_time_idx ON compliance_exception_events (org_id, exception_id, occurred_at, id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_compliance_exception_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'compliance exception activity is immutable'; END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS compliance_exception_events_no_update ON compliance_exception_events;
--> statement-breakpoint
CREATE TRIGGER compliance_exception_events_no_update BEFORE UPDATE ON compliance_exception_events FOR EACH ROW EXECUTE FUNCTION sutra_reject_compliance_exception_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS compliance_exception_events_no_delete ON compliance_exception_events;
--> statement-breakpoint
CREATE TRIGGER compliance_exception_events_no_delete BEFORE DELETE ON compliance_exception_events FOR EACH ROW EXECUTE FUNCTION sutra_reject_compliance_exception_event_mutation();
