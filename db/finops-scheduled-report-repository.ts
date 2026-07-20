// Persistence for scheduled FinOps cost reports. Each row is a tenant-scoped
// (org_id + customer_id) schedule that fires on a weekly/monthly cadence and
// delivers a cost summary to a per-schedule destination. Only the DESTINATION
// lives in the row — a webhook URL or a recipient address — never a secret or
// token: the outbound transport credentials come from the shared SUTRA_CONTACT_*
// environment (see lib/finops-report-delivery.ts), exactly as public contact
// delivery does.
//
// Scoping: create/list/get/setEnabled/delete are all gated to an owned, active
// customer. listDue() is the ONE system-level read — the scheduler tick scans
// every tenant's due schedules at once (like JobQueueRepository.leaseNext), but
// each returned row still carries its org_id + customer_id so the enqueued job
// runs strictly within that tenant. Dual D1/Postgres access mirrors
// finops-workspace-repository.
import { assertSafeOutboundUrl } from "../lib/ssrf-guard.ts";
import { isReportCadence, nextRunAtIso, type ReportCadence } from "../lib/finops-report-schedule.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const REPORT_ID = /^fsr_[a-f0-9]{32}$/u;
const REPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:/+-]{0,79}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const MAX_TARGET_LENGTH = 2_048;
const MAX_EMAIL_LENGTH = 320;
const MAX_LIST_ROWS = 200;
const MAX_DUE_ROWS = 500;

export type ReportDeliveryKind = "webhook" | "email";

export interface FinopsScheduledReportScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface ScheduledReportInput {
  readonly name: string;
  readonly connectionId: string;
  readonly cadence: ReportCadence;
  readonly deliveryKind: ReportDeliveryKind;
  readonly deliveryTarget: string;
  readonly enabled?: boolean;
}

