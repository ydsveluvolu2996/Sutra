CREATE TABLE IF NOT EXISTS finops_resource_schedules (
	id text PRIMARY KEY NOT NULL,
	org_id text NOT NULL,
	customer_id text,
	connection_id text,
	name text NOT NULL,
	schedule_json text NOT NULL,
	selector_json text NOT NULL,
	enabled integer NOT NULL DEFAULT 1,
	created_at integer NOT NULL,
	updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finops_resource_schedules_org ON finops_resource_schedules (org_id, customer_id, name);
