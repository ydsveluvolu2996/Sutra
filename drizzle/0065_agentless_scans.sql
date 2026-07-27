-- Agentless snapshot scanning: run ledger, findings, and teardown debt.
--
-- This is the one Sutra feature whose customer-role permissions are NOT
-- read-only: creating a point-in-time snapshot of a volume is a mutating EC2
-- call. The permission is tag-scoped and opt-in per volume, and every resource
-- the run creates is torn down unconditionally — but the honest statement is
-- that Sutra mutates here, and the customer-facing copy says so.
--
-- Because a failed teardown costs the customer money every hour it survives,
-- teardown failures are PERSISTED as debt (third table) rather than only
-- reported in a response body. A sweeper reconciles them; unreconciled debt is
-- surfaced in the UI as an explicit liability, never silently dropped.
-- Additive.
CREATE TABLE IF NOT EXISTS agentless_scan_runs (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  -- planned: a reviewed plan exists, nothing created. running: snapshots exist.
  -- completed/failed: terminal. A run NEVER goes back to an earlier state.
  status text NOT NULL,
  scan_account_id text NOT NULL,
  scanners_json text NOT NULL,
  kms_reencrypt integer NOT NULL DEFAULT 0,
  snapshot_ttl_hours integer NOT NULL,
  volumes_in_scope integer NOT NULL DEFAULT 0,
  volumes_skipped integer NOT NULL DEFAULT 0,
  volumes_scanned integer NOT NULL DEFAULT 0,
  volumes_failed integer NOT NULL DEFAULT 0,
  findings_count integer NOT NULL DEFAULT 0,
  resources_tore_down integer NOT NULL DEFAULT 0,
  teardown_failures integer NOT NULL DEFAULT 0,
  -- The reviewed plan, stored verbatim so the run is auditable against what was
  -- approved. Skip reasons live here too, so an out-of-scope volume is provable.
  plan_json text NOT NULL,
  error text,
  requested_by text,
  started_at bigint,
  finished_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS agentless_scan_runs_scope ON agentless_scan_runs (org_id, customer_id, created_at);
CREATE INDEX IF NOT EXISTS agentless_scan_runs_conn ON agentless_scan_runs (org_id, customer_id, connection_id, created_at);
CREATE INDEX IF NOT EXISTS agentless_scan_runs_status ON agentless_scan_runs (org_id, status, created_at);

-- Metadata-only findings. No file contents, no secret values: a secret finding
-- records WHERE a secret was found and its kind, never the secret itself.
CREATE TABLE IF NOT EXISTS agentless_scan_findings (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  run_id text NOT NULL,
  volume_id text NOT NULL,
  instance_id text,
  region text NOT NULL,
  -- vuln | secret | sbom | malware — which scanner produced it
  scanner text NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  cve_id text,
  package_name text,
  package_version text,
  fixed_version text,
  -- Path is a location, deliberately not contents.
  location text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS agentless_scan_findings_run ON agentless_scan_findings (org_id, customer_id, run_id, severity);
CREATE INDEX IF NOT EXISTS agentless_scan_findings_cve ON agentless_scan_findings (org_id, customer_id, cve_id);
CREATE INDEX IF NOT EXISTS agentless_scan_findings_volume ON agentless_scan_findings (org_id, customer_id, volume_id, created_at);

-- Cost-safety net: a snapshot or volume Sutra created and FAILED to delete.
-- Every row here is billable customer spend that Sutra caused, so it is tracked
-- until proven gone. resolved_at NULL == still costing money.
CREATE TABLE IF NOT EXISTS agentless_teardown_debt (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text NOT NULL,
  connection_id text NOT NULL,
  run_id text NOT NULL,
  -- snapshot | volume
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  region text NOT NULL,
  -- Which account holds it: the customer's, or Sutra's scan account.
  account_scope text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  last_error text,
  first_seen_at bigint NOT NULL,
  last_attempt_at bigint NOT NULL,
  resolved_at bigint
);
-- One debt row per physical resource: retrying a sweep must not duplicate it.
CREATE UNIQUE INDEX IF NOT EXISTS agentless_teardown_debt_resource
  ON agentless_teardown_debt (org_id, resource_kind, resource_id);
CREATE INDEX IF NOT EXISTS agentless_teardown_debt_open
  ON agentless_teardown_debt (org_id, resolved_at, last_attempt_at);
CREATE INDEX IF NOT EXISTS agentless_teardown_debt_run
  ON agentless_teardown_debt (org_id, customer_id, run_id);
