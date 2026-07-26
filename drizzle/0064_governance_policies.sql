CREATE TABLE IF NOT EXISTS governance_policies (
	id text PRIMARY KEY NOT NULL,
	org_id text NOT NULL,
	customer_id text,
	connection_id text,
	name text NOT NULL,
	priority integer NOT NULL DEFAULT 100,
	condition_json text NOT NULL,
	action_kind text NOT NULL,
	action_target text,
	action_expires_in_days integer,
	action_note text,
	requires_approval integer NOT NULL DEFAULT 1,
	enabled integer NOT NULL DEFAULT 1,
	created_by text,
	created_at integer NOT NULL,
	updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS governance_policies_org ON governance_policies (org_id, customer_id, priority);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS governance_policies_scope_name ON governance_policies (org_id, customer_id, name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS governance_approvals (
	id text PRIMARY KEY NOT NULL,
	org_id text NOT NULL,
	customer_id text NOT NULL,
	request_id text NOT NULL,
	policy_id text NOT NULL,
	action_kind text NOT NULL,
	request_key text NOT NULL,
	target_ref text,
	decision text NOT NULL,
	reason text NOT NULL,
	actor_user_id text NOT NULL,
	evidence_json text,
	created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS governance_approvals_request ON governance_approvals (org_id, customer_id, request_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS governance_approvals_pending ON governance_approvals (org_id, customer_id, decision, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS governance_approvals_key ON governance_approvals (org_id, customer_id, request_key, created_at);
