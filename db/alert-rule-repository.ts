// Persistence for metric-alerting rules and the events they fire. A rule row is
// tenant-scoped (org_id + customer_id); it stores ONLY the comparison — metric,
// comparator, threshold, severity — and an optional destination reference. It
// never holds a secret, token, or webhook URL: dispatch reuses the existing
// notification-destination system, whose managed secrets live elsewhere.
//
// Scoping mirrors finops-scheduled-report-repository: save/get/list/setEnabled/
// delete/recordEvent/listEvents/listEnabled are gated to an owned, active
// customer. listEnabledForAllTenants() is the ONE system-level read — the tick
// scans every tenant's enabled rules at once (like FinopsScheduledReportRepository
// .listDue), but each returned row still carries its org_id + customer_id so the
// enqueued evaluation job runs strictly within that tenant. Dual D1/Postgres
// access is via the shared getRawDb()/ensureRuntimeSchema() path.
import {
  isAlertComparator,
  isAlertSeverity,
  isSupportedAlertMetric,
  type AlertRule,
} from "../lib/alert-rules.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const RULE_ID = /^arule_[a-f0-9]{32}$/u;
const DESTINATION_ID = /^ndest_[a-f0-9]{32}$/u;
const RULE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const MAX_THRESHOLD_MAGNITUDE = 1e12;
const MAX_LIST_ROWS = 200;
const MAX_EVENT_ROWS = 100;
const MAX_ENABLED_SCAN_ROWS = 2_000;
const MAX_MESSAGE_LENGTH = 2_000;

export type AlertEventDeliveryState = "queued" | "no_destination";

export interface AlertRuleScopeInput {
  readonly orgId: string;
  readonly customerId: string;
}

export interface AlertRuleInput {
  readonly name: string;
  readonly metric: string;
  readonly comparator: string;
  readonly threshold: number;
  readonly severity: string;
  readonly enabled?: boolean;
  readonly destinationRef?: string | null;
}

export interface RecordAlertEventInput {
  readonly orgId: string;
  readonly customerId: string;
  readonly ruleId: string;
  readonly observedValue: number;
  readonly message: string;
  readonly deliveryState: AlertEventDeliveryState;
  readonly destinationCount: number;
}

export interface StoredAlertEvent {
  readonly id: string;
  readonly ruleId: string;
  readonly firedAt: string;
  readonly observedValue: number;
  readonly message: string;
  readonly deliveryState: AlertEventDeliveryState;
  readonly destinationCount: number;
}

interface RuleRow {
  id: string;
  org_id: string;
  customer_id: string;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  severity: string;
  enabled: number;
  destination_ref: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: string;
  rule_id: string;
  fired_at: number;
  observed_value: number;
  message: string;
  delivery_state: string;
  destination_count: number;
}

export class AlertRuleRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: AlertRuleRepositoryError["code"]) {
    super("Alert rule operation rejected");
    this.name = "AlertRuleRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new AlertRuleRepositoryError("INVALID_INPUT");
}

function assertScope(scope: AlertRuleScopeInput): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

function assertThreshold(value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_THRESHOLD_MAGNITUDE) invalid();
}

function normalizeDestinationRef(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!DESTINATION_ID.test(value)) invalid();
  return value;
}

function toRule(row: RuleRow): AlertRule {
  if (!isSupportedAlertMetric(row.metric) || !isAlertComparator(row.comparator) || !isAlertSeverity(row.severity)) {
    invalid();
  }
  return {
    id: row.id,
    name: row.name,
    metric: row.metric,
    comparator: row.comparator,
    threshold: Number(row.threshold),
    severity: row.severity,
    scope: { orgId: row.org_id, customerId: row.customer_id },
    enabled: Number(row.enabled) === 1,
    destinationRef: row.destination_ref,
  };
}

function toEvent(row: EventRow): StoredAlertEvent {
  const state: AlertEventDeliveryState = row.delivery_state === "no_destination" ? "no_destination" : "queued";
  return {
    id: row.id,
    ruleId: row.rule_id,
    firedAt: new Date(Number(row.fired_at)).toISOString(),
    observedValue: Number(row.observed_value),
    message: row.message,
    deliveryState: state,
    destinationCount: Number(row.destination_count),
  };
}

const RULE_SELECT = `
  SELECT id, org_id, customer_id, name, metric, comparator, threshold, severity,
         enabled, destination_ref, created_by, created_at, updated_at
    FROM alert_rules`;

