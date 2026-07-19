CREATE TABLE IF NOT EXISTS kubernetes_scan_scanner_evidence (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  scan_run_id text NOT NULL REFERENCES kubernetes_scan_runs(id),
  findings_json text NOT NULL,
  sboms_json text NOT NULL,
  evidence_sha256 text NOT NULL,
  finding_count integer NOT NULL,
  sbom_count integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_scan_scanner_evidence_run_uq
  ON kubernetes_scan_scanner_evidence (scan_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_scan_scanner_evidence_scope_idx
  ON kubernetes_scan_scanner_evidence (org_id, customer_id, cluster_id, scan_run_id);
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_scanner_evidence_no_update
  ON kubernetes_scan_scanner_evidence;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_scanner_evidence_no_update
  BEFORE UPDATE ON kubernetes_scan_scanner_evidence
  FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_scan_scanner_evidence_no_delete
  ON kubernetes_scan_scanner_evidence;
--> statement-breakpoint
CREATE TRIGGER kubernetes_scan_scanner_evidence_no_delete
  BEFORE DELETE ON kubernetes_scan_scanner_evidence
  FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_scan_mutation();
