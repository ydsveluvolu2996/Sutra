/** Durable ADV-04 scheduler/replay state and server-owned AWS boundary loader. */
import type {
  ExtendedSupportReplayClaim,
  ExtendedSupportReplayStore,
  ExtendedSupportRuntimeResult,
} from "../lib/finops-extended-support-runtime-binding.ts";
import type { ExtendedSupportTenantBoundary } from "../lib/finops-extended-support-projection.ts";
import type { ExtendedSupportPersistenceScope } from "./finops-extended-support-repository.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const JOB = /^job_[a-f0-9]{32}$/u;
const LEASE = /^lease_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION = /^espg_[a-f0-9]{64}$/u;
const COLLECTION = /^esp_[a-f0-9]{64}$/u;
const MAXIMUM_SCOPES = 10_000;

interface ConnectionRow {
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly account_id: string;
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly enabled_regions_json: string;
}

interface ReceiptRow {
  readonly idempotency_key: string;
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly scheduled_window: string;
  readonly state: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  readonly job_id: string;
  readonly lease_token: string | null;
  readonly lease_expires_at: number | string | null;
  readonly result_json: string | null;
  readonly result_sha256: string | null;
  readonly failure_code: "EXTENDED_SUPPORT_COLLECTION_FAILED" | null;
  readonly completed_at: number | string | null;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

export class ExtendedSupportRuntimeRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "LEASE_CONFLICT"
    | "STORED_STATE_INVALID";

  public constructor(code: ExtendedSupportRuntimeRepositoryError["code"]) {
    super("Extended Support runtime persistence operation rejected");
    this.name = "ExtendedSupportRuntimeRepositoryError";
    this.code = code;
  }
}

function reject(
  code: ExtendedSupportRuntimeRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new ExtendedSupportRuntimeRepositoryError(code);
}

function integer(value: number | string): number {
  const result = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(result) || result < 0) reject("STORED_STATE_INVALID");
  return result;
}

function validScope(scope: ExtendedSupportPersistenceScope): boolean {
  return IDENTIFIER.test(scope.organizationId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}

function validResult(value: unknown): value is ExtendedSupportRuntimeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(result).sort())
      === JSON.stringify(["becameActive", "collectionId", "generationId", "state"])
    && typeof result.generationId === "string" && GENERATION.test(result.generationId)
    && typeof result.collectionId === "string" && COLLECTION.test(result.collectionId)
    && typeof result.state === "string"
    && ["READY", "PARTIAL", "CONFIGURATION_REQUIRED"].includes(result.state)
    && typeof result.becameActive === "boolean";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function parseKey(key: string): {
  readonly scope: ExtendedSupportPersistenceScope;
  readonly scheduledWindow: string;
} {
  if (typeof key !== "string" || key.length < 1 || key.length > 512 || key.includes("\0")) reject();
  const parts = key.split(":");
  if (parts.length !== 5 || parts[0] !== "extended-support") reject();
  let organizationId: string;
  let customerId: string;
  let connectionId: string;
  let scheduledWindow: string;
  try {
    organizationId = decodeURIComponent(parts[1]!);
    customerId = decodeURIComponent(parts[2]!);
    connectionId = decodeURIComponent(parts[3]!);
    scheduledWindow = decodeURIComponent(parts[4]!);
  } catch { reject(); }
  const scope = { organizationId, customerId, connectionId };
  if (!validScope(scope) || !WINDOW.test(scheduledWindow)
    || new Date(Date.parse(scheduledWindow)).toISOString() !== scheduledWindow
    || key !== `extended-support:${[
      organizationId, customerId, connectionId, scheduledWindow,
    ].map(encodeURIComponent).join(":")}`) reject();
  return { scope, scheduledWindow };
}

function verifyReceipt(row: ReceiptRow): void {
  const created = integer(row.created_at);
  const updated = integer(row.updated_at);
  if (!JOB.test(row.job_id) || !WINDOW.test(row.scheduled_window) || updated < created) {
    reject("STORED_STATE_INVALID");
  }
  if (row.state === "IN_PROGRESS") {
    if (row.lease_token === null || !LEASE.test(row.lease_token)
      || row.lease_expires_at === null || integer(row.lease_expires_at) < updated
      || row.result_json !== null || row.result_sha256 !== null
      || row.failure_code !== null || row.completed_at !== null) reject("STORED_STATE_INVALID");
  } else if (row.state === "COMPLETED") {
    if (row.lease_token !== null || row.lease_expires_at !== null
      || row.result_json === null || row.result_sha256 === null
      || !SHA256.test(row.result_sha256) || row.failure_code !== null
      || row.completed_at === null || integer(row.completed_at) < created) reject("STORED_STATE_INVALID");
  } else if (row.lease_token !== null || row.lease_expires_at !== null
    || row.result_json !== null || row.result_sha256 !== null
    || row.failure_code !== "EXTENDED_SUPPORT_COLLECTION_FAILED"
    || row.completed_at === null || integer(row.completed_at) < created) {
    reject("STORED_STATE_INVALID");
  }
}

