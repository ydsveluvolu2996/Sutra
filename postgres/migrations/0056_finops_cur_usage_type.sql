-- Usage-type and metered-quantity attribution for billing lines.
--
-- The CUR/FOCUS parser previously kept only the SERVICE of a line item
-- ("AmazonBedrock", "AmazonEC2"), which is too coarse to answer two questions
-- the FinOps views now ask:
--   * AI/LLM token cost: which MODEL and which TOKEN DIRECTION a Bedrock line
--     bills for lives only in line_item_usage_type (e.g.
--     "USE1-InputTokenCount-anthropic.claude-3-sonnet").
--   * GPU cost: which INSTANCE TYPE compute spend belongs to also lives only in
--     the usage type (e.g. "USE1-BoxUsage:p4d.24xlarge").
-- The metered QUANTITY (line_item_usage_amount) and its unit (pricing_unit) are
-- captured alongside so token volumes and GPU-hours come from measured usage
-- rather than being back-derived from cost.
--
-- usage_amount_micros is a QUANTITY, not money: integer micro-units of the
-- metered amount, using the same bigint discipline as amount_micros so sums are
-- exact. Older uploads predate all three columns, so they are nullable and stay
-- null — token volumes and GPU usage are honestly reported as unavailable until
-- a usage-type-bearing CUR/FOCUS export is re-uploaded, never estimated.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS); no data change.
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS usage_type text;
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS usage_amount_micros bigint;
ALTER TABLE finops_cur_lines ADD COLUMN IF NOT EXISTS usage_unit text;
