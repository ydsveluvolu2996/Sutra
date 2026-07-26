DROP INDEX IF EXISTS finops_budgets_name;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS finops_budgets_scope_name ON finops_budgets (org_id, customer_id, name);
