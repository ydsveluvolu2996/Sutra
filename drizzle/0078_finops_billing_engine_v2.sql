CREATE TABLE IF NOT EXISTS finops_export_partitions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  export_name TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_format TEXT NOT NULL,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed')),
  manifest_bucket TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL,
  manifest_etag TEXT,
  manifest_version_id TEXT,
  source_updated_at TEXT,
  observed_at TEXT NOT NULL,
  active_generation_id TEXT,
  active_manifest_sha256 TEXT,
  active_manifest_version_id TEXT,
  active_source_table TEXT,
  active_source_format TEXT,
  active_source_version TEXT,
  active_source_updated_at TEXT,
  active_observed_at TEXT,
  active_accepted_rows INTEGER,
  active_rejected_rows INTEGER,
  active_currency_totals_json TEXT,
  active_committed_at TEXT,
  staging_generation_id TEXT,
  staging_manifest_sha256 TEXT,
  accepted_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL,
  columns_json TEXT NOT NULL,
  data_files_json TEXT NOT NULL,
  currency_totals_json TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  committed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finops_export_partitions_scope_uq
  ON finops_export_partitions (org_id, customer_id, connection_id, export_name, billing_period);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finops_export_partitions_health_idx
  ON finops_export_partitions (org_id, customer_id, connection_id, status, observed_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finops_billing_lines_v2 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  export_name TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  source_format TEXT NOT NULL,
  source_version TEXT NOT NULL,
  line_item_id TEXT NOT NULL,
  payer_account_id TEXT,
  usage_account_id TEXT NOT NULL,
  service TEXT NOT NULL,
  product_code TEXT,
  product_name TEXT,
  product_family TEXT,
  resource_id TEXT,
  resource_type TEXT,
  region TEXT,
  availability_zone TEXT,
  operation TEXT,
  usage_type TEXT,
  charge_kind TEXT NOT NULL,
  charge_category TEXT NOT NULL,
  usage_start TEXT NOT NULL,
  usage_end TEXT,
  amount_micros TEXT NOT NULL,
  net_unblended_cost_micros TEXT,
  amortized_micros TEXT,
  list_cost_micros TEXT,
  contracted_cost_micros TEXT,
  public_on_demand_cost_micros TEXT,
  currency TEXT NOT NULL,
  commitment_type TEXT,
  commitment_id TEXT,
  commitment_expiry TEXT,
  invoice_id TEXT,
  billing_entity TEXT,
  legal_entity TEXT,
  tags_json TEXT NOT NULL DEFAULT '{}',
  cost_categories_json TEXT NOT NULL DEFAULT '{}',
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finops_billing_lines_v2_generation_line_uq
  ON finops_billing_lines_v2 (org_id, customer_id, connection_id, export_name, billing_period, generation_id, line_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finops_billing_lines_v2_query_idx
  ON finops_billing_lines_v2 (org_id, customer_id, connection_id, billing_period, generation_id, service, usage_account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS finops_billing_lines_v2_resource_idx
  ON finops_billing_lines_v2 (org_id, customer_id, connection_id, resource_id, billing_period);
