-- External cost sources ("Cost360"): operator-supplied non-AWS spend — licence
-- invoices, support contracts, third-party SaaS, an MSP's own managed-service
-- fee — so allocation, showback and MSP margin can describe TOTAL customer
-- spend instead of only the CUR. Additive: a new table plus its read indexes.
--
-- A row is an operator-ASSERTED cost, never a reconciled invoice. An upload
-- REPLACES a (source, period) pair for the connection, so a re-upload corrects
-- rather than double-counts; the (org, customer, connection, source, period)
-- index below is the delete/read path for that replace.
CREATE TABLE IF NOT EXISTS finops_external_costs (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  source text NOT NULL,
  period text NOT NULL,
  amount_micros bigint NOT NULL,
  currency text NOT NULL,
  attributed_customer text,
  category text,
  vendor text,
  tags_json text NOT NULL DEFAULT '{}',
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS finops_external_costs_scope ON finops_external_costs (org_id, customer_id, connection_id, period);
CREATE INDEX IF NOT EXISTS finops_external_costs_source ON finops_external_costs (org_id, customer_id, connection_id, source, period);
