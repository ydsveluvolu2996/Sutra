// Persistence for FinOps resource schedules. Each row is a tenant-scoped
// (org_id + customer_id) statement of "resources carrying this tag may run
// inside these windows"; the engine turns it into advisory savings and into the
// template the customer applies in their own account. Sutra never enforces a
// row here — the connection role is read-only and has no start/stop permission.
//
// Rows are operator configuration: validated before storage (via the engine's
// own parsers, so the stored shape and the computed shape can never drift),
// bounded per tenant, and never trusting a caller-supplied org — the route
// passes the authorized scope. Dual D1/Postgres access mirrors
// db/allocation-rules-repository.
import type { ResourceScheduleDefinition, ScheduleSelector } from "../lib/finops-resource-schedule.ts";
import { parseScheduleDefinition, parseScheduleSelector } from "../lib/finops-resource-schedule.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SCHEDULE_ID = /^rs_[a-f0-9]{32}$/u;
// Deliberately the SAME character set the artefact generator accepts, so a name
// that can be stored can always be turned into a deployable template.
const SCHEDULE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const MAX_LIST_ROWS = 200;
const MAX_SCHEDULES = 200;

export interface ResourceScheduleScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface ResourceScheduleInput {
  readonly name: string;
  readonly schedule: ResourceScheduleDefinition;
  readonly selector: ScheduleSelector;
  readonly enabled?: boolean;
  readonly connectionId?: string;
}

export interface ResourceSchedulePatch {
  readonly name?: string;
  readonly schedule?: ResourceScheduleDefinition;
  readonly selector?: ScheduleSelector;
  readonly enabled?: boolean;
}

export interface StoredResourceSchedule {
  readonly id: string;
  readonly connectionId: string | null;
  readonly name: string;
  readonly schedule: ResourceScheduleDefinition;
  readonly selector: ScheduleSelector;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ScheduleRow {
  id: string;
  connection_id: string | null;
  name: string;
  schedule_json: string;
  selector_json: string;
  enabled: number;
  created_at: string | number;
  updated_at: string | number;
}

export class ResourceScheduleRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "LIMIT_EXCEEDED";

