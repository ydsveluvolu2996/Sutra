/** Tenant-scoped, append-only governance for sustainability proxy targets. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type {
  SustainabilityPersistenceScope,
} from "./finops-sustainability-carbon-repository.ts";
import type {
  SustainabilityProxyMetric,
  SustainabilityProxyUnit,
} from "../lib/finops-sustainability-carbon.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const TARGET = /^stgt_[a-f0-9]{64}$/u;
const VERSION = /^stgv_[a-f0-9]{64}$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const NON_NEGATIVE = /^(?:0|[1-9]\d{0,30})$/u;
const SAFE = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const MAX_HISTORY = 500;

const METRIC_UNITS: Readonly<Record<SustainabilityProxyMetric, SustainabilityProxyUnit>> = {
  COMPUTE_VCPU_HOURS: "vCPU-hours",
  COMPUTE_MEMORY_GB_HOURS: "GB-hours",
  LAMBDA_GB_SECONDS: "GB-seconds",
  STORAGE_GB_HOURS: "GB-hours",
  STORAGE_REQUESTS: "requests",
  DATA_TRANSFER_GB: "GB",
  DATABASE_VCPU_HOURS: "vCPU-hours",
};

export interface SustainabilityTargetInput {
  readonly metric: SustainabilityProxyMetric;
  readonly workloadTagKey: string | null;
  readonly workloadTagValue: string | null;
  readonly periodStart: string;
  /** Absolute technical resource-use threshold; never a carbon target. */
  readonly targetValueMicros: string;
  readonly reason: string;
}

export interface StoredSustainabilityTarget {
  readonly targetId: string;
  readonly versionId: string;
  readonly scope: SustainabilityPersistenceScope;
  readonly metric: SustainabilityProxyMetric;
  readonly workloadTagKey: string | null;
  readonly workloadTagValue: string | null;
  readonly periodStart: string;
  readonly targetValueMicros: string | null;
  readonly unit: SustainabilityProxyUnit;
  readonly state: "ACTIVE" | "REVOKED";
  readonly reason: string;
  readonly actorId: string;
  readonly priorVersionId: string | null;
  readonly contentSha256: string;
  readonly createdAtIso: string;
}

interface TargetRow {
  version_id: string; target_id: string; org_id: string; customer_id: string;
  connection_id: string; metric: SustainabilityProxyMetric;
  workload_tag_key: string | null; workload_tag_value: string | null;
  period_start: string; target_value_micros: string | null;
  unit: SustainabilityProxyUnit; state: "ACTIVE" | "REVOKED";
  reason: string; actor_id: string; prior_version_id: string | null;
  content_sha256: string; created_at: number | string;
}

export class SustainabilityTargetRepositoryError extends Error {
  public constructor(public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "NOT_FOUND" | "CONCURRENT_WRITE" | "STORED_STATE_INVALID") {
    super("Sustainability target operation rejected");
    this.name = "SustainabilityTargetRepositoryError";
  }
}

function reject(code: SustainabilityTargetRepositoryError["code"]): never {
  throw new SustainabilityTargetRepositoryError(code);
}

