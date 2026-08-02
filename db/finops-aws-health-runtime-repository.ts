/** Durable scope, replay, lease and configuration evidence for ADV-06. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  AwsHealthRepository,
  type AwsHealthPersistenceScope,
  type StoredAwsHealthSnapshot,
} from "./finops-aws-health-repository.ts";
import {
  normalizeAwsHealthOrganizationCapture,
  type AwsHealthOrganizationCapture,
  type AwsHealthOrganizationScope,
  type AwsHealthOrganizationSnapshot,
} from "../lib/finops-aws-health-organization.ts";
import type { AwsHealthAcceptedRuntimeAttempt, AwsHealthRuntimeFailureCode, AwsHealthRuntimeHandoff } from
  "../lib/finops-aws-health-runtime-binding.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const REQUEST = /^hrr_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const MAX_SCOPES = 10_000;
const MAX_ACCOUNTS = 200;
const LEASE_MS = 20 * 60 * 1_000;

interface ScopeRow { readonly org_id: string; readonly customer_id: string; readonly connection_id: string; readonly account_id: string; readonly partition: "aws" | "aws-us-gov"; }
interface TargetRow { readonly account_id: string; readonly connection_id: string; readonly permission_pack_version: string; }
interface AttemptRow { readonly request_id: string; readonly org_id: string; readonly customer_id: string; readonly connection_id: string; readonly scheduled_window: string; readonly state: "IN_PROGRESS" | "SUCCEEDED" | "FAILED"; readonly failure_code: AwsHealthRuntimeFailureCode | null; readonly generation_id: string | null; readonly lease_token: string; readonly lease_expires_at: number | string; readonly started_at: number | string; readonly completed_at: number | string | null; readonly updated_at: number | string; }
interface ConfigurationRow { readonly enabled_observed_since: string | null; }

export class AwsHealthRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "STORED_STATE_INVALID" | "BOUND_REACHED" | "ATTEMPT_IN_PROGRESS" | "LEASE_LOST";
  public constructor(code: AwsHealthRuntimeRepositoryError["code"]) {
    super("AWS Health durable runtime state rejected"); this.name = "AwsHealthRuntimeRepositoryError"; this.code = code;
  }
}
function reject(code: AwsHealthRuntimeRepositoryError["code"]): never { throw new AwsHealthRuntimeRepositoryError(code); }
function integer(value: number | string): number { const result = typeof value === "string" ? Number(value) : value; if (!Number.isSafeInteger(result) || result < 0) reject("STORED_STATE_INVALID"); return result; }
function validScope(scope: AwsHealthPersistenceScope): boolean { return IDENTIFIER.test(scope.organizationId) && IDENTIFIER.test(scope.customerId) && CONNECTION.test(scope.connectionId); }
function validWindow(value: string): boolean { return WINDOW.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
async function token(): Promise<string> { const bytes = new TextEncoder().encode(crypto.randomUUID()); const hash = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join(""); }

const LIVE = `FROM aws_connections c JOIN organizations o ON o.id=c.org_id AND o.status='active' JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial') WHERE c.source_kind='aws_trust_role' AND c.status='active' AND c.partition IN ('aws','aws-us-gov') AND c.permission_pack_version IN ('standard-2026-08.8','standard-2026-08.9')`;

export interface AwsHealthProviderContext {
  readonly candidateAccounts: readonly { readonly accountId: string; readonly connectionId: string }[];
  readonly enabledObservedSince: string | null;
}
export interface AwsHealthRuntimeStatus {
  readonly state: "unavailable" | "collecting" | "failed" | "ready";
  readonly reason: string;
  readonly lastAttemptAt: string | null;
}

export class AwsHealthRuntimeRepository implements AwsHealthRuntimeHandoff {
  private readonly snapshots: AwsHealthRepository;
  private readonly leases = new Map<string, string>();
  private readonly now: () => number;
  private readonly skipRuntimeSchema: boolean;
  public constructor(private readonly database: D1Database = getRawDb(), options: { readonly now?: () => number; readonly skipRuntimeSchema?: boolean } = {}) { this.snapshots = new AwsHealthRepository(database); this.now = options.now ?? Date.now; this.skipRuntimeSchema = options.skipRuntimeSchema ?? false; }
  private async ready() { if (!this.skipRuntimeSchema) await ensureRuntimeSchema(this.database); return this.database; }
  private clock(): number { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_INPUT"); return value; }

  public async listEligibleScopes(limit = MAX_SCOPES): Promise<readonly AwsHealthPersistenceScope[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCOPES) reject("INVALID_INPUT");
    const rows = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,c.partition ${LIVE} ORDER BY c.id ASC LIMIT ?`).bind(limit + 1).all<ScopeRow>();
    if ((rows.results ?? []).length > limit) reject("BOUND_REACHED");
    return (rows.results ?? []).map((row) => ({ organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id }));
  }

  public async loadScope(scope: AwsHealthPersistenceScope): Promise<AwsHealthOrganizationScope> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const row = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,c.partition ${LIVE} AND c.org_id=? AND c.customer_id=? AND c.id=? LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<ScopeRow>();
    if (row === null || !/^\d{12}$/u.test(row.account_id) || !["aws", "aws-us-gov"].includes(row.partition)) reject(row === null ? "SCOPE_NOT_FOUND" : "STORED_STATE_INVALID");
    return Object.freeze({ orgId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id, accountId: row.account_id, partition: row.partition, endpointRegion: row.partition === "aws" ? "us-east-1" : "us-gov-west-1" });
  }

  public async loadProviderContext(scope: AwsHealthPersistenceScope): Promise<AwsHealthProviderContext> {
    const trusted = await this.loadScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(`SELECT c.aws_account_id AS account_id,c.id AS connection_id,c.permission_pack_version ${LIVE} AND c.org_id=? AND c.customer_id=? AND c.partition=? ORDER BY c.aws_account_id ASC,c.id ASC LIMIT ?`).bind(scope.organizationId, scope.customerId, trusted.partition, MAX_ACCOUNTS + 1).all<TargetRow>();
    const values = rows.results ?? [];
    if (values.length < 1 || values.length > MAX_ACCOUNTS) reject(values.length < 1 ? "SCOPE_NOT_FOUND" : "BOUND_REACHED");
    const accounts = new Set<string>(); const connections = new Set<string>();
    const candidateAccounts = values.map((row) => {
      if (!/^\d{12}$/u.test(row.account_id) || !CONNECTION.test(row.connection_id)
        || (row.permission_pack_version !== "standard-2026-08.8"
          && row.permission_pack_version !== "standard-2026-08.9")
        || accounts.has(row.account_id) || connections.has(row.connection_id)) reject("STORED_STATE_INVALID");
      accounts.add(row.account_id); connections.add(row.connection_id); return Object.freeze({ accountId: row.account_id, connectionId: row.connection_id });
    });
    if (!candidateAccounts.some((target) => target.accountId === trusted.accountId && target.connectionId === trusted.connectionId)) reject("STORED_STATE_INVALID");
    const configuration = await db.prepare(`SELECT enabled_observed_since FROM finops_aws_health_runtime_configuration WHERE org_id=? AND customer_id=? AND connection_id=? LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<ConfigurationRow>();
    if (configuration?.enabled_observed_since !== null && configuration?.enabled_observed_since !== undefined && !Number.isFinite(Date.parse(configuration.enabled_observed_since))) reject("STORED_STATE_INVALID");
    return Object.freeze({ candidateAccounts, enabledObservedSince: configuration?.enabled_observed_since ?? null });
  }

  private accepted(scope: AwsHealthPersistenceScope, requestId: string, scheduledWindow: string, snapshot: StoredAwsHealthSnapshot): AwsHealthAcceptedRuntimeAttempt {
    return Object.freeze({ scope, requestId, scheduledWindow, snapshot });
  }

  private async repairOrphan(scope: AwsHealthPersistenceScope, requestId: string, scheduledWindow: string, now: number): Promise<AwsHealthAcceptedRuntimeAttempt | null> {
    const snapshot = await this.snapshots.getSnapshotByCaptureId(scope, `health_${requestId.slice(4)}`);
    if (snapshot === null) return null;
    await (await this.ready()).prepare(`UPDATE finops_aws_health_runtime_attempts SET state='SUCCEEDED',failure_code=NULL,generation_id=?,completed_at=?,updated_at=? WHERE request_id=? AND org_id=? AND customer_id=? AND connection_id=? AND state<>'SUCCEEDED'`).bind(snapshot.generationId, now, now, requestId, scope.organizationId, scope.customerId, scope.connectionId).run();
    await this.recordConfiguration(scope, snapshot.snapshot, now);
    return this.accepted(scope, requestId, scheduledWindow, snapshot);
  }

  /** Atomic lease acquisition plus replay read; active leases fail closed. */
  public async getAccepted(scope: AwsHealthPersistenceScope, requestId: string): Promise<AwsHealthAcceptedRuntimeAttempt | null> {
    if (!validScope(scope) || !REQUEST.test(requestId)) reject("INVALID_INPUT");
    const db = await this.ready(); const now = this.clock(); const lease = await token();
    const existing = await db.prepare(`SELECT * FROM finops_aws_health_runtime_attempts WHERE request_id=? AND org_id=? AND customer_id=? AND connection_id=? LIMIT 1`).bind(requestId, scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (existing !== null) {
      if (!validWindow(existing.scheduled_window)) reject("STORED_STATE_INVALID");
      if (existing.state === "SUCCEEDED") {
        if (existing.generation_id === null) reject("STORED_STATE_INVALID");
        const snapshot = await this.snapshots.getSnapshotByGeneration(scope, existing.generation_id); if (snapshot === null) reject("STORED_STATE_INVALID");
        return this.accepted(scope, requestId, existing.scheduled_window, snapshot);
      }
      const orphan = await this.repairOrphan(scope, requestId, existing.scheduled_window, now); if (orphan !== null) return orphan;
      if (existing.state === "IN_PROGRESS" && integer(existing.lease_expires_at) > now) reject("ATTEMPT_IN_PROGRESS");
      await db.prepare(`UPDATE finops_aws_health_runtime_attempts SET state='IN_PROGRESS',failure_code=NULL,generation_id=NULL,lease_token=?,lease_expires_at=?,completed_at=NULL,updated_at=? WHERE request_id=? AND state<>'SUCCEEDED' AND (state='FAILED' OR lease_expires_at<=?)`).bind(lease, now + LEASE_MS, now, requestId, now).run();
    } else {
      reject("STORED_STATE_INVALID");
    }
    const claimed = await db.prepare(`SELECT * FROM finops_aws_health_runtime_attempts WHERE request_id=? LIMIT 1`).bind(requestId).first<AttemptRow>();
    if (claimed === null || claimed.lease_token !== lease || claimed.state !== "IN_PROGRESS") reject("LEASE_LOST");
    this.leases.set(requestId, lease); return null;
  }

  /** Creates the deterministic request row before getAccepted is called. */
  public async prepareAttempt(scope: AwsHealthPersistenceScope, requestId: string, scheduledWindow: string): Promise<void> {
    if (!validScope(scope) || !REQUEST.test(requestId) || !validWindow(scheduledWindow)) reject("INVALID_INPUT");
    const now = this.clock(); const lease = await token();
    await (await this.ready()).prepare(`INSERT INTO finops_aws_health_runtime_attempts(request_id,org_id,customer_id,connection_id,scheduled_window,state,failure_code,generation_id,lease_token,lease_expires_at,started_at,completed_at,updated_at) VALUES(?,?,?,?,?,'FAILED','ADAPTER_UNAVAILABLE',NULL,?,?,?, ?,?) ON CONFLICT(request_id) DO NOTHING`).bind(requestId, scope.organizationId, scope.customerId, scope.connectionId, scheduledWindow, lease, now, now, now, now).run();
  }

  private async recordConfiguration(scope: AwsHealthPersistenceScope, snapshot: AwsHealthOrganizationSnapshot, now: number): Promise<void> {
    const enabledSince = snapshot.prerequisites.organizationViewStatus === "ENABLED" ? snapshot.observedAtIso : null;
    await (await this.ready()).prepare(`INSERT INTO finops_aws_health_runtime_configuration(org_id,customer_id,connection_id,last_organization_view_status,enabled_observed_since,last_verified_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(org_id,customer_id,connection_id) DO UPDATE SET last_organization_view_status=excluded.last_organization_view_status,enabled_observed_since=CASE WHEN excluded.last_organization_view_status='ENABLED' THEN COALESCE(finops_aws_health_runtime_configuration.enabled_observed_since,excluded.enabled_observed_since) ELSE NULL END,last_verified_at=excluded.last_verified_at,updated_at=excluded.updated_at`).bind(scope.organizationId, scope.customerId, scope.connectionId, snapshot.prerequisites.organizationViewStatus, enabledSince, snapshot.observedAtIso, now).run();
  }

  public async commit(input: { readonly scope: AwsHealthPersistenceScope; readonly trustedScope: AwsHealthOrganizationScope; readonly requestId: string; readonly scheduledWindow: string; readonly capture: AwsHealthOrganizationCapture; readonly normalizedSnapshot: AwsHealthOrganizationSnapshot; readonly completedAtMs: number; }): Promise<{ readonly accepted: AwsHealthAcceptedRuntimeAttempt; readonly becameActive: boolean }> {
    const lease = this.leases.get(input.requestId); if (lease === undefined) reject("LEASE_LOST");
    const normalized = normalizeAwsHealthOrganizationCapture(input.capture, input.trustedScope, input.completedAtMs);
    if (JSON.stringify(normalized) !== JSON.stringify(input.normalizedSnapshot)) reject("INVALID_INPUT");
    const current = await (await this.ready()).prepare(`SELECT * FROM finops_aws_health_runtime_attempts WHERE request_id=? LIMIT 1`).bind(input.requestId).first<AttemptRow>();
    if (current === null || current.state !== "IN_PROGRESS" || current.lease_token !== lease || integer(current.lease_expires_at) < input.completedAtMs || current.scheduled_window !== input.scheduledWindow) reject("LEASE_LOST");
    const stored = await this.snapshots.recordCapture(input.scope, input.trustedScope, input.capture, input.completedAtMs);
    const result = await (await this.ready()).prepare(`UPDATE finops_aws_health_runtime_attempts SET state='SUCCEEDED',generation_id=?,completed_at=?,updated_at=? WHERE request_id=? AND state='IN_PROGRESS' AND lease_token=? AND lease_expires_at>=?`).bind(stored.snapshot.generationId, input.completedAtMs, input.completedAtMs, input.requestId, lease, input.completedAtMs).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
    await this.recordConfiguration(input.scope, stored.snapshot.snapshot, input.completedAtMs); this.leases.delete(input.requestId);
    return { accepted: this.accepted(input.scope, input.requestId, input.scheduledWindow, stored.snapshot), becameActive: stored.becameActive };
  }

  public async recordFailure(input: { readonly scope: AwsHealthPersistenceScope; readonly requestId: string; readonly scheduledWindow: string; readonly code: AwsHealthRuntimeFailureCode; readonly completedAtMs: number; }): Promise<void> {
    const lease = this.leases.get(input.requestId); if (lease === undefined) reject("LEASE_LOST");
    const result = await (await this.ready()).prepare(`UPDATE finops_aws_health_runtime_attempts SET state='FAILED',failure_code=?,completed_at=?,updated_at=? WHERE request_id=? AND scheduled_window=? AND state='IN_PROGRESS' AND lease_token=?`).bind(input.code, input.completedAtMs, input.completedAtMs, input.requestId, input.scheduledWindow, lease).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST"); this.leases.delete(input.requestId);
  }

  public async getRuntimeStatus(scope: AwsHealthPersistenceScope): Promise<AwsHealthRuntimeStatus> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const row = await (await this.ready()).prepare(`SELECT * FROM finops_aws_health_runtime_attempts WHERE org_id=? AND customer_id=? AND connection_id=? ORDER BY updated_at DESC,request_id DESC LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (row === null) return { state: "unavailable", reason: "AWS_HEALTH_COLLECTION_NOT_STARTED", lastAttemptAt: null };
    const at = new Date(integer(row.updated_at)).toISOString();
    if (row.state === "IN_PROGRESS") {
      return integer(row.lease_expires_at) <= this.clock()
        ? { state: "failed", reason: "AWS_HEALTH_COLLECTION_LEASE_EXPIRED", lastAttemptAt: at }
        : { state: "collecting", reason: "AWS_HEALTH_COLLECTION_IN_PROGRESS", lastAttemptAt: at };
    }
    if (row.state === "FAILED") return { state: "failed", reason: row.failure_code ?? "AWS_HEALTH_COLLECTION_FAILED", lastAttemptAt: at };
    if (row.generation_id === null) reject("STORED_STATE_INVALID");
    const snapshot = await this.snapshots.getSnapshotByGeneration(scope, row.generation_id);
    if (snapshot === null) reject("STORED_STATE_INVALID");
    if (snapshot.snapshot.collectionState === "complete") {
      return { state: "ready", reason: "AWS_HEALTH_COLLECTION_READY", lastAttemptAt: at };
    }
    return {
      state: "unavailable",
      reason: snapshot.snapshot.collectionState === "unavailable"
        ? "AWS_HEALTH_CONFIGURATION_UNAVAILABLE"
        : "AWS_HEALTH_COMPLETE_HISTORY_NOT_YET_ACCEPTED",
      lastAttemptAt: at,
    };
  }
}
