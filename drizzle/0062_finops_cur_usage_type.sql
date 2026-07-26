-- SQLite/D1 mirror of postgres/migrations/0056_finops_cur_usage_type.sql.
-- Adds the nullable usage-type + metered-quantity columns to finops_cur_lines so
-- the parser can persist each line's usage type (the only column naming the
-- metered thing: the Bedrock model + token direction, or the EC2 instance type
-- behind GPU spend), the metered quantity in integer micro-units (a QUANTITY,
-- not money — token counts and GPU-hours are measured, never back-derived from
-- cost) and the quantity's unit. Historical rows stay null and are reported as
-- unavailable. Additive; runs once through the runtime migration ledger.
ALTER TABLE finops_cur_lines ADD COLUMN usage_type text;
--> statement-breakpoint
ALTER TABLE finops_cur_lines ADD COLUMN usage_amount_micros integer;
--> statement-breakpoint
ALTER TABLE finops_cur_lines ADD COLUMN usage_unit text;
