-- SQLite/D1 mirror of postgres/migrations/0051_finops_cur_commitments.sql.
-- Adds nullable amortized cost + commitment (RI/Savings Plan) attribution
-- columns to finops_cur_lines so the commitment-aware CUR/FOCUS parser can
-- persist amortized/effective cost and each line's commitment type, id and
-- expiry; historical rows stay null. Additive; runs once through the runtime
-- migration ledger.
ALTER TABLE finops_cur_lines ADD COLUMN amortized_micros integer;
--> statement-breakpoint
ALTER TABLE finops_cur_lines ADD COLUMN commitment_type text;
--> statement-breakpoint
ALTER TABLE finops_cur_lines ADD COLUMN commitment_id text;
--> statement-breakpoint
ALTER TABLE finops_cur_lines ADD COLUMN commitment_expiry text;
