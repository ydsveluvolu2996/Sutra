-- SQLite/D1 mirror of postgres/migrations/0050_finops_cur_region.sql.
-- Adds a nullable region to finops_cur_lines so the region-aware CUR/FOCUS
-- parser can persist each line item's cloud region; historical rows stay null.
-- Additive; runs once through the runtime migration ledger.
ALTER TABLE finops_cur_lines ADD COLUMN region text;
