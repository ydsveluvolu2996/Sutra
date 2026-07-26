-- MSP margin: per-customer markup and optional fixed monthly fee applied to
-- cloud cost to compute the billed-to-customer amount and margin. Additive.
CREATE TABLE IF NOT EXISTS customer_margin (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  markup_percent real NOT NULL DEFAULT 0,
  monthly_fee_micros bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_margin_scope ON customer_margin (org_id, customer_id);
