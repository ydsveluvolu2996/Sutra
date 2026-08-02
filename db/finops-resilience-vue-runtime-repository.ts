/** Trusted scope catalog and crash-safe replay ledger for ADV-10 ResilienceVue. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  ResilienceVueRepository,
  type ResilienceVuePersistenceScope,
  type StoredResilienceVueSnapshot,
} from "./finops-resilience-vue-repository.ts";
import {
  normalizeResilienceVueCapture,
  type ResilienceVueScope,
} from "../lib/finops-resilience-vue.ts";
import type {
  ResilienceVueAcceptedRuntimeAttempt,
  ResilienceVueImmutableEvidenceHandoff,
  ResilienceVueRuntimeFailureCode,
} from "../lib/finops-resilience-vue-runtime-binding.ts";
import type { ResilienceVueCollectorTarget } from "../lib/finops-resilience-vue-job.ts";
import { RESILIENCE_VUE_RUNTIME_PERMISSION_PACK_SQL } from
  "../lib/finops-permission-pack-successors.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const REQUEST = /^rvr_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const SHA = /^[a-f0-9]{64}$/u;
const MAX_SCOPES = 10_000;
const MAX_REGIONS = 50;
const LEASE_MS = 20 * 60 * 1_000;

interface ScopeRow {
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly account_id: string;
  readonly partition: ResilienceVueScope["partition"];
  readonly enabled_regions_json: string;
}

interface AttemptRow {
  readonly request_id: string;
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly account_id: string;
  readonly partition: ResilienceVueScope["partition"];
  readonly region: string;
  readonly scheduled_window: string;
  readonly state: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  readonly failure_code: ResilienceVueRuntimeFailureCode | null;
  readonly generation_id: string | null;
  readonly evidence_generation_id: string | null;
  readonly evidence_object_id: string | null;
  readonly evidence_content_sha256: string | null;
  readonly evidence_reference_ciphertext: string | null;
  readonly evidence_reference_key_version: string | null;
  readonly lease_token_sha256: string;
  readonly lease_expires_at: number | string;
  readonly started_at: number | string;
  readonly completed_at: number | string | null;
  readonly updated_at: number | string;
}

export interface ResilienceVueRuntimeStatus {
  readonly state: "unavailable" | "collecting" | "failed" | "ready";
  readonly reason: string;
  readonly lastAttemptAt: string | null;
}

export class ResilienceVueRuntimeRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "STORED_STATE_INVALID"
    | "BOUND_REACHED" | "ATTEMPT_IN_PROGRESS" | "LEASE_LOST";
  public constructor(code: ResilienceVueRuntimeRepositoryError["code"]) {
    super("ResilienceVue durable runtime state rejected");
    this.name = "ResilienceVueRuntimeRepositoryError";
    this.code = code;
  }
}

function reject(code: ResilienceVueRuntimeRepositoryError["code"]): never {
  throw new ResilienceVueRuntimeRepositoryError(code);
}
function integer(value: number | string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}
function validScope(scope: ResilienceVuePersistenceScope): boolean {
  return IDENTIFIER.test(scope.organizationId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}
function validWindow(value: string): boolean {
  return WINDOW.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}
function sameTarget(left: ResilienceVueScope, right: ResilienceVueScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition && left.region === right.region;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function leaseToken(): Promise<string> {
  return sha256(crypto.randomUUID());
}

const LIVE = `FROM aws_connections c
  JOIN organizations o ON o.id=c.org_id AND o.status='active'
  JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial')
  WHERE c.source_kind='aws_trust_role' AND c.status='active'
    AND c.permission_pack_version IN (${RESILIENCE_VUE_RUNTIME_PERMISSION_PACK_SQL})`;

export class ResilienceVueRuntimeRepository implements ResilienceVueImmutableEvidenceHandoff {
  private readonly snapshots: ResilienceVueRepository;
  private readonly leases = new Map<string, string>();
  private readonly now: () => number;
  private readonly skipRuntimeSchema: boolean;
  public constructor(private readonly database: D1Database = getRawDb(), options: {
    readonly now?: () => number;
    readonly skipRuntimeSchema?: boolean;
  } = {}) {
    this.snapshots = new ResilienceVueRepository(database);
    this.now = options.now ?? Date.now;
    this.skipRuntimeSchema = options.skipRuntimeSchema ?? false;
  }
  private async ready(): Promise<D1Database> {
    if (!this.skipRuntimeSchema) await ensureRuntimeSchema(this.database);
    return this.database;
  }
  private clock(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_INPUT");
    return value;
  }

  public async listEligibleScopes(limit = MAX_SCOPES): Promise<readonly ResilienceVuePersistenceScope[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCOPES) reject("INVALID_INPUT");
    const rows = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,
      c.aws_account_id AS account_id,c.partition,c.enabled_regions_json ${LIVE}
      ORDER BY c.id ASC LIMIT ?`).bind(limit + 1).all<ScopeRow>();
    const values = rows.results ?? [];
    if (values.length > limit) reject("BOUND_REACHED");
    return values.map((row) => Object.freeze({
      organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id,
    }));
  }

  private materializeScope(row: ScopeRow): ResilienceVueScope {
    if (!IDENTIFIER.test(row.org_id) || !IDENTIFIER.test(row.customer_id)
      || !CONNECTION.test(row.connection_id) || !ACCOUNT.test(row.account_id)
      || !["aws", "aws-cn", "aws-us-gov"].includes(row.partition)) reject("STORED_STATE_INVALID");
    return Object.freeze({ orgId: row.org_id, customerId: row.customer_id,
      connectionId: row.connection_id, accountId: row.account_id,
      partition: row.partition, region: "us-east-1" });
  }

  private async scopeRow(scope: ResilienceVuePersistenceScope): Promise<ScopeRow> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const row = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,
      c.aws_account_id AS account_id,c.partition,c.enabled_regions_json ${LIVE}
      AND c.org_id=? AND c.customer_id=? AND c.id=? LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<ScopeRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    this.materializeScope(row);
    return row;
  }

  public async loadScope(scope: ResilienceVuePersistenceScope): Promise<ResilienceVuePersistenceScope> {
    await this.scopeRow(scope);
    return Object.freeze({ ...scope });
  }

  public async listTargets(scope: ResilienceVuePersistenceScope): Promise<readonly ResilienceVueCollectorTarget[]> {
    const row = await this.scopeRow(scope);
    let regions: unknown;
    try { regions = JSON.parse(row.enabled_regions_json); } catch { reject("STORED_STATE_INVALID"); }
    if (!Array.isArray(regions) || regions.length > MAX_REGIONS) reject("BOUND_REACHED");
    const unique = [...new Set(regions)];
    if (unique.length !== regions.length || unique.some((region) => typeof region !== "string" || !REGION.test(region))) {
      reject("STORED_STATE_INVALID");
    }
    const ordered = (unique as string[]).sort();
    const targets: ResilienceVueCollectorTarget[] = [];
    for (const region of ordered) {
      const active = await this.snapshots.getActiveSnapshotForTarget(scope, row.account_id, row.partition, region);
      targets.push(Object.freeze({ orgId: row.org_id, customerId: row.customer_id,
        connectionId: row.connection_id, accountId: row.account_id, partition: row.partition,
        region, lastAcceptedCompletedAtIso: active?.snapshot.completedAtIso ?? null }));
    }
    return Object.freeze(targets);
  }

  private accepted(row: AttemptRow, snapshot: StoredResilienceVueSnapshot): ResilienceVueAcceptedRuntimeAttempt {
    if (row.state !== "SUCCEEDED" || row.generation_id !== snapshot.generationId
      || row.evidence_generation_id === null || row.evidence_object_id === null
      || row.evidence_content_sha256 === null || !SHA.test(row.evidence_content_sha256)
      || row.evidence_reference_ciphertext === null || row.evidence_reference_key_version === null) {
      reject("STORED_STATE_INVALID");
    }
    return Object.freeze({ requestId: row.request_id, scheduledWindow: row.scheduled_window, snapshot,
      evidence: Object.freeze({ generationId: row.evidence_generation_id,
        objectId: row.evidence_object_id, contentSha256: row.evidence_content_sha256,
        reference: Object.freeze({ ciphertext: row.evidence_reference_ciphertext,
          keyVersion: row.evidence_reference_key_version }) }) });
  }

  public async getAccepted(scope: ResilienceVuePersistenceScope, target: ResilienceVueScope,
    requestId: string): Promise<ResilienceVueAcceptedRuntimeAttempt | null> {
    if (!validScope(scope) || !REQUEST.test(requestId) || target.orgId !== scope.organizationId
      || target.customerId !== scope.customerId || target.connectionId !== scope.connectionId
      || !ACCOUNT.test(target.accountId) || !REGION.test(target.region)) reject("INVALID_INPUT");
    const trustedTargets = await this.listTargets(scope);
    if (!trustedTargets.some((candidate) => sameTarget(candidate, target))) reject("SCOPE_NOT_FOUND");
    const database = await this.ready();
    const existing = await database.prepare(`SELECT * FROM finops_resilience_vue_runtime_attempts
      WHERE request_id=? AND org_id=? AND customer_id=? AND connection_id=? LIMIT 1`)
      .bind(requestId, scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (existing?.state === "SUCCEEDED") {
      if (existing.generation_id === null) reject("STORED_STATE_INVALID");
      const snapshot = await this.snapshots.getSnapshotByGeneration(scope, existing.generation_id);
      if (snapshot === null) reject("STORED_STATE_INVALID");
      return this.accepted(existing, snapshot);
    }
    const now = this.clock();
    if (existing?.state === "IN_PROGRESS" && integer(existing.lease_expires_at) > now) {
      reject("ATTEMPT_IN_PROGRESS");
    }
    const lease = await leaseToken();
    const window = existing?.scheduled_window;
    if (window === undefined || !validWindow(window)) reject("STORED_STATE_INVALID");
    const changed = await database.prepare(`UPDATE finops_resilience_vue_runtime_attempts
      SET state='IN_PROGRESS',failure_code=NULL,generation_id=NULL,evidence_generation_id=NULL,
        evidence_object_id=NULL,evidence_content_sha256=NULL,evidence_reference_ciphertext=NULL,
        evidence_reference_key_version=NULL,lease_token_sha256=?,lease_expires_at=?,completed_at=NULL,updated_at=?
      WHERE request_id=? AND state<>'SUCCEEDED' AND (state='FAILED' OR lease_expires_at<=?)`)
      .bind(lease, now + LEASE_MS, now, requestId, now).run();
    if ((changed.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
    this.leases.set(requestId, lease);
    return null;
  }

  /** Creates the deterministic lease row before the runtime checks replay state. */
  public async prepareAttempt(scope: ResilienceVuePersistenceScope, target: ResilienceVueScope,
    requestId: string, scheduledWindow: string): Promise<void> {
    if (!validScope(scope) || !REQUEST.test(requestId) || !validWindow(scheduledWindow)
      || target.orgId !== scope.organizationId || target.customerId !== scope.customerId
      || target.connectionId !== scope.connectionId || !ACCOUNT.test(target.accountId)
      || !REGION.test(target.region)) reject("INVALID_INPUT");
    const trustedTargets = await this.listTargets(scope);
    if (!trustedTargets.some((candidate) => sameTarget(candidate, target))) reject("SCOPE_NOT_FOUND");
    const now = this.clock();
    const lease = await leaseToken();
    await (await this.ready()).prepare(`INSERT INTO finops_resilience_vue_runtime_attempts
      (request_id,org_id,customer_id,connection_id,account_id,partition,region,scheduled_window,state,
       failure_code,generation_id,evidence_generation_id,evidence_object_id,evidence_content_sha256,
       evidence_reference_ciphertext,evidence_reference_key_version,lease_token_sha256,lease_expires_at,
       started_at,completed_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'FAILED','ADAPTER_UNAVAILABLE',NULL,NULL,NULL,NULL,NULL,NULL,?,?,?, ?,?)
      ON CONFLICT(request_id) DO NOTHING`).bind(requestId, scope.organizationId, scope.customerId,
      scope.connectionId, target.accountId, target.partition, target.region, scheduledWindow,
      lease, now, now, now, now).run();
  }

  public async commit(input: Parameters<ResilienceVueImmutableEvidenceHandoff["commit"]>[0]):
    Promise<{ readonly accepted: ResilienceVueAcceptedRuntimeAttempt; readonly becameActive: boolean }> {
    const lease = this.leases.get(input.requestId);
    if (lease === undefined) reject("LEASE_LOST");
    const normalized = normalizeResilienceVueCapture(input.capture, input.target, input.nowMs);
    if (JSON.stringify(normalized) !== JSON.stringify(input.normalizedSnapshot)) reject("INVALID_INPUT");
    const current = await (await this.ready()).prepare(`SELECT * FROM finops_resilience_vue_runtime_attempts
      WHERE request_id=? LIMIT 1`).bind(input.requestId).first<AttemptRow>();
    if (current === null || current.state !== "IN_PROGRESS" || current.lease_token_sha256 !== lease
      || integer(current.lease_expires_at) < input.nowMs || current.scheduled_window !== input.scheduledWindow) {
      reject("LEASE_LOST");
    }
    const stored = await this.snapshots.recordCapture(input.scope, input.target, input.capture, input.nowMs);
    const result = await (await this.ready()).prepare(`UPDATE finops_resilience_vue_runtime_attempts SET
      state='SUCCEEDED',failure_code=NULL,generation_id=?,evidence_generation_id=?,evidence_object_id=?,
      evidence_content_sha256=?,evidence_reference_ciphertext=?,evidence_reference_key_version=?,
      completed_at=?,updated_at=? WHERE request_id=? AND state='IN_PROGRESS'
        AND lease_token_sha256=? AND lease_expires_at>=?`).bind(stored.snapshot.generationId,
      input.evidence.generationId, input.evidence.objectId, input.evidence.contentSha256,
      input.evidence.reference.ciphertext, input.evidence.reference.keyVersion, input.nowMs,
      input.nowMs, input.requestId, lease, input.nowMs).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
    this.leases.delete(input.requestId);
    const acceptedRow = await (await this.ready()).prepare(`SELECT * FROM finops_resilience_vue_runtime_attempts
      WHERE request_id=? LIMIT 1`).bind(input.requestId).first<AttemptRow>();
    if (acceptedRow === null) reject("STORED_STATE_INVALID");
    return Object.freeze({ accepted: this.accepted(acceptedRow, stored.snapshot), becameActive: stored.becameActive });
  }

  public async recordFailure(input: Parameters<ResilienceVueImmutableEvidenceHandoff["recordFailure"]>[0]): Promise<void> {
    const lease = this.leases.get(input.requestId);
    if (lease === undefined) reject("LEASE_LOST");
    const result = await (await this.ready()).prepare(`UPDATE finops_resilience_vue_runtime_attempts SET
      state='FAILED',failure_code=?,completed_at=?,updated_at=? WHERE request_id=? AND scheduled_window=?
      AND state='IN_PROGRESS' AND lease_token_sha256=?`).bind(input.code, input.completedAtMs,
      input.completedAtMs, input.requestId, input.scheduledWindow, lease).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
    this.leases.delete(input.requestId);
  }

  public async getRuntimeStatus(scope: ResilienceVuePersistenceScope): Promise<ResilienceVueRuntimeStatus> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    await this.scopeRow(scope);
    const row = await (await this.ready()).prepare(`SELECT * FROM finops_resilience_vue_runtime_attempts
      WHERE org_id=? AND customer_id=? AND connection_id=? ORDER BY updated_at DESC,request_id DESC LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (row === null) return Object.freeze({ state: "unavailable", reason: "RESILIENCE_VUE_COLLECTION_NOT_STARTED", lastAttemptAt: null });
    const at = new Date(integer(row.updated_at)).toISOString();
    if (row.state === "IN_PROGRESS") return integer(row.lease_expires_at) > this.clock()
      ? Object.freeze({ state: "collecting", reason: "RESILIENCE_VUE_COLLECTION_IN_PROGRESS", lastAttemptAt: at })
      : Object.freeze({ state: "failed", reason: "RESILIENCE_VUE_COLLECTION_LEASE_EXPIRED", lastAttemptAt: at });
    if (row.state === "FAILED") return Object.freeze({ state: "failed", reason: row.failure_code ?? "RESILIENCE_VUE_COLLECTION_FAILED", lastAttemptAt: at });
    if (row.generation_id === null) reject("STORED_STATE_INVALID");
    const snapshot = await this.snapshots.getSnapshotByGeneration(scope, row.generation_id);
    if (snapshot === null) reject("STORED_STATE_INVALID");
    return snapshot.snapshot.complete
      ? Object.freeze({ state: "ready", reason: "RESILIENCE_VUE_COLLECTION_READY", lastAttemptAt: at })
      : Object.freeze({ state: "unavailable", reason: snapshot.snapshot.state === "configuration_required"
        ? "RESILIENCE_VUE_CONFIGURATION_REQUIRED" : "RESILIENCE_VUE_COMPLETE_HEAD_NOT_ACCEPTED", lastAttemptAt: at });
  }
}
