-- finops_budgets.customer_id is NOT NULL, so the table is customer-scoped, but
-- the original unique index was (org_id, name). In a multi-customer MSP org that
-- made budget names collide across customers, and the repository's upsert
-- conflict target hit another customer's row. Widen the uniqueness to
-- (org_id, customer_id, name): strictly less restrictive than the index it
-- replaces, so every existing row already satisfies it.
DROP INDEX IF EXISTS finops_budgets_name;
CREATE UNIQUE INDEX IF NOT EXISTS finops_budgets_scope_name ON finops_budgets (org_id, customer_id, name);
