CREATE TABLE IF NOT EXISTS customer_margin (
	id text PRIMARY KEY NOT NULL,
	org_id text NOT NULL,
	customer_id text NOT NULL,
	markup_percent real NOT NULL DEFAULT 0,
	monthly_fee_micros integer NOT NULL DEFAULT 0,
	currency text NOT NULL DEFAULT 'USD',
	updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customer_margin_scope ON customer_margin (org_id, customer_id);
