CREATE TABLE IF NOT EXISTS scim_connectors (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_sha256 text NOT NULL,
  identity_issuer text NOT NULL,
  subject_source text NOT NULL,
  role_mappings_json text DEFAULT '{}' NOT NULL,
  expires_at bigint,
  last_used_at bigint,
  rotated_at bigint,
  revoked_at bigint,
  created_by text NOT NULL REFERENCES users(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS scim_connectors_token_sha256_uq ON scim_connectors (token_sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS scim_connectors_org_created_idx ON scim_connectors (org_id, created_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scim_user_links (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  connector_id text NOT NULL REFERENCES scim_connectors(id),
  user_id text NOT NULL REFERENCES users(id),
  external_id text,
  version integer DEFAULT 1 NOT NULL,
  mutation_nonce text NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS scim_user_links_connector_user_uq ON scim_user_links (connector_id, user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS scim_user_links_connector_external_uq ON scim_user_links (connector_id, external_id) WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS scim_user_links_scope_idx ON scim_user_links (org_id, connector_id, updated_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scim_groups (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  connector_id text NOT NULL REFERENCES scim_connectors(id),
  external_id text,
  display_name text NOT NULL,
  mapped_role text,
  version integer DEFAULT 1 NOT NULL,
  mutation_nonce text NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  updated_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  deleted_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS scim_groups_connector_external_uq ON scim_groups (connector_id, external_id) WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS scim_groups_scope_name_idx ON scim_groups (org_id, connector_id, display_name, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scim_group_members (
  org_id text NOT NULL REFERENCES organizations(id),
  connector_id text NOT NULL REFERENCES scim_connectors(id),
  group_id text NOT NULL REFERENCES scim_groups(id),
  scim_user_id text NOT NULL REFERENCES scim_user_links(id),
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL,
  PRIMARY KEY (group_id, scim_user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS scim_group_members_user_idx ON scim_group_members (org_id, connector_id, scim_user_id, group_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scim_audit_events (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  connector_id text REFERENCES scim_connectors(id),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  outcome text NOT NULL,
  request_id text NOT NULL,
  metadata_json text DEFAULT '{}' NOT NULL,
  occurred_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS scim_audit_events_org_request_uq ON scim_audit_events (org_id, request_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS scim_audit_events_scope_time_idx ON scim_audit_events (org_id, occurred_at, id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_scim_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SCIM audit events are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS scim_audit_events_no_mutation ON scim_audit_events;
--> statement-breakpoint
CREATE TRIGGER scim_audit_events_no_mutation BEFORE UPDATE OR DELETE ON scim_audit_events
FOR EACH ROW EXECUTE FUNCTION sutra_reject_scim_audit_mutation();
