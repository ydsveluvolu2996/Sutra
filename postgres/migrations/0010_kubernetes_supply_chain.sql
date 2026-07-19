CREATE TABLE IF NOT EXISTS kubernetes_supply_chain_evidence (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id),
  customer_id text NOT NULL REFERENCES customers(id),
  cluster_id text NOT NULL REFERENCES kubernetes_clusters(id),
  image_repository text NOT NULL,
  image_digest text NOT NULL,
  collected_at bigint NOT NULL,
  priority_score integer NOT NULL,
  priority_rating text NOT NULL,
  evidence_json text NOT NULL,
  evidence_sha256 text NOT NULL,
  created_at bigint DEFAULT ((extract(epoch FROM clock_timestamp()) * 1000)::bigint) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_supply_chain_cluster_evidence_uq
  ON kubernetes_supply_chain_evidence (cluster_id, evidence_sha256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_supply_chain_scope_time_idx
  ON kubernetes_supply_chain_evidence (org_id, customer_id, cluster_id, collected_at, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_supply_chain_digest_idx
  ON kubernetes_supply_chain_evidence (org_id, customer_id, image_digest);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sutra_reject_kubernetes_supply_chain_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'kubernetes supply-chain evidence is immutable'; END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_supply_chain_no_update ON kubernetes_supply_chain_evidence;
--> statement-breakpoint
CREATE TRIGGER kubernetes_supply_chain_no_update
BEFORE UPDATE ON kubernetes_supply_chain_evidence
FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_supply_chain_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS kubernetes_supply_chain_no_delete ON kubernetes_supply_chain_evidence;
--> statement-breakpoint
CREATE TRIGGER kubernetes_supply_chain_no_delete
BEFORE DELETE ON kubernetes_supply_chain_evidence
FOR EACH ROW EXECUTE FUNCTION sutra_reject_kubernetes_supply_chain_mutation();
