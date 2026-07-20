ALTER TABLE kubernetes_agent_bootstraps ADD COLUMN IF NOT EXISTS node_scoped integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE kubernetes_agents ADD COLUMN IF NOT EXISTS node_name text;
--> statement-breakpoint
DROP INDEX IF EXISTS kubernetes_agents_active_cluster_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS kubernetes_agents_active_cluster_node_uq ON kubernetes_agents (org_id, customer_id, cluster_id, COALESCE(node_name, '')) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS kubernetes_agents_node_idx ON kubernetes_agents (org_id, customer_id, cluster_id, node_name, status);
