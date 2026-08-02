/** Durable lease, replay, evidence binding, and status for ADD-11. */
import { canonicalJson } from "../lib/canonical-json.ts";
import {
  normalizeAmazonConnectCostInsightCapture,
  type AmazonConnectCostInsightSnapshot,
} from "../lib/finops-amazon-connect-cost-insight.ts";
import type {
  AmazonConnectCostAcceptedRuntimeAttempt,
  AmazonConnectCostImmutableEvidenceHandoff,
  AmazonConnectCostRuntimeFailureCode,
} from "../lib/finops-amazon-connect-cost-insight-runtime-binding.ts";
import {
  AmazonConnectCostInsightRepository,
  type AmazonConnectCostInsightPersistenceScope,
} from "./finops-amazon-connect-cost-insight-repository.ts";
import { getRawDb } from "./index.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";

export const AMAZON_CONNECT_COST_RUNTIME_PERMISSION_PACK = "standard-2026-08.16" as const;
export const AMAZON_CONNECT_COST_RUNTIME_LEASE_MS = 17 * 60 * 1_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const REQUEST = /^acr_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SHA = /^[a-f0-9]{64}$/u;
const GENERATION = /^acig_[a-f0-9]{64}$/u;
const EVIDENCE_GENERATION = /^fss_[a-f0-9]{64}$/u;
const EVIDENCE_OBJECT = /^eobj_[a-f0-9]{32}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const LEASE = /^acl_[a-f0-9]{32}$/u;

interface AttemptRow {
  readonly request_id: string;
  readonly org_id: string;
  readonly customer_id: string;
  readonly connection_id: string;
  readonly scheduled_window: string;
  readonly source_boundary_sha256: string;
  readonly state: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  readonly lease_token: string | null;
  readonly lease_expires_at: number | string | null;
  readonly generation_id: string | null;
  readonly evidence_generation_id: string | null;
  readonly evidence_object_id: string | null;
  readonly evidence_content_sha256: string | null;
  readonly evidence_reference: string | null;
  readonly evidence_key_version: string | null;
  readonly failure_code: AmazonConnectCostRuntimeFailureCode | null;
  readonly started_at: number | string;
  readonly completed_at: number | string | null;
  readonly updated_at: number | string;
}

export interface AmazonConnectCostRuntimeStatus {
  readonly state: "unavailable" | "collecting" | "failed" | "ready";
  readonly reason: string;
  readonly lastAttemptAt: string | null;
  readonly acceptedGenerationId: string | null;
}

export class AmazonConnectCostRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "ATTEMPT_IN_PROGRESS"
    | "LEASE_LOST" | "STORED_STATE_INVALID";
  public constructor(code: AmazonConnectCostRuntimeRepositoryError["code"]) {
    super("Amazon Connect cost runtime persistence rejected");
    this.name = "AmazonConnectCostRuntimeRepositoryError";
    this.code = code;
  }
}

