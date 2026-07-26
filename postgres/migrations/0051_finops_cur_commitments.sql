-- Amortized cost + commitment (RI/Savings Plan) attribution for billing lines.
--
-- The CUR/FOCUS parser now captures each line item's amortized/effective cost
-- and its commitment-discount classification (type, id, expiry), but older
-- uploads predate these columns. Add them nullable so new ingests persist them
-- while historical rows stay null (amortized cost and commitment coverage are
-- honestly reported as unavailable until a commitment-bearing CUR/FOCUS export
-- is re-uploaded).
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS); no data change.
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS amortized_micros bigint;
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS commitment_type text;
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS commitment_id text;
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS commitment_expiry text;
