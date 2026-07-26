-- Region attribution for ingested billing lines.
--
-- The CUR/FOCUS parser now captures each line item's cloud region, but older
-- uploads predate that column. Add a nullable region so new ingests persist it
-- while historical rows stay null (region cost is honestly reported as
-- unavailable until a region-bearing CUR is re-uploaded).
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS); no data change.
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS region text;
