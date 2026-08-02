-- Forward guard for databases that applied 0112 before the JavaScript Date
-- boundary was tightened. Compute Optimizer plans are immutable, so only new
-- inserts need interception.
CREATE TRIGGER `finops_co_export_plans_created_at_guard`
BEFORE INSERT ON `finops_co_export_plans`
WHEN NEW.`created_at` < 0 OR NEW.`created_at` > 8640000000000000
BEGIN SELECT RAISE(ABORT,'FINOPS_CO_EXPORT_PLAN_CREATED_AT_REJECTED'); END;
