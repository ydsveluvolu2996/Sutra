CREATE TABLE IF NOT EXISTS finding_cases (
  id text PRIMARY KEY NOT NULL,
  case_number text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  finding_fingerprint text NOT NULL,
  finding_snapshot_id text NOT NULL REFERENCES cmdb_snapshots(id),
  finding_severity text NOT NULL,
  title text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  priority text NOT NULL,
  assignee_membership_id text REFERENCES memberships(id),
  due_at bigint NOT NULL,
  resolved_at bigint,
  closed_at bigint,
  created_by_user_id text NOT NULL REFERENCES users(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finding_cases_org_number_uq ON finding_cases (org_id, case_number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finding_cases_active_fingerprint_uq ON finding_cases (org_id, connection_id, finding_fingerprint) WHERE status != 'closed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finding_cases_scope_status_idx ON finding_cases (org_id, customer_id, connection_id, status, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finding_case_activities (
  id text PRIMARY KEY NOT NULL,
  case_id text NOT NULL REFERENCES finding_cases(id),
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  connection_id text NOT NULL REFERENCES aws_connections(id),
  kind text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id),
  occurred_at bigint NOT NULL,
  detail_json text NOT NULL,
  previous_event_hash text,
  event_hash text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finding_case_activity_hash_uq ON finding_case_activities (case_id, event_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finding_case_activity_chain_uq ON finding_case_activities (case_id, previous_event_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finding_case_activity_timeline_idx ON finding_case_activities (org_id, customer_id, case_id, occurred_at, id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_case_activity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'case activity is immutable'; END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS finding_case_activities_no_update ON finding_case_activities;
--> statement-breakpoint
CREATE TRIGGER finding_case_activities_no_update BEFORE UPDATE ON finding_case_activities FOR EACH ROW EXECUTE FUNCTION sutra_reject_case_activity_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS finding_case_activities_no_delete ON finding_case_activities;
--> statement-breakpoint
CREATE TRIGGER finding_case_activities_no_delete BEFORE DELETE ON finding_case_activities FOR EACH ROW EXECUTE FUNCTION sutra_reject_case_activity_mutation();