  public constructor(code: ResourceScheduleRepositoryError["code"]) {
    super("Resource-schedule operation rejected");
    this.name = "ResourceScheduleRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new ResourceScheduleRepositoryError("INVALID_INPUT");
}

function assertScope(scope: ResourceScheduleScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

/** Re-validate through the engine's parser so stored JSON is always plannable. */
function normalizeSchedule(schedule: ResourceScheduleDefinition): ResourceScheduleDefinition {
  const parsed = parseScheduleDefinition(schedule);
  if (parsed === null) invalid();
  return parsed;
}

function normalizeSelector(selector: ScheduleSelector): ScheduleSelector {
  const parsed = parseScheduleSelector(selector);
  if (parsed === null) invalid();
  return parsed;
}

function toIso(value: string | number): string {
  if (typeof value === "number") return new Date(value).toISOString();
  // Postgres bigint arrives as a string; a plain integer string is epoch millis.
  return /^\d+$/u.test(value) ? new Date(Number(value)).toISOString() : value;
}

/**
 * Rows written before a validation change (or hand-edited) could fail to parse.
 * Such a row is returned with its stored intent visibly unusable rather than
 * silently replaced by a plausible default: callers see `schedule === null`.
 */
function toStored(row: ScheduleRow): StoredResourceSchedule | null {
  let scheduleRaw: unknown = null;
  let selectorRaw: unknown = null;
  try {
    scheduleRaw = JSON.parse(row.schedule_json);
    selectorRaw = JSON.parse(row.selector_json);
  } catch {
    return null;
  }
  const schedule = parseScheduleDefinition(scheduleRaw);
  const selector = parseScheduleSelector(selectorRaw);
  if (schedule === null || selector === null) return null;
  return {
    id: row.id,
    connectionId: typeof row.connection_id === "string" && row.connection_id.length > 0 ? row.connection_id : null,
    name: row.name,
    schedule,
    selector,
    enabled: Number(row.enabled) === 1,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_COLUMNS =
  "id, connection_id, name, schedule_json, selector_json, enabled, created_at, updated_at";

export class ResourceScheduleRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async list(scope: ResourceScheduleScope): Promise<readonly StoredResourceSchedule[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM finops_resource_schedules
        WHERE org_id = ? AND customer_id = ?
        ORDER BY name ASC, created_at ASC, id ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<ScheduleRow>();
    const stored: StoredResourceSchedule[] = [];
    for (const row of rows.results ?? []) {
      const parsed = toStored(row);
      if (parsed !== null) stored.push(parsed);
    }
    return stored;
  }

  public async create(
    scope: ResourceScheduleScope,
    input: ResourceScheduleInput,
    now = Date.now(),
  ): Promise<StoredResourceSchedule> {
    assertScope(scope);
    if (typeof input.name !== "string" || !SCHEDULE_NAME.test(input.name)) invalid();
    if (input.connectionId !== undefined && !CONNECTION_ID.test(input.connectionId)) invalid();
    const schedule = normalizeSchedule(input.schedule);
    const selector = normalizeSelector(input.selector);
    const db = await this.ready();
    // Gate writes to an owned, active customer up front (one authoritative check).
    const owned = await db.prepare(
      `SELECT id FROM customers WHERE id = ? AND org_id = ? AND status IN ('active', 'trial')`,
    ).bind(scope.customerId, scope.orgId).first<{ id: string }>();
    if (owned === null || owned === undefined) throw new ResourceScheduleRepositoryError("SCOPE_NOT_FOUND");
    const countRow = await db.prepare(
      `SELECT COUNT(*) AS total FROM finops_resource_schedules WHERE org_id = ? AND customer_id = ?`,
    ).bind(scope.orgId, scope.customerId).first<{ total: number }>();
    if (Number(countRow?.total ?? 0) >= MAX_SCHEDULES) throw new ResourceScheduleRepositoryError("LIMIT_EXCEEDED");
    const id = `rs_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare(
      `INSERT INTO finops_resource_schedules
         (id, org_id, customer_id, connection_id, name, schedule_json, selector_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, scope.orgId, scope.customerId, input.connectionId ?? null, input.name,
      JSON.stringify(schedule), JSON.stringify(selector),
      input.enabled === false ? 0 : 1, now, now,
    ).run();
    const stored = await this.get(scope, id);
    if (stored === null) throw new ResourceScheduleRepositoryError("SCOPE_NOT_FOUND");
    return stored;
  }

  public async get(scope: ResourceScheduleScope, id: string): Promise<StoredResourceSchedule | null> {
    assertScope(scope);
    if (!SCHEDULE_ID.test(id)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM finops_resource_schedules WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<ScheduleRow>();
    return row === null ? null : toStored(row);
  }

  public async update(
    scope: ResourceScheduleScope,
    id: string,
    patch: ResourceSchedulePatch,
    now = Date.now(),
  ): Promise<StoredResourceSchedule | null> {
    assertScope(scope);
    if (!SCHEDULE_ID.test(id)) invalid();
    const existing = await this.get(scope, id);
    if (existing === null) return null;
    const name = patch.name ?? existing.name;
    if (!SCHEDULE_NAME.test(name)) invalid();
    const schedule = normalizeSchedule(patch.schedule ?? existing.schedule);
    const selector = normalizeSelector(patch.selector ?? existing.selector);
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled;
    const db = await this.ready();
    await db.prepare(
      `UPDATE finops_resource_schedules
          SET name = ?, schedule_json = ?, selector_json = ?, enabled = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(
      name, JSON.stringify(schedule), JSON.stringify(selector), enabled ? 1 : 0, now,
      id, scope.orgId, scope.customerId,
    ).run();
    return this.get(scope, id);
  }

  public async delete(scope: ResourceScheduleScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!SCHEDULE_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM finops_resource_schedules WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
