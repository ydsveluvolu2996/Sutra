CREATE TABLE IF NOT EXISTS identity_invitations (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  role text NOT NULL,
  scope_mode text DEFAULT 'assigned_customers' NOT NULL,
  token_digest text NOT NULL,
  invited_by text NOT NULL REFERENCES users(id),
  expires_at bigint NOT NULL,
  accepted_at bigint,
  accepted_user_id text,
  revoked_at bigint,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS identity_invitations_token_uq ON identity_invitations (token_digest);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS identity_invitations_active_email_uq ON identity_invitations (org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_invitations_org_expiry_idx ON identity_invitations (org_id, expires_at, revoked_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS identity_invitation_events (
  id text PRIMARY KEY NOT NULL,
  invitation_id text NOT NULL REFERENCES identity_invitations(id),
  org_id text NOT NULL REFERENCES organizations(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  occurred_at bigint NOT NULL,
  metadata_json text DEFAULT '{}' NOT NULL,
  previous_event_hash text,
  event_hash text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS identity_invitation_events_hash_uq ON identity_invitation_events (invitation_id, event_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS identity_invitation_events_org_time_idx ON identity_invitation_events (org_id, occurred_at, id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_identity_invitation_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'identity invitation activity is immutable'; END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS identity_invitation_events_no_update ON identity_invitation_events;
--> statement-breakpoint
CREATE TRIGGER identity_invitation_events_no_update BEFORE UPDATE ON identity_invitation_events FOR EACH ROW EXECUTE FUNCTION sutra_reject_identity_invitation_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS identity_invitation_events_no_delete ON identity_invitation_events;
--> statement-breakpoint
CREATE TRIGGER identity_invitation_events_no_delete BEFORE DELETE ON identity_invitation_events FOR EACH ROW EXECUTE FUNCTION sutra_reject_identity_invitation_event_mutation();
