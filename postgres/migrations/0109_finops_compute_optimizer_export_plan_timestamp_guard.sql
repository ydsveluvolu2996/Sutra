-- Forward guard for databases that applied 0107 before the JavaScript Date
-- boundary was tightened. PostgreSQL validates existing rows while adding it.
ALTER TABLE finops_co_export_plans
  ADD CONSTRAINT finops_co_export_plans_created_at_js_date_check
  CHECK (created_at BETWEEN 0 AND 8640000000000000);
--> statement-breakpoint
REVOKE ALL ON finops_co_export_plans FROM PUBLIC;
