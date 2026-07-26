-- Resource schedules: an operator-stated "these tagged dev instances may run
-- 08:00-20:00 on weekdays and are off at weekends" window, used to compute what
-- the schedule WOULD save and to generate the EventBridge Scheduler template the
-- CUSTOMER applies in their own account. Sutra's trust role is read-only and
-- never starts or stops anything, so no row here is ever enforced by Sutra.
-- Additive: a new table and its index only.
CREATE TABLE IF NOT EXISTS finops_resource_schedules (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  customer_id text,
  connection_id text,
  name text NOT NULL,
  schedule_json text NOT NULL,
  selector_json text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS finops_resource_schedules_org ON finops_resource_schedules (org_id, customer_id, name);