function assertScope(scope: SustainabilityPersistenceScope): void {
  if (!ID.test(scope.organizationId) || !ID.test(scope.customerId)
    || !CONNECTION.test(scope.connectionId)) reject("INVALID_INPUT");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function validateInput(input: SustainabilityTargetInput): void {
  if (!(input.metric in METRIC_UNITS) || !MONTH.test(input.periodStart)
    || !NON_NEGATIVE.test(input.targetValueMicros) || !SAFE.test(input.reason)
    || (input.workloadTagKey === null) !== (input.workloadTagValue === null)
    || (input.workloadTagKey !== null && (!SAFE.test(input.workloadTagKey)
      || input.workloadTagKey.length > 128 || input.workloadTagValue === null
      || !SAFE.test(input.workloadTagValue) || input.workloadTagValue.length > 256))) {
    reject("INVALID_INPUT");
  }
}

function materialize(row: TargetRow): StoredSustainabilityTarget {
  const createdAt = typeof row.created_at === "string" ? Number(row.created_at) : row.created_at;
  if (!VERSION.test(row.version_id) || !TARGET.test(row.target_id)
    || !Number.isSafeInteger(createdAt) || createdAt < 0
    || !(row.metric in METRIC_UNITS) || METRIC_UNITS[row.metric] !== row.unit
    || !MONTH.test(row.period_start) || !SAFE.test(row.reason) || !ID.test(row.actor_id)
    || !/^[a-f0-9]{64}$/u.test(row.content_sha256)
    || (row.prior_version_id !== null && !VERSION.test(row.prior_version_id))
    || (row.workload_tag_key === null) !== (row.workload_tag_value === null)
    || (row.state === "ACTIVE" && (row.target_value_micros === null
      || !NON_NEGATIVE.test(row.target_value_micros)))
    || (row.state === "REVOKED" && row.target_value_micros !== null)) {
    reject("STORED_STATE_INVALID");
  }
  return {
    targetId: row.target_id,
    versionId: row.version_id,
    scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    metric: row.metric,
    workloadTagKey: row.workload_tag_key,
    workloadTagValue: row.workload_tag_value,
    periodStart: row.period_start,
    targetValueMicros: row.target_value_micros,
    unit: row.unit,
    state: row.state,
    reason: row.reason,
    actorId: row.actor_id,
    priorVersionId: row.prior_version_id,
    contentSha256: row.content_sha256,
    createdAtIso: new Date(createdAt).toISOString(),
  };
}

export class SustainabilityTargetRepository {
  public constructor(private readonly database: D1Database = getRawDb()) {}

  private async live(scope: SustainabilityPersistenceScope): Promise<D1Database> {
    assertScope(scope);
    await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(
      "SELECT c.id FROM aws_connections c JOIN organizations o ON o.id=c.org_id AND o.status='active' JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active' WHERE c.org_id=? AND c.customer_id=? AND c.id=? AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1",
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return this.database;
  }

  private async activeVersion(db: D1Database, scope: SustainabilityPersistenceScope, targetId: string): Promise<StoredSustainabilityTarget | null> {
    const row = await db.prepare(
      "SELECT v.* FROM finops_sustainability_target_heads h JOIN finops_sustainability_target_versions v ON v.version_id=h.active_version_id AND v.target_id=h.target_id AND v.org_id=h.org_id AND v.customer_id=h.customer_id AND v.connection_id=h.connection_id WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? AND h.target_id=? LIMIT 1",
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, targetId).first<TargetRow>();
    return row === null ? null : materialize(row);
  }

  public async list(scope: SustainabilityPersistenceScope, includeRevoked = false): Promise<readonly StoredSustainabilityTarget[]> {
    const db = await this.live(scope);
    const rows = await db.prepare(
      `SELECT v.* FROM finops_sustainability_target_heads h JOIN finops_sustainability_target_versions v ON v.version_id=h.active_version_id AND v.target_id=h.target_id AND v.org_id=h.org_id AND v.customer_id=h.customer_id AND v.connection_id=h.connection_id WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=?${includeRevoked ? "" : " AND v.state='ACTIVE'"} ORDER BY v.metric,v.workload_tag_key,v.workload_tag_value,v.period_start,v.target_id`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).all<TargetRow>();
    return (rows.results ?? []).map(materialize);
  }

  public async history(scope: SustainabilityPersistenceScope, targetId: string, limit = 100): Promise<readonly StoredSustainabilityTarget[]> {
    if (!TARGET.test(targetId) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY) reject("INVALID_INPUT");
    const db = await this.live(scope);
    const rows = await db.prepare(
      "SELECT * FROM finops_sustainability_target_versions WHERE org_id=? AND customer_id=? AND connection_id=? AND target_id=? ORDER BY created_at DESC,version_id DESC LIMIT ?",
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, targetId, limit).all<TargetRow>();
    return (rows.results ?? []).map(materialize);
  }

  public async set(scope: SustainabilityPersistenceScope, input: SustainabilityTargetInput, actorId: string, nowMs = Date.now()): Promise<StoredSustainabilityTarget> {
    validateInput(input);
    if (!ID.test(actorId) || !Number.isSafeInteger(nowMs) || nowMs < 0) reject("INVALID_INPUT");
    const db = await this.live(scope);
    const targetId = `stgt_${await sha256(canonical({ scope, metric: input.metric, workloadTagKey: input.workloadTagKey, workloadTagValue: input.workloadTagValue, periodStart: input.periodStart }))}`;
    const prior = await this.activeVersion(db, scope, targetId);
    const content = canonical({ schemaVersion: "sutra.sustainability-target-version.v1", targetId, scope, metric: input.metric, workloadTagKey: input.workloadTagKey, workloadTagValue: input.workloadTagValue, periodStart: input.periodStart, targetValueMicros: input.targetValueMicros, unit: METRIC_UNITS[input.metric], state: "ACTIVE", reason: input.reason, actorId, priorVersionId: prior?.versionId ?? null, createdAt: nowMs });
    const contentSha256 = await sha256(content);
    const versionId = `stgv_${contentSha256}`;
    const insert = db.prepare("INSERT INTO finops_sustainability_target_versions(version_id,target_id,org_id,customer_id,connection_id,metric,workload_tag_key,workload_tag_value,period_start,target_value_micros,unit,state,reason,actor_id,prior_version_id,content_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(versionId, targetId, scope.organizationId, scope.customerId, scope.connectionId, input.metric, input.workloadTagKey, input.workloadTagValue, input.periodStart, input.targetValueMicros, METRIC_UNITS[input.metric], "ACTIVE", input.reason, actorId, prior?.versionId ?? null, contentSha256, nowMs);
    const advance = prior === null
      ? db.prepare("INSERT INTO finops_sustainability_target_heads(org_id,customer_id,connection_id,target_id,active_version_id,advanced_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(scope.organizationId, scope.customerId, scope.connectionId, targetId, versionId, nowMs)
      : db.prepare("UPDATE finops_sustainability_target_heads SET active_version_id=?,advanced_at=? WHERE org_id=? AND customer_id=? AND connection_id=? AND target_id=? AND active_version_id=?").bind(versionId, nowMs, scope.organizationId, scope.customerId, scope.connectionId, targetId, prior.versionId);
    await db.batch([insert, advance]);
    const stored = await this.activeVersion(db, scope, targetId);
    if (stored?.versionId !== versionId) reject("CONCURRENT_WRITE");
    return stored;
  }

  public async revoke(scope: SustainabilityPersistenceScope, targetId: string, reason: string, actorId: string, nowMs = Date.now()): Promise<StoredSustainabilityTarget> {
    if (!TARGET.test(targetId) || !SAFE.test(reason) || !ID.test(actorId)
      || !Number.isSafeInteger(nowMs) || nowMs < 0) reject("INVALID_INPUT");
    const db = await this.live(scope);
    const prior = await this.activeVersion(db, scope, targetId);
    if (prior === null || prior.state === "REVOKED") reject("NOT_FOUND");
    const content = canonical({ schemaVersion: "sutra.sustainability-target-version.v1", targetId, scope, metric: prior.metric, workloadTagKey: prior.workloadTagKey, workloadTagValue: prior.workloadTagValue, periodStart: prior.periodStart, targetValueMicros: null, unit: prior.unit, state: "REVOKED", reason, actorId, priorVersionId: prior.versionId, createdAt: nowMs });
    const contentSha256 = await sha256(content);
    const versionId = `stgv_${contentSha256}`;
    await db.batch([
      db.prepare("INSERT INTO finops_sustainability_target_versions(version_id,target_id,org_id,customer_id,connection_id,metric,workload_tag_key,workload_tag_value,period_start,target_value_micros,unit,state,reason,actor_id,prior_version_id,content_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(versionId, targetId, scope.organizationId, scope.customerId, scope.connectionId, prior.metric, prior.workloadTagKey, prior.workloadTagValue, prior.periodStart, null, prior.unit, "REVOKED", reason, actorId, prior.versionId, contentSha256, nowMs),
      db.prepare("UPDATE finops_sustainability_target_heads SET active_version_id=?,advanced_at=? WHERE org_id=? AND customer_id=? AND connection_id=? AND target_id=? AND active_version_id=?").bind(versionId, nowMs, scope.organizationId, scope.customerId, scope.connectionId, targetId, prior.versionId),
    ]);
    const stored = await this.activeVersion(db, scope, targetId);
    if (stored?.versionId !== versionId) reject("CONCURRENT_WRITE");
    return stored;
  }
}