export interface ExtendedSupportRuntimeRepositoryOptions {
  readonly now?: () => number;
  readonly leaseToken?: () => string;
  readonly skipRuntimeSchema?: boolean;
}

export class ExtendedSupportRuntimeRepository implements ExtendedSupportReplayStore {
  private readonly now: () => number;
  private readonly leaseToken: () => string;
  private readonly skipRuntimeSchema: boolean;

  public constructor(
    private readonly database: D1Database = getRawDb(),
    options: ExtendedSupportRuntimeRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.leaseToken = options.leaseToken
      ?? (() => `lease_${crypto.randomUUID().replaceAll("-", "")}`);
    this.skipRuntimeSchema = options.skipRuntimeSchema ?? false;
  }

  private async ready(): Promise<D1Database> {
    if (!this.skipRuntimeSchema) await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async live(scope: ExtendedSupportPersistenceScope): Promise<ConnectionRow> {
    if (!validScope(scope)) reject();
    const row = await (await this.ready()).prepare(
      `SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,
              c.partition,c.enabled_regions_json
         FROM aws_connections c
         JOIN organizations o ON o.id=c.org_id AND o.status='active'
         JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id
           AND cu.status IN ('active','trial')
        WHERE c.org_id=? AND c.customer_id=? AND c.id=?
          AND c.source_kind='aws_trust_role' AND c.status='active'
          AND c.permission_pack_version='standard-2026-08.6' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<ConnectionRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return row;
  }

  public async loadBoundary(
    scope: ExtendedSupportPersistenceScope,
  ): Promise<ExtendedSupportTenantBoundary> {
    const row = await this.live(scope);
    if (!ACCOUNT.test(row.account_id)
      || !["aws", "aws-cn", "aws-us-gov"].includes(row.partition)) reject("STORED_STATE_INVALID");
    let regions: unknown;
    try { regions = JSON.parse(row.enabled_regions_json); } catch { reject("STORED_STATE_INVALID"); }
    if (!Array.isArray(regions) || regions.length < 1 || regions.length > 50
      || !regions.every((region) => typeof region === "string" && REGION.test(region))
      || JSON.stringify(regions) !== JSON.stringify([...new Set(regions)].sort())) {
      reject("STORED_STATE_INVALID");
    }
    return Object.freeze({
      scope: Object.freeze({
        orgId: row.org_id,
        customerId: row.customer_id,
        connectionId: row.connection_id,
      }),
      managementAccountId: row.account_id,
      partition: row.partition,
      accountIds: Object.freeze([row.account_id]),
      regions: Object.freeze(regions as string[]),
    });
  }

  public async listEligibleScopes(): Promise<readonly ExtendedSupportPersistenceScope[]> {
    const rows = await (await this.ready()).prepare(
      `SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,
              c.partition,c.enabled_regions_json
         FROM aws_connections c
         JOIN organizations o ON o.id=c.org_id AND o.status='active'
         JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id
           AND cu.status IN ('active','trial')
        WHERE c.source_kind='aws_trust_role' AND c.status='active'
          AND c.permission_pack_version='standard-2026-08.6'
        ORDER BY c.org_id,c.customer_id,c.id LIMIT ?`,
    ).bind(MAXIMUM_SCOPES + 1).all<ConnectionRow>();
    const received = rows.results ?? [];
    if (received.length > MAXIMUM_SCOPES) reject();
    return received.map((row) => Object.freeze({
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
    }));
  }

  public async claim(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<ExtendedSupportReplayClaim> {
    if (!JOB.test(input.jobId) || !Number.isSafeInteger(input.leaseDurationMs)
      || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 20 * 60_000) reject();
    const parsed = parseKey(input.key);
    const scope = await this.live(parsed.scope);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) reject();
    const token = this.leaseToken();
    if (!LEASE.test(token)) reject();
    const database = await this.ready();
    await database.prepare(
      `INSERT INTO finops_extended_support_runtime_receipts(
        idempotency_key,org_id,customer_id,connection_id,scheduled_window,state,
        job_id,lease_token,lease_expires_at,created_at,updated_at
      )VALUES(?,?,?,?,?,'IN_PROGRESS',?,?,?,?,?)ON CONFLICT DO NOTHING`,
    ).bind(input.key, scope.org_id, scope.customer_id, scope.connection_id,
      parsed.scheduledWindow, input.jobId, token, now + input.leaseDurationMs, now, now).run();
    await database.prepare(
      `UPDATE finops_extended_support_runtime_receipts
          SET state='IN_PROGRESS',job_id=?,lease_token=?,lease_expires_at=?,
              result_json=NULL,result_sha256=NULL,failure_code=NULL,completed_at=NULL,updated_at=?
        WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
          AND (state='FAILED' OR (state='IN_PROGRESS' AND lease_expires_at<=?))`,
    ).bind(input.jobId, token, now + input.leaseDurationMs, now, input.key,
      scope.org_id, scope.customer_id, scope.connection_id, now).run();
    const row = await database.prepare(
      `SELECT * FROM finops_extended_support_runtime_receipts
        WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=? LIMIT 1`,
    ).bind(input.key, scope.org_id, scope.customer_id, scope.connection_id).first<ReceiptRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    verifyReceipt(row);
    if (row.state === "COMPLETED") {
      let result: unknown;
      try { result = JSON.parse(row.result_json!); } catch { reject("STORED_STATE_INVALID"); }
      if (!validResult(result) || await sha256(row.result_json!) !== row.result_sha256) {
        reject("STORED_STATE_INVALID");
      }
      return { state: "COMPLETED", result, resultSha256: row.result_sha256! };
    }
    return row.job_id === input.jobId && row.lease_token === token
      ? { state: "ACQUIRED", leaseToken: token }
      : { state: "IN_PROGRESS" };
  }

  public async complete(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly result: ExtendedSupportRuntimeResult;
    readonly resultSha256: string;
  }): Promise<void> {
    if (!JOB.test(input.jobId) || !LEASE.test(input.leaseToken)
      || !SHA256.test(input.resultSha256) || !validResult(input.result)) reject();
    const json = JSON.stringify(input.result);
    if (await sha256(json) !== input.resultSha256) reject();
    const parsed = parseKey(input.key);
    const scope = await this.live(parsed.scope);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) reject();
    const updated = await (await this.ready()).prepare(
      `UPDATE finops_extended_support_runtime_receipts
          SET state='COMPLETED',lease_token=NULL,lease_expires_at=NULL,result_json=?,
              result_sha256=?,failure_code=NULL,completed_at=?,updated_at=?
        WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
          AND state='IN_PROGRESS' AND job_id=? AND lease_token=? AND lease_expires_at>?`,
    ).bind(json, input.resultSha256, now, now, input.key, scope.org_id,
      scope.customer_id, scope.connection_id, input.jobId, input.leaseToken, now).run();
    if (Number(updated.meta?.changes ?? 0) !== 1) reject("LEASE_CONFLICT");
  }

  public async fail(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly failureCode: "EXTENDED_SUPPORT_COLLECTION_FAILED";
  }): Promise<void> {
    if (!JOB.test(input.jobId) || !LEASE.test(input.leaseToken)
      || input.failureCode !== "EXTENDED_SUPPORT_COLLECTION_FAILED") reject();
    const parsed = parseKey(input.key);
    const scope = await this.live(parsed.scope);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) reject();
    const failureJson = JSON.stringify({
      schemaVersion: "sutra.extended-support-runtime-failure.v1",
      key: input.key,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      failureCode: input.failureCode,
      failedAtMs: now,
    });
    const digest = await sha256(failureJson);
    const database = await this.ready();
    const [updated] = await database.batch([
      database.prepare(
        `UPDATE finops_extended_support_runtime_receipts
            SET state='FAILED',lease_token=NULL,lease_expires_at=NULL,result_json=NULL,
                result_sha256=NULL,failure_code=?,completed_at=?,updated_at=?
          WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
            AND state='IN_PROGRESS' AND job_id=? AND lease_token=? AND lease_expires_at>?`,
      ).bind(input.failureCode, now, now, input.key, scope.org_id, scope.customer_id,
        scope.connection_id, input.jobId, input.leaseToken, now),
      database.prepare(
        `INSERT INTO finops_extended_support_runtime_failures(
          failure_id,idempotency_key,org_id,customer_id,connection_id,job_id,
          failure_code,content_sha256,failed_at
        )SELECT ?,idempotency_key,org_id,customer_id,connection_id,job_id,
            failure_code,?,completed_at FROM finops_extended_support_runtime_receipts
         WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
           AND state='FAILED' AND job_id=? AND completed_at=? ON CONFLICT DO NOTHING`,
      ).bind(`esf_${digest}`, digest, input.key, scope.org_id, scope.customer_id,
        scope.connection_id, input.jobId, now),
    ]);
    if (Number(updated.meta?.changes ?? 0) !== 1) reject("LEASE_CONFLICT");
  }
}
