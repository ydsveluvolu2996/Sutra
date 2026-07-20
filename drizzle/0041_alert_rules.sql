CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN (
    'budget-breach-count', 'budget-utilization-percent', 'cost-anomaly-count',
    'new-critical-findings-count', 'open-critical-findings-count',
    'kev-vulnerability-count', 'posture-score'
  )),
  comparator TEXT NOT NULL CHECK (comparator IN ('gt', 'gte', 'lt', 'lte', 'eq')),
  threshold REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  destination_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_name ON alert_rules (org_id, name);
CREATE INDEX IF NOT EXISTS alert_rules_enabled ON alert_rules (enabled, org_id, customer_id);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  observed_value REAL NOT NULL,
  message TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('queued', 'no_destination')),
  destination_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS alert_events_recent ON alert_events (org_id, customer_id, fired_at);
CREATE INDEX IF NOT EXISTS alert_events_rule ON alert_events (rule_id, fired_at);