export interface StoredScheduledReport {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly cadence: ReportCadence;
  readonly deliveryKind: ReportDeliveryKind;
  readonly deliveryTarget: string;
  readonly enabled: boolean;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DueScheduledReport {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly name: string;
  readonly connectionId: string;
  readonly cadence: ReportCadence;
  readonly deliveryKind: ReportDeliveryKind;
  readonly deliveryTarget: string;
  readonly nextRunAt: string;
}

interface ReportRow {
  id: string;
  org_id: string;
  customer_id: string;
  name: string;
  connection_id: string;
  cadence: string;
  delivery_kind: string;
  delivery_target: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class FinopsScheduledReportRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: FinopsScheduledReportRepositoryError["code"]) {
    super("FinOps scheduled-report operation rejected");
    this.name = "FinopsScheduledReportRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new FinopsScheduledReportRepositoryError("INVALID_INPUT");
}

function assertScope(scope: FinopsScheduledReportScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

function assertCadence(value: string): asserts value is ReportCadence {
  if (!isReportCadence(value)) invalid();
}

/** Validate and normalize the per-schedule destination. NEVER a secret. */
export function normalizeDeliveryTarget(kind: ReportDeliveryKind, target: string): string {
  if (kind === "webhook") {
    if (target.length === 0 || target.length > MAX_TARGET_LENGTH) invalid();
    let safe: URL;
    try {
      // SSRF-screen at STORE time so a dangerous endpoint can never be persisted.
      safe = assertSafeOutboundUrl(target);
    } catch {
      invalid();
    }
    if (safe.protocol !== "https:" || safe.hash !== "") invalid();
    return safe.toString();
  }
  const email = target.trim();
  if (!EMAIL.test(email) || email.length > MAX_EMAIL_LENGTH) invalid();
  return email;
}

function toStored(row: ReportRow): StoredScheduledReport {
  return {
    id: row.id,
    name: row.name,
    connectionId: row.connection_id,
    cadence: row.cadence as ReportCadence,
    deliveryKind: row.delivery_kind as ReportDeliveryKind,
    deliveryTarget: row.delivery_target,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FinopsScheduledReportRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Create or update (by name) a schedule. Reschedules the next run each time. */
  public async save(
    scope: FinopsScheduledReportScope,
    input: ScheduledReportInput,
    createdBy: string,
    now = Date.now(),
  ): Promise<StoredScheduledReport> {
    assertScope(scope);
    if (
      !REPORT_NAME.test(input.name) ||
      !CONNECTION_ID.test(input.connectionId) ||
      (input.deliveryKind !== "webhook" && input.deliveryKind !== "email") ||
      !IDENTIFIER.test(createdBy)
    ) invalid();
    assertCadence(input.cadence);
    const deliveryTarget = normalizeDeliveryTarget(input.deliveryKind, input.deliveryTarget);
    const db = await this.ready();
    const id = `fsr_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date(now).toISOString();
    const nextRunAt = nextRunAtIso(input.cadence, now);
    const result = await db.prepare(
      `INSERT INTO finops_scheduled_reports
        (id, org_id, customer_id, name, connection_id, cadence, delivery_kind, delivery_target, enabled, last_run_at, next_run_at, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, name) DO UPDATE SET
         customer_id = excluded.customer_id,
         connection_id = excluded.connection_id,
         cadence = excluded.cadence,
         delivery_kind = excluded.delivery_kind,
         delivery_target = excluded.delivery_target,
         enabled = excluded.enabled,
         next_run_at = excluded.next_run_at,
         updated_at = excluded.updated_at`,
    ).bind(
      id, input.name, input.connectionId, input.cadence, input.deliveryKind, deliveryTarget,
      input.enabled === false ? 0 : 1, null, nextRunAt, createdBy, timestamp, timestamp,
      scope.customerId, scope.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new FinopsScheduledReportRepositoryError("SCOPE_NOT_FOUND");
    const stored = await db.prepare(
      `SELECT * FROM finops_scheduled_reports WHERE org_id = ? AND name = ? LIMIT 1`,
    ).bind(scope.orgId, input.name).first<ReportRow>();
    if (stored === null) throw new FinopsScheduledReportRepositoryError("SCOPE_NOT_FOUND");
    return toStored(stored);
  }

  public async list(scope: FinopsScheduledReportScope): Promise<readonly StoredScheduledReport[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT * FROM finops_scheduled_reports WHERE org_id = ? AND customer_id = ? ORDER BY name ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<ReportRow>();
    return (rows.results ?? []).map(toStored);
  }

  public async get(scope: FinopsScheduledReportScope, id: string): Promise<StoredScheduledReport | null> {
    assertScope(scope);
    if (!REPORT_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT * FROM finops_scheduled_reports WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<ReportRow>();
    return row === null ? null : toStored(row);
  }

  /** Enable or disable a schedule. Disabling leaves the row (never dropped). */
  public async setEnabled(scope: FinopsScheduledReportScope, id: string, enabled: boolean, now = Date.now()): Promise<boolean> {
    assertScope(scope);
    if (!REPORT_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE finops_scheduled_reports SET enabled = ?, updated_at = ? WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(enabled ? 1 : 0, new Date(now).toISOString(), id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  public async delete(scope: FinopsScheduledReportScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!REPORT_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM finops_scheduled_reports WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  /**
   * SYSTEM-LEVEL scan: every enabled schedule whose next run is at or before
   * `now`, across all tenants. Each row carries its own tenant scope so the
   * caller enqueues a strictly tenant-scoped job.
   */
  public async listDue(now = Date.now()): Promise<readonly DueScheduledReport[]> {
    if (!Number.isFinite(now)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, org_id, customer_id, name, connection_id, cadence, delivery_kind, delivery_target, next_run_at
         FROM finops_scheduled_reports
        WHERE enabled = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC LIMIT ?`,
    ).bind(new Date(now).toISOString(), MAX_DUE_ROWS).all<ReportRow>();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      orgId: row.org_id,
      customerId: row.customer_id,
      name: row.name,
      connectionId: row.connection_id,
      cadence: row.cadence as ReportCadence,
      deliveryKind: row.delivery_kind as ReportDeliveryKind,
      deliveryTarget: row.delivery_target,
      nextRunAt: row.next_run_at,
    }));
  }

  /**
   * Record that a schedule ran at `ranAt` and set its `nextRunAt`. Keyed by the
   * globally-unique id (the scheduler tick already resolved the tenant via
   * listDue). Returns false if the id no longer exists.
   */
  public async markRun(id: string, ranAt: number, nextRunAt: string, now = Date.now()): Promise<boolean> {
    if (!REPORT_ID.test(id) || !Number.isFinite(ranAt)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE finops_scheduled_reports SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(new Date(ranAt).toISOString(), nextRunAt, new Date(now).toISOString(), id).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