function reject(code: AmazonConnectCostRuntimeRepositoryError["code"]): never {
  throw new AmazonConnectCostRuntimeRepositoryError(code);
}
function validScope(scope: AmazonConnectCostInsightPersistenceScope): boolean {
  return ID.test(scope.organizationId) && ID.test(scope.customerId)
    && CONNECTION.test(scope.connectionId);
}
function integer(value: number | string | null): number {
  if (value === null) reject("STORED_STATE_INVALID");
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

export class AmazonConnectCostRuntimeRepository
implements AmazonConnectCostImmutableEvidenceHandoff {
  private readonly snapshots: AmazonConnectCostInsightRepository;
  private readonly leases = new Map<string, string>();
  private readonly now: () => number;
  private readonly skipRuntimeSchema: boolean;

  public constructor(
    private readonly database: D1Database = getRawDb(),
    options: { readonly now?: () => number; readonly skipRuntimeSchema?: boolean } = {},
  ) {
    this.snapshots = new AmazonConnectCostInsightRepository(database, {
      skipRuntimeSchema: options.skipRuntimeSchema,
    });
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
  private async row(requestId: string): Promise<AttemptRow | null> {
    return (await this.ready()).prepare(
      "SELECT * FROM finops_amazon_connect_runtime_attempts WHERE request_id=? LIMIT 1",
    ).bind(requestId).first<AttemptRow>();
  }
  private validateIdentity(input: {
    readonly scope: AmazonConnectCostInsightPersistenceScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly sourceBoundarySha256: string;
  }): void {
    if (!validScope(input.scope) || !REQUEST.test(input.requestId)
      || !WINDOW.test(input.scheduledWindow)
      || new Date(Date.parse(input.scheduledWindow)).toISOString() !== input.scheduledWindow
      || !SHA.test(input.sourceBoundarySha256)) reject("INVALID_INPUT");
  }

  private evidence(row: AttemptRow): AmazonConnectCostAcceptedRuntimeAttempt["evidence"] {
    if (row.evidence_generation_id === null || !EVIDENCE_GENERATION.test(row.evidence_generation_id)
      || row.evidence_object_id === null || !EVIDENCE_OBJECT.test(row.evidence_object_id)
      || row.evidence_content_sha256 === null || !SHA.test(row.evidence_content_sha256)
      || row.evidence_reference === null || !SEALED_REFERENCE.test(row.evidence_reference)
      || row.evidence_key_version === null || !KEY_VERSION.test(row.evidence_key_version)) {
      reject("STORED_STATE_INVALID");
    }
    return Object.freeze({
      generationId: row.evidence_generation_id,
      objectId: row.evidence_object_id,
      contentSha256: row.evidence_content_sha256,
      reference: Object.freeze({
        ciphertext: row.evidence_reference,
        keyVersion: row.evidence_key_version,
      }),
    });
  }

  private async accepted(
    scope: AmazonConnectCostInsightPersistenceScope,
    row: AttemptRow,
  ): Promise<AmazonConnectCostAcceptedRuntimeAttempt> {
    if (row.state !== "SUCCEEDED" || row.generation_id === null
      || !GENERATION.test(row.generation_id)) reject("STORED_STATE_INVALID");
    const snapshot = await this.snapshots.getSnapshotByGeneration(scope, row.generation_id);
    if (snapshot === null) reject("STORED_STATE_INVALID");
    return Object.freeze({
      requestId: row.request_id,
      scheduledWindow: row.scheduled_window,
      sourceBoundarySha256: row.source_boundary_sha256,
      snapshot,
      evidence: this.evidence(row),
    });
  }

  private async repairOrphan(
    scope: AmazonConnectCostInsightPersistenceScope,
    row: AttemptRow,
    now: number,
  ): Promise<boolean> {
    if (row.evidence_generation_id === null) return false;
    this.evidence(row);
    const snapshot = await this.snapshots.getSnapshotByCaptureId(
      scope, `connect_${row.request_id.slice(4)}`,
    );
    if (snapshot === null) return false;
    const updated = await (await this.ready()).prepare(
      `UPDATE finops_amazon_connect_runtime_attempts
          SET state='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,generation_id=?,
              failure_code=NULL,completed_at=?,updated_at=?
        WHERE request_id=? AND org_id=? AND customer_id=? AND connection_id=?
          AND state='IN_PROGRESS' AND lease_expires_at<=?`,
    ).bind(snapshot.generationId, now, now, row.request_id, scope.organizationId,
      scope.customerId, scope.connectionId, now).run();
    return Number(updated.meta?.changes ?? 0) === 1;
  }

  public async prepareAttempt(input: {
    readonly scope: AmazonConnectCostInsightPersistenceScope;
    readonly requestId: string;
    readonly scheduledWindow: string;
    readonly sourceBoundarySha256: string;
    readonly nowMs: number;
  }): Promise<void> {
    this.validateIdentity(input);
    const now = this.clock();
    if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0
      || Math.abs(input.nowMs - now) > 5_000) reject("INVALID_INPUT");
    const lease = `acl_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!LEASE.test(lease)) reject("INVALID_INPUT");
    const database = await this.ready();
    await database.prepare(
      `INSERT INTO finops_amazon_connect_runtime_attempts(
        request_id,org_id,customer_id,connection_id,scheduled_window,
        source_boundary_sha256,state,lease_token,lease_expires_at,started_at,updated_at
      )SELECT ?,c.org_id,c.customer_id,c.id,?,?,'IN_PROGRESS',?,?,?,?
         FROM aws_connections c
         JOIN organizations o ON o.id=c.org_id AND o.status='active'
         JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id
           AND cu.status IN ('active','trial')
        WHERE c.org_id=? AND c.customer_id=? AND c.id=?
          AND c.source_kind='aws_trust_role' AND c.status='active'
          AND c.permission_pack_version=? ON CONFLICT DO NOTHING`,
    ).bind(input.requestId, input.scheduledWindow, input.sourceBoundarySha256,
      lease, now + AMAZON_CONNECT_COST_RUNTIME_LEASE_MS, now, now,
      input.scope.organizationId, input.scope.customerId, input.scope.connectionId,
      AMAZON_CONNECT_COST_RUNTIME_PERMISSION_PACK).run();
    let row = await this.row(input.requestId);
    if (row === null || row.org_id !== input.scope.organizationId
      || row.customer_id !== input.scope.customerId
      || row.connection_id !== input.scope.connectionId
      || row.scheduled_window !== input.scheduledWindow
      || row.source_boundary_sha256 !== input.sourceBoundarySha256) reject("SCOPE_NOT_FOUND");
    if (row.state === "SUCCEEDED") return;
    if (row.lease_token === lease) {
      this.leases.set(input.requestId, lease);
      return;
    }
    if (row.state === "IN_PROGRESS" && integer(row.lease_expires_at) > now) {
      reject("ATTEMPT_IN_PROGRESS");
    }
    if (row.state === "IN_PROGRESS" && await this.repairOrphan(input.scope, row, now)) return;
    const reclaimed = await database.prepare(
      `UPDATE finops_amazon_connect_runtime_attempts
          SET state='IN_PROGRESS',lease_token=?,lease_expires_at=?,generation_id=NULL,
              evidence_generation_id=NULL,evidence_object_id=NULL,evidence_content_sha256=NULL,
              evidence_reference=NULL,evidence_key_version=NULL,failure_code=NULL,
              started_at=?,completed_at=NULL,updated_at=?
        WHERE request_id=? AND org_id=? AND customer_id=? AND connection_id=?
          AND (state='FAILED' OR (state='IN_PROGRESS' AND lease_expires_at<=?))`,
    ).bind(lease, now + AMAZON_CONNECT_COST_RUNTIME_LEASE_MS, now, now, input.requestId,
      input.scope.organizationId, input.scope.customerId, input.scope.connectionId, now).run();
    if (Number(reclaimed.meta?.changes ?? 0) !== 1) reject("ATTEMPT_IN_PROGRESS");
    row = await this.row(input.requestId);
    if (row?.lease_token !== lease || row.state !== "IN_PROGRESS") reject("LEASE_LOST");
    this.leases.set(input.requestId, lease);
  }

  public async getAccepted(
    scope: AmazonConnectCostInsightPersistenceScope,
    requestId: string,
  ): Promise<AmazonConnectCostAcceptedRuntimeAttempt | null> {
    if (!validScope(scope) || !REQUEST.test(requestId)) reject("INVALID_INPUT");
    const row = await this.row(requestId);
    if (row === null || row.org_id !== scope.organizationId
      || row.customer_id !== scope.customerId || row.connection_id !== scope.connectionId) {
      reject("SCOPE_NOT_FOUND");
    }
    if (row.state === "SUCCEEDED") return this.accepted(scope, row);
    if (row.state !== "IN_PROGRESS" || this.leases.get(requestId) !== row.lease_token) {
      reject("ATTEMPT_IN_PROGRESS");
    }
    return null;
  }

  public async commit(input: Parameters<AmazonConnectCostImmutableEvidenceHandoff["commit"]>[0]) {
    const lease = this.leases.get(input.requestId);
    if (lease === undefined || !LEASE.test(lease) || !validScope(input.scope)) reject("LEASE_LOST");
    const normalized = normalizeAmazonConnectCostInsightCapture(
      input.capture, input.trustedScope, input.nowMs,
    );
    if (canonicalJson(normalized) !== canonicalJson(input.normalizedSnapshot)) {
      reject("INVALID_INPUT");
    }
    const row = await this.row(input.requestId);
    if (row === null || row.state !== "IN_PROGRESS" || row.lease_token !== lease
      || integer(row.lease_expires_at) < input.nowMs
      || row.scheduled_window !== input.scheduledWindow
      || row.source_boundary_sha256 !== input.sourceBoundarySha256) reject("LEASE_LOST");
    this.evidence({
      ...row,
      evidence_generation_id: input.evidence.generationId,
      evidence_object_id: input.evidence.objectId,
      evidence_content_sha256: input.evidence.contentSha256,
      evidence_reference: input.evidence.reference.ciphertext,
      evidence_key_version: input.evidence.reference.keyVersion,
    });
    const database = await this.ready();
    const prepared = await database.prepare(
      `UPDATE finops_amazon_connect_runtime_attempts
          SET evidence_generation_id=?,evidence_object_id=?,evidence_content_sha256=?,
              evidence_reference=?,evidence_key_version=?,updated_at=?
        WHERE request_id=? AND state='IN_PROGRESS' AND lease_token=? AND lease_expires_at>=?`,
    ).bind(input.evidence.generationId, input.evidence.objectId,
      input.evidence.contentSha256, input.evidence.reference.ciphertext,
      input.evidence.reference.keyVersion, input.nowMs, input.requestId,
      lease, input.nowMs).run();
    if (Number(prepared.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
    const stored = await this.snapshots.recordCapture(
      input.trustedScope, input.capture, input.nowMs,
    );
    const completed = await database.prepare(
      `UPDATE finops_amazon_connect_runtime_attempts
          SET state='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,generation_id=?,
              failure_code=NULL,completed_at=?,updated_at=?
        WHERE request_id=? AND state='IN_PROGRESS' AND lease_token=? AND lease_expires_at>=?
          AND evidence_generation_id=? AND evidence_content_sha256=?`,
    ).bind(stored.snapshot.generationId, input.nowMs, input.nowMs, input.requestId,
      lease, input.nowMs, input.evidence.generationId, input.evidence.contentSha256).run();
    if (Number(completed.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
    this.leases.delete(input.requestId);
    const acceptedRow = await this.row(input.requestId);
    if (acceptedRow === null) reject("STORED_STATE_INVALID");
    return Object.freeze({
      accepted: await this.accepted(input.scope, acceptedRow),
      becameActive: stored.becameActive,
    });
  }

  public async recordFailure(
    input: Parameters<AmazonConnectCostImmutableEvidenceHandoff["recordFailure"]>[0],
  ): Promise<void> {
    const lease = this.leases.get(input.requestId);
    if (lease === undefined || !validScope(input.scope)
      || !REQUEST.test(input.requestId) || !WINDOW.test(input.scheduledWindow)
      || !Number.isSafeInteger(input.completedAtMs) || input.completedAtMs < 0) reject("LEASE_LOST");
    const body = canonicalJson({
      schemaVersion: "sutra.amazon-connect-runtime-failure.v1",
      requestId: input.requestId,
      scope: input.scope,
      scheduledWindow: input.scheduledWindow,
      code: input.code,
      failedAt: input.completedAtMs,
    });
    const contentSha256 = await sha256(body);
    const database = await this.ready();
    const [updated] = await database.batch([
      database.prepare(
        `UPDATE finops_amazon_connect_runtime_attempts
            SET state='FAILED',lease_token=NULL,lease_expires_at=NULL,generation_id=NULL,
                evidence_generation_id=NULL,evidence_object_id=NULL,evidence_content_sha256=NULL,
                evidence_reference=NULL,evidence_key_version=NULL,failure_code=?,completed_at=?,updated_at=?
          WHERE request_id=? AND org_id=? AND customer_id=? AND connection_id=?
            AND scheduled_window=? AND state='IN_PROGRESS' AND lease_token=?`,
      ).bind(input.code, input.completedAtMs, input.completedAtMs, input.requestId,
        input.scope.organizationId, input.scope.customerId, input.scope.connectionId,
        input.scheduledWindow, lease),
      database.prepare(
        `INSERT INTO finops_amazon_connect_runtime_failures(
          failure_id,request_id,org_id,customer_id,connection_id,failure_code,
          content_sha256,failed_at
        )VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      ).bind(`acrf_${contentSha256}`, input.requestId, input.scope.organizationId,
        input.scope.customerId, input.scope.connectionId, input.code,
        contentSha256, input.completedAtMs),
    ]);
    if (Number(updated.meta?.changes ?? 0) !== 1) reject("LEASE_LOST");
    this.leases.delete(input.requestId);
  }

  public async getRuntimeStatus(
    scope: AmazonConnectCostInsightPersistenceScope,
  ): Promise<AmazonConnectCostRuntimeStatus> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const row = await (await this.ready()).prepare(
      `SELECT * FROM finops_amazon_connect_runtime_attempts
        WHERE org_id=? AND customer_id=? AND connection_id=?
        ORDER BY updated_at DESC,request_id DESC LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (row === null) return Object.freeze({ state: "unavailable", reason: "AMAZON_CONNECT_COLLECTION_NOT_STARTED", lastAttemptAt: null, acceptedGenerationId: null });
    const lastAttemptAt = new Date(integer(row.updated_at)).toISOString();
    if (row.state === "IN_PROGRESS") {
      return integer(row.lease_expires_at) <= this.clock()
        ? Object.freeze({ state: "failed", reason: "AMAZON_CONNECT_COLLECTION_LEASE_EXPIRED", lastAttemptAt, acceptedGenerationId: null })
        : Object.freeze({ state: "collecting", reason: "AMAZON_CONNECT_COLLECTION_IN_PROGRESS", lastAttemptAt, acceptedGenerationId: null });
    }
    if (row.state === "FAILED") return Object.freeze({ state: "failed", reason: row.failure_code ?? "AMAZON_CONNECT_COLLECTION_FAILED", lastAttemptAt, acceptedGenerationId: null });
    if (row.generation_id === null || !GENERATION.test(row.generation_id)) reject("STORED_STATE_INVALID");
    const snapshot = await this.snapshots.getSnapshotByGeneration(scope, row.generation_id);
    if (snapshot === null) reject("STORED_STATE_INVALID");
    if (!amazonConnectSnapshotIsReady(snapshot.snapshot)) {
      return Object.freeze({ state: "unavailable",
        reason: "AMAZON_CONNECT_COMPLETE_HISTORY_NOT_YET_ACCEPTED", lastAttemptAt,
        acceptedGenerationId: row.generation_id });
    }
    return Object.freeze({ state: "ready", reason: "AMAZON_CONNECT_COLLECTION_READY", lastAttemptAt, acceptedGenerationId: row.generation_id });
  }
}

export function amazonConnectSnapshotIsReady(snapshot: AmazonConnectCostInsightSnapshot): boolean {
  return snapshot.complete && ["current", "stale", "empty"].includes(snapshot.state);
}
