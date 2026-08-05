/** Trusted DCF module inventory, durable leases, replay receipts, and UI state. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { DcfRepository, type DcfPersistenceScope } from "./finops-dcf-repository.ts";
import {
  DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND,
  dcfStepFunctionsIdempotencyKey,
  type DcfStepFunctionsReplayClaim,
  type DcfStepFunctionsReplayStore,
  type DcfStepFunctionsRuntimeResult,
  type DcfStepFunctionsRuntimeScope,
} from "../lib/finops-dcf-durable-runtime-binding.ts";
import type {
  DcfCapture,
  DcfScope,
} from "../lib/finops-dcf-execution-history.ts";
import type {
  DcfStepFunctionsBoundary,
  DcfStepFunctionsModuleBinding,
} from "../lib/finops-dcf-step-functions-adapter.ts";
import { DCF_RUNTIME_PERMISSION_PACK_SQL, isDcfRuntimePermissionPack } from
  "../lib/finops-permission-pack-successors.ts";

export const DCF_REQUIRED_PERMISSION_PACK = "standard-2026-08.10" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const MAXIMUM_SCOPES = 10_000;
const MAXIMUM_MODULES = 500;

interface ConnectionRow {
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly account_id: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly permission_pack_version: string;
}
interface ModuleRow {
  readonly module_id: string;
  readonly module_name: string;
  readonly source_id: string | null;
  readonly region: string;
  readonly state_machine_arn: string;
  readonly enabled: number | boolean;
  readonly expected_cadence_minutes: number | string;
}
interface AttemptRow {
  readonly idempotency_key: string;
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly job_id: string;
  readonly scheduled_window: string;
  readonly state: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  readonly lease_token: string;
  readonly lease_expires_at: number | string;
  readonly result_json: string | null;
  readonly result_sha256: string | null;
  readonly failure_code: string | null;
  readonly updated_at: number | string;
}

export interface DcfRuntimeStatus {
  readonly state: "unavailable" | "collecting" | "failed" | "ready";
  readonly reason: string;
  readonly sourceState: DcfStepFunctionsRuntimeResult["sourceState"] | null;
  readonly lastAttemptAt: string | null;
}

export class DcfRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "STORED_STATE_INVALID" | "BOUND_REACHED" | "LEASE_LOST";
  public constructor(code: DcfRuntimeRepositoryError["code"]) {
    super("Data Collection Monitor durable runtime state was rejected");
    this.name = "DcfRuntimeRepositoryError";
    this.code = code;
  }
}

function reject(code: DcfRuntimeRepositoryError["code"]): never {
  throw new DcfRuntimeRepositoryError(code);
}
function integer(value: number | string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}
function validScope(scope: DcfStepFunctionsRuntimeScope): boolean {
  return IDENTIFIER.test(scope.organizationId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}
function canonicalWindow(value: string): boolean {
  return WINDOW.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}
function exactResult(value: unknown): value is DcfStepFunctionsRuntimeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(result).sort()) === JSON.stringify([
    "becameActive", "captureId", "contentSha256", "failureCodes",
    "generationId", "schemaVersion", "sourceState",
  ])
    && result.schemaVersion === "sutra.dcf-step-functions-runtime-result.v1"
    && typeof result.generationId === "string" && /^dcg_[a-f0-9]{64}$/u.test(result.generationId)
    && typeof result.contentSha256 === "string" && SHA256.test(result.contentSha256)
    && result.generationId === `dcg_${result.contentSha256}`
    && typeof result.captureId === "string" && /^dcf_[a-f0-9]{64}$/u.test(result.captureId)
    && new Set(["READY", "PARTIAL", "STALE", "UNAVAILABLE"]).has(String(result.sourceState))
    && Array.isArray(result.failureCodes) && typeof result.becameActive === "boolean";
}
async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
async function leaseToken(): Promise<string> {
  return digest(crypto.randomUUID());
}
function parseKey(key: string): { readonly scope: DcfStepFunctionsRuntimeScope; readonly scheduledWindow: string } {
  const parts = key.split(":");
  if (parts.length !== 5 || parts[0] !== "dcf-step-functions") reject("INVALID_INPUT");
  let organizationId: string, customerId: string, connectionId: string, scheduledWindow: string;
  try {
    organizationId = decodeURIComponent(parts[1]!);
    customerId = decodeURIComponent(parts[2]!);
    connectionId = decodeURIComponent(parts[3]!);
    scheduledWindow = decodeURIComponent(parts[4]!);
  } catch { return reject("INVALID_INPUT"); }
  const scope = { organizationId, customerId, connectionId };
  if (!validScope(scope) || !canonicalWindow(scheduledWindow)
    || dcfStepFunctionsIdempotencyKey(scope, scheduledWindow) !== key) reject("INVALID_INPUT");
  return { scope, scheduledWindow };
}

const LIVE_CONNECTION = `FROM aws_connections c
  JOIN organizations o ON o.id=c.org_id AND o.status='active'
  JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial')
  WHERE c.source_kind='aws_trust_role' AND c.status='active'
    AND c.permission_pack_version IN (${DCF_RUNTIME_PERMISSION_PACK_SQL})`;

export class DcfRuntimeRepository implements DcfStepFunctionsReplayStore {
  private readonly snapshots: DcfRepository;
  private readonly now: () => number;
  private readonly skipRuntimeSchema: boolean;
  public constructor(
    private readonly database: D1Database = getRawDb(),
    options: { readonly now?: () => number; readonly skipRuntimeSchema?: boolean } = {},
  ) {
    this.snapshots = new DcfRepository(database);
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

  public async listEligibleScopes(limit = MAXIMUM_SCOPES): Promise<readonly DcfStepFunctionsRuntimeScope[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_SCOPES) reject("INVALID_INPUT");
    const rows = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,
      c.aws_account_id AS account_id,c.partition,c.permission_pack_version ${LIVE_CONNECTION}
      AND EXISTS (SELECT 1 FROM finops_dcf_module_bindings b WHERE b.org_id=c.org_id
        AND b.customer_id=c.customer_id AND b.connection_id=c.id AND b.enabled=1)
      ORDER BY c.id ASC LIMIT ?`).bind(limit + 1).all<ConnectionRow>();
    const values = rows.results ?? [];
    if (values.length > limit) reject("BOUND_REACHED");
    return values.map((row) => {
      const scope = { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id };
      if (!validScope(scope) || !/^\d{12}$/u.test(row.account_id)
        || !new Set(["aws", "aws-us-gov", "aws-cn"]).has(row.partition)
        || !isDcfRuntimePermissionPack(row.permission_pack_version)) reject("STORED_STATE_INVALID");
      return Object.freeze(scope);
    });
  }

  public async loadBoundary(scope: DcfStepFunctionsRuntimeScope): Promise<DcfStepFunctionsBoundary> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const db = await this.ready();
    const connection = await db.prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,
      c.aws_account_id AS account_id,c.partition,c.permission_pack_version ${LIVE_CONNECTION}
      AND c.org_id=? AND c.customer_id=? AND c.id=? LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<ConnectionRow>();
    if (connection === null) reject("SCOPE_NOT_FOUND");
    if (!/^\d{12}$/u.test(connection.account_id)
      || !new Set(["aws", "aws-us-gov", "aws-cn"]).has(connection.partition)
      || !isDcfRuntimePermissionPack(connection.permission_pack_version)) reject("STORED_STATE_INVALID");
    const rows = await db.prepare(`SELECT module_id,module_name,source_id,region,state_machine_arn,
      enabled,expected_cadence_minutes FROM finops_dcf_module_bindings
      WHERE org_id=? AND customer_id=? AND connection_id=?
      ORDER BY module_id ASC LIMIT ?`).bind(
      scope.organizationId, scope.customerId, scope.connectionId, MAXIMUM_MODULES + 1,
    ).all<ModuleRow>();
    const values = rows.results ?? [];
    if (values.length < 1) reject("SCOPE_NOT_FOUND");
    if (values.length > MAXIMUM_MODULES) reject("BOUND_REACHED");
    const regions = new Set(values.map((row) => row.region));
    if (regions.size !== 1 || !values.some((row) => row.enabled === true || row.enabled === 1)) {
      reject("STORED_STATE_INVALID");
    }
    const region = values[0]!.region;
    const partitionPrefix = connection.partition === "aws-cn" ? "cn-"
      : connection.partition === "aws-us-gov" ? "us-gov-" : "";
    if ((partitionPrefix !== "" && !region.startsWith(partitionPrefix))
      || (partitionPrefix === "" && (region.startsWith("cn-") || region.startsWith("us-gov-")))) {
      reject("STORED_STATE_INVALID");
    }
    const modules: DcfStepFunctionsModuleBinding[] = values.map((row) => {
      const expected = integer(row.expected_cadence_minutes);
      const binding = {
        moduleId: row.module_id, moduleName: row.module_name, sourceId: row.source_id,
        enabled: row.enabled === true || row.enabled === 1,
        expectedCadenceMinutes: expected, stateMachineArn: row.state_machine_arn,
      };
      if (!IDENTIFIER.test(binding.moduleId) || binding.moduleName.length < 1 || binding.moduleName.length > 256
        || (binding.sourceId !== null && !IDENTIFIER.test(binding.sourceId))
        || expected < 5 || expected > 10_080
        || !binding.stateMachineArn.startsWith(`arn:${connection.partition}:states:${region}:${connection.account_id}:stateMachine:`)) {
        reject("STORED_STATE_INVALID");
      }
      return Object.freeze(binding);
    });
    const trusted: DcfScope = Object.freeze({
      orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId,
      managementAccountId: connection.account_id, partition: connection.partition, region,
    });
    const boundaryBase = { binding: "SERVER_RESOLVED_DCF_STACK" as const, scope: trusted, schedulerRegistered: true, modules };
    return Object.freeze({
      schemaVersion: "sutra.dcf-step-functions-boundary.v1",
      boundaryId: `dcfb_${await digest(JSON.stringify(boundaryBase))}`,
      ...boundaryBase,
    });
  }

  public async claim(input: { readonly key: string; readonly jobId: string; readonly leaseDurationMs: 960_000 }): Promise<DcfStepFunctionsReplayClaim> {
    if (!JOB.test(input.jobId) || input.leaseDurationMs !== 960_000) reject("INVALID_INPUT");
    const parsed = parseKey(input.key); await this.loadBoundary(parsed.scope);
    const db = await this.ready(); const now = this.clock();
    const existing = await db.prepare(`SELECT * FROM finops_dcf_runtime_attempts WHERE idempotency_key=? LIMIT 1`)
      .bind(input.key).first<AttemptRow>();
    if (existing?.state === "COMPLETED") {
      if (existing.result_json === null || existing.result_sha256 === null || !SHA256.test(existing.result_sha256)) reject("STORED_STATE_INVALID");
      let result: unknown; try { result = JSON.parse(existing.result_json); } catch { return reject("STORED_STATE_INVALID"); }
      if (!exactResult(result) || await digest(existing.result_json) !== existing.result_sha256) reject("STORED_STATE_INVALID");
      return { state: "COMPLETED", result, resultSha256: existing.result_sha256 };
    }
    if (existing?.state === "IN_PROGRESS" && integer(existing.lease_expires_at) > now) return { state: "IN_PROGRESS" };
    const token = await leaseToken();
    if (existing === null) {
      await db.prepare(`INSERT INTO finops_dcf_runtime_attempts(idempotency_key,org_id,customer_id,connection_id,
        job_id,scheduled_window,state,lease_token,lease_expires_at,result_json,result_sha256,failure_code,
        started_at,completed_at,updated_at) VALUES(?,?,?,?,?,?,'IN_PROGRESS',?,?,NULL,NULL,NULL,?,NULL,?)
        ON CONFLICT(idempotency_key) DO NOTHING`).bind(
        input.key, parsed.scope.organizationId, parsed.scope.customerId, parsed.scope.connectionId,
        input.jobId, parsed.scheduledWindow, token, now + input.leaseDurationMs, now, now,
      ).run();
    } else {
      await db.prepare(`UPDATE finops_dcf_runtime_attempts SET job_id=?,state='IN_PROGRESS',lease_token=?,
        lease_expires_at=?,result_json=NULL,result_sha256=NULL,failure_code=NULL,started_at=?,completed_at=NULL,updated_at=?
        WHERE idempotency_key=? AND state<>'COMPLETED' AND (state='FAILED' OR lease_expires_at<=?)`).bind(
        input.jobId, token, now + input.leaseDurationMs, now, now, input.key, now,
      ).run();
    }
    const claimed = await db.prepare(`SELECT * FROM finops_dcf_runtime_attempts WHERE idempotency_key=? LIMIT 1`)
      .bind(input.key).first<AttemptRow>();
    if (claimed === null || claimed.state !== "IN_PROGRESS" || claimed.lease_token !== token
      || claimed.job_id !== input.jobId) return { state: "IN_PROGRESS" };
    return { state: "ACQUIRED", leaseToken: token };
  }

  public async complete(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string; readonly result: DcfStepFunctionsRuntimeResult; readonly resultSha256: string }): Promise<void> {
    parseKey(input.key);
    if (!JOB.test(input.jobId) || !SHA256.test(input.leaseToken) || !SHA256.test(input.resultSha256)
      || !exactResult(input.result)) reject("INVALID_INPUT");
    const json = JSON.stringify(input.result);
    if (await digest(json) !== input.resultSha256) reject("INVALID_INPUT");
    const now = this.clock();
    const result = await (await this.ready()).prepare(`UPDATE finops_dcf_runtime_attempts
      SET state='COMPLETED',result_json=?,result_sha256=?,failure_code=NULL,completed_at=?,updated_at=?
      WHERE idempotency_key=? AND job_id=? AND state='IN_PROGRESS' AND lease_token=? AND lease_expires_at>=?`)
      .bind(json, input.resultSha256, now, now, input.key, input.jobId, input.leaseToken, now).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
  }

  public async fail(input: { readonly key: string; readonly jobId: string; readonly leaseToken: string; readonly failureCode: "DCF_STEP_FUNCTIONS_COLLECTION_FAILED" }): Promise<void> {
    parseKey(input.key);
    if (!JOB.test(input.jobId) || !SHA256.test(input.leaseToken)
      || input.failureCode !== "DCF_STEP_FUNCTIONS_COLLECTION_FAILED") reject("INVALID_INPUT");
    const now = this.clock();
    const result = await (await this.ready()).prepare(`UPDATE finops_dcf_runtime_attempts
      SET state='FAILED',result_json=NULL,result_sha256=NULL,failure_code=?,completed_at=?,updated_at=?
      WHERE idempotency_key=? AND job_id=? AND state='IN_PROGRESS' AND lease_token=?`)
      .bind(input.failureCode, now, now, input.key, input.jobId, input.leaseToken).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
  }

  public async record(scope: DcfPersistenceScope, trusted: DcfScope, capture: DcfCapture) {
    return this.snapshots.recordCapture(scope, trusted, capture, Date.parse(capture.completedAt));
  }

  public async getRuntimeStatus(scope: DcfStepFunctionsRuntimeScope): Promise<DcfRuntimeStatus> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const row = await (await this.ready()).prepare(`SELECT * FROM finops_dcf_runtime_attempts
      WHERE org_id=? AND customer_id=? AND connection_id=? ORDER BY updated_at DESC,idempotency_key DESC LIMIT 1`)
      .bind(scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (row === null) {
      try { await this.loadBoundary(scope); }
      catch { return { state: "unavailable", reason: "DCF_MODULE_BINDING_OR_PERMISSION_PACK_REQUIRED", sourceState: null, lastAttemptAt: null }; }
      return { state: "unavailable", reason: "DCF_COLLECTION_NOT_STARTED", sourceState: null, lastAttemptAt: null };
    }
    const lastAttemptAt = new Date(integer(row.updated_at)).toISOString();
    if (row.state === "IN_PROGRESS") return integer(row.lease_expires_at) > this.clock()
      ? { state: "collecting", reason: "DCF_COLLECTION_IN_PROGRESS", sourceState: null, lastAttemptAt }
      : { state: "failed", reason: "DCF_COLLECTION_LEASE_EXPIRED", sourceState: null, lastAttemptAt };
    if (row.state === "FAILED") return { state: "failed", reason: "DCF_STEP_FUNCTIONS_COLLECTION_FAILED", sourceState: null, lastAttemptAt };
    if (row.result_json === null || row.result_sha256 === null || await digest(row.result_json) !== row.result_sha256) reject("STORED_STATE_INVALID");
    let result: unknown; try { result = JSON.parse(row.result_json); } catch { return reject("STORED_STATE_INVALID"); }
    if (!exactResult(result)) reject("STORED_STATE_INVALID");
    if (result.sourceState === "READY" || result.sourceState === "STALE") {
      return { state: "ready", reason: result.sourceState === "STALE" ? "DCF_COLLECTION_READY_STALE" : "DCF_COLLECTION_READY", sourceState: result.sourceState, lastAttemptAt };
    }
    return { state: "unavailable", reason: result.sourceState === "PARTIAL" ? "DCF_COLLECTION_PARTIAL_REJECTED" : "DCF_PROVIDER_UNAVAILABLE", sourceState: result.sourceState, lastAttemptAt };
  }
}

export const DCF_RUNTIME_REPOSITORY_CONTRACT = Object.freeze({
  jobKind: DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND,
  permissionPack: DCF_REQUIRED_PERMISSION_PACK,
  moduleBinding: "SERVER_RESOLVED_DCF_STACK",
  leaseDurationMs: 960_000,
  partialCapturesAdvanceHead: false,
});