export class AlertRuleRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Create or update (by name) a rule for an owned, active customer. */
  public async save(
    scope: AlertRuleScopeInput,
    input: AlertRuleInput,
    createdBy: string,
    now = Date.now(),
  ): Promise<AlertRule> {
    assertScope(scope);
    if (
      !RULE_NAME.test(input.name) ||
      !isSupportedAlertMetric(input.metric) ||
      !isAlertComparator(input.comparator) ||
      !isAlertSeverity(input.severity) ||
      !IDENTIFIER.test(createdBy)
    ) invalid();
    assertThreshold(input.threshold);
    const destinationRef = normalizeDestinationRef(input.destinationRef);
    const enabled = input.enabled === false ? 0 : 1;
    const db = await this.ready();
    const id = `arule_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = await db.prepare(
      `INSERT INTO alert_rules
        (id, org_id, customer_id, name, metric, comparator, threshold, severity,
         enabled, destination_ref, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, name) DO UPDATE SET
         customer_id = excluded.customer_id,
         metric = excluded.metric,
         comparator = excluded.comparator,
         threshold = excluded.threshold,
         severity = excluded.severity,
         enabled = excluded.enabled,
         destination_ref = excluded.destination_ref,
         updated_at = excluded.updated_at`,
    ).bind(
      id, input.name, input.metric, input.comparator, input.threshold, input.severity,
      enabled, destinationRef, createdBy, now, now,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new AlertRuleRepositoryError("SCOPE_NOT_FOUND");
    const stored = await db.prepare(
      `${RULE_SELECT} WHERE org_id = ? AND name = ? LIMIT 1`,
    ).bind(scope.orgId, input.name).first<RuleRow>();
    if (stored === null) throw new AlertRuleRepositoryError("SCOPE_NOT_FOUND");
    return toRule(stored);
  }

  public async list(scope: AlertRuleScopeInput): Promise<readonly AlertRule[]> {
    assertScope(scope);
    const rows = await (await this.ready()).prepare(
      `${RULE_SELECT} WHERE org_id = ? AND customer_id = ? ORDER BY name ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<RuleRow>();
    return (rows.results ?? []).map(toRule);
  }

  public async get(scope: AlertRuleScopeInput, id: string): Promise<AlertRule | null> {
    assertScope(scope);
    if (!RULE_ID.test(id)) invalid();
    const row = await (await this.ready()).prepare(
      `${RULE_SELECT} WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<RuleRow>();
    return row === null ? null : toRule(row);
  }

  /** Enable or disable a rule. Disabling leaves the row (never dropped). */
  public async setEnabled(scope: AlertRuleScopeInput, id: string, enabled: boolean, now = Date.now()): Promise<boolean> {
    assertScope(scope);
    if (!RULE_ID.test(id)) invalid();
    const result = await (await this.ready()).prepare(
      `UPDATE alert_rules SET enabled = ?, updated_at = ? WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(enabled ? 1 : 0, now, id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  public async delete(scope: AlertRuleScopeInput, id: string): Promise<boolean> {
    assertScope(scope);
    if (!RULE_ID.test(id)) invalid();
    const result = await (await this.ready()).prepare(
      `DELETE FROM alert_rules WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  /** Enabled rules for one tenant — used by the evaluation job for that tenant. */
  public async listEnabled(scope: AlertRuleScopeInput): Promise<readonly AlertRule[]> {
    assertScope(scope);
    const rows = await (await this.ready()).prepare(
      `${RULE_SELECT} WHERE org_id = ? AND customer_id = ? AND enabled = 1 ORDER BY name ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<RuleRow>();
    return (rows.results ?? []).map(toRule);
  }

  /**
   * SYSTEM-LEVEL scan: every enabled rule across all tenants. Each row carries
   * its own tenant scope so the caller enqueues strictly tenant-scoped evaluation
   * jobs. `now` is accepted for signature parity with listDue-style scans.
   */
  public async listEnabledForAllTenants(now = Date.now()): Promise<readonly AlertRule[]> {
    if (!Number.isFinite(now)) invalid();
    const rows = await (await this.ready()).prepare(
      `${RULE_SELECT} WHERE enabled = 1 ORDER BY org_id ASC, customer_id ASC, name ASC LIMIT ?`,
    ).bind(MAX_ENABLED_SCAN_ROWS).all<RuleRow>();
    return (rows.results ?? []).map(toRule);
  }

  /**
   * Record a fired event. Gated to the rule actually belonging to (org, customer)
   * so a caller can never write an event against another tenant's rule.
   */
  public async recordEvent(input: RecordAlertEventInput, now = Date.now()): Promise<StoredAlertEvent> {
    if (
      !IDENTIFIER.test(input.orgId) ||
      !IDENTIFIER.test(input.customerId) ||
      !RULE_ID.test(input.ruleId) ||
      typeof input.observedValue !== "number" || !Number.isFinite(input.observedValue) ||
      typeof input.message !== "string" || input.message.length < 1 || input.message.length > MAX_MESSAGE_LENGTH ||
      (input.deliveryState !== "queued" && input.deliveryState !== "no_destination") ||
      !Number.isSafeInteger(input.destinationCount) || input.destinationCount < 0 || input.destinationCount > 1_000
    ) invalid();
    const db = await this.ready();
    const id = `aevt_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = await db.prepare(
      `INSERT INTO alert_events
        (id, org_id, customer_id, rule_id, fired_at, observed_value, message, delivery_state, destination_count, created_at)
       SELECT ?, r.org_id, r.customer_id, r.id, ?, ?, ?, ?, ?, ?
         FROM alert_rules r
        WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ?`,
    ).bind(
      id, now, input.observedValue, input.message, input.deliveryState, input.destinationCount, now,
      input.ruleId, input.orgId, input.customerId,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw new AlertRuleRepositoryError("SCOPE_NOT_FOUND");
    return {
      id,
      ruleId: input.ruleId,
      firedAt: new Date(now).toISOString(),
      observedValue: input.observedValue,
      message: input.message,
      deliveryState: input.deliveryState,
      destinationCount: input.destinationCount,
    };
  }

  public async listEvents(scope: AlertRuleScopeInput, limit = 50): Promise<readonly StoredAlertEvent[]> {
    assertScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_ROWS) invalid();
    const rows = await (await this.ready()).prepare(
      `SELECT id, rule_id, fired_at, observed_value, message, delivery_state, destination_count
         FROM alert_events
        WHERE org_id = ? AND customer_id = ?
        ORDER BY fired_at DESC, id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, limit).all<EventRow>();
    return (rows.results ?? []).map(toEvent);
  }
}
