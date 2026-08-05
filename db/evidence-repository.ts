import {
  createRuntimeEvidenceObjectStore,
  EvidenceObjectStoreError,
  MAX_EVIDENCE_OBJECT_BYTES,
  type EvidenceObjectStore,
  type EvidenceStoredObject,
} from "../lib/evidence-object-store.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const OBJECT_ID = /^eobj_[a-f0-9]{32}$/u;
const DOWNLOAD_TOKEN = /^sutra_evd_[A-Za-z0-9_-]{43}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const FINOPS_SNAPSHOT_ID = /^fss_[a-f0-9]{64}$/u;
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{1,126}$/u;
const MAX_GRANT_TTL_MS = 5 * 60 * 1000;
const MIN_GRANT_TTL_MS = 15 * 1000;

export type EvidenceArtifactKind =
  | "aws_snapshot_raw"
  | "export_json"
  | "export_csv"
  | "finops_source_snapshot";
export type EvidenceDownloadPurpose = "raw_evidence_review" | "export_download";

export interface EvidenceScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface EvidenceObjectSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly snapshotId: string | null;
  readonly artifactKind: EvidenceArtifactKind;
  readonly contentType: string;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly status: "staging" | "available" | "failed";
  readonly retentionUntil: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly availableAt: string | null;
}

export interface StoredEvidenceObject {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  run_id: string;
  snapshot_id: string | null;
  artifact_kind: EvidenceArtifactKind;
  object_key: string;
  content_type: string;
  content_sha256: string;
  byte_size: number;
  status: "staging" | "available" | "failed";
  retention_until: number;
  created_by: string;
  created_at: number;
  available_at: number | null;
}

interface GrantCandidateRow extends StoredEvidenceObject {
  grant_id: string;
  purpose: EvidenceDownloadPurpose;
  expires_at: number;
}

export class EvidenceRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "OBJECT_CONFLICT"
    | "GRANT_INVALID"
    | "STORAGE_UNAVAILABLE";

  public constructor(code: EvidenceRepositoryError["code"]) {
    super("Evidence operation rejected");
    this.name = "EvidenceRepositoryError";
    this.code = code;
  }
}

function reject(code: EvidenceRepositoryError["code"]): never {
  throw new EvidenceRepositoryError(code);
}

function assertScope(scope: EvidenceScope): void {
  if (
    !IDENTIFIER.test(scope.orgId) ||
    !IDENTIFIER.test(scope.customerId) ||
    !CONNECTION_ID.test(scope.connectionId)
  ) reject("INVALID_INPUT");
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const body = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", body as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 32_768) {
    for (const byte of value.subarray(index, index + 32_768)) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return reject("OBJECT_CONFLICT");
  }
  const result = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    result[index] = decoded.charCodeAt(index);
  }
  return result;
}

function summary(row: StoredEvidenceObject): EvidenceObjectSummary {
  return {
    id: row.id,
    connectionId: row.connection_id,
    runId: row.run_id,
    snapshotId: row.snapshot_id,
    artifactKind: row.artifact_kind,
    contentType: row.content_type,
    contentSha256: row.content_sha256,
    byteSize: Number(row.byte_size),
    status: row.status,
    retentionUntil: new Date(Number(row.retention_until)).toISOString(),
    createdBy: row.created_by,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    availableAt: row.available_at === null ? null : new Date(Number(row.available_at)).toISOString(),
  };
}

function retentionDaysFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const production = environment.SUTRA_DEPLOYMENT_ENV === "production" ||
    environment.SUTRA_HOSTED_ENABLED === "true";
  const raw = environment.SUTRA_EVIDENCE_RETENTION_DAYS?.trim();
  if (raw === undefined || raw.length === 0) {
    if (production) reject("STORAGE_UNAVAILABLE");
    return 30;
  }
  if (!/^\d{1,4}$/u.test(raw)) reject("STORAGE_UNAVAILABLE");
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) reject("STORAGE_UNAVAILABLE");
  return days;
}

export class EvidenceRepository {
  private readonly database: D1Database;
  private readonly objectStore: EvidenceObjectStore | null;
  private readonly retentionDays: number;

  public constructor(
    database: D1Database = getRawDb(),
    options: {
      readonly objectStore?: EvidenceObjectStore | null;
      readonly retentionDays?: number;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    } = {},
  ) {
    const environment = options.environment ?? process.env;
    this.database = database;
    this.objectStore = options.objectStore === undefined
      ? createRuntimeEvidenceObjectStore(environment)
      : options.objectStore;
    this.retentionDays = options.retentionDays ?? retentionDaysFromEnvironment(environment);
    if (
      !Number.isSafeInteger(this.retentionDays) ||
      this.retentionDays < 1 ||
      this.retentionDays > 3_650
    ) reject("INVALID_INPUT");
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async findRunArtifact(
    scope: EvidenceScope,
    runId: string,
    artifactKind: EvidenceArtifactKind,
  ): Promise<StoredEvidenceObject | null> {
    return this.database.prepare(
      `SELECT * FROM evidence_objects
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND run_id = ? AND artifact_kind = ?
        LIMIT 1`,
    ).bind(
      scope.orgId,
      scope.customerId,
      scope.connectionId,
      runId,
      artifactKind,
    ).first<StoredEvidenceObject>();
  }

  private async putLocalImmutable(row: StoredEvidenceObject, body: Uint8Array): Promise<void> {
    await this.database.prepare(
      `INSERT OR IGNORE INTO evidence_local_payloads
        (object_id, content_sha256, byte_size, body_base64, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.content_sha256,
      row.byte_size,
      encodeBase64(body),
      row.created_at,
    ).run();
    const stored = await this.database.prepare(
      `SELECT content_sha256, byte_size, body_base64
         FROM evidence_local_payloads WHERE object_id = ? LIMIT 1`,
    ).bind(row.id).first<{
      content_sha256: string;
      byte_size: number;
      body_base64: string;
    }>();
    if (
      stored === null ||
      stored.content_sha256 !== row.content_sha256 ||
      Number(stored.byte_size) !== row.byte_size ||
      await sha256Hex(decodeBase64(stored.body_base64)) !== row.content_sha256
    ) reject("OBJECT_CONFLICT");
  }

  public async archive(input: {
    readonly scope: EvidenceScope;
    readonly runId: string;
    readonly snapshotId?: string | null;
    readonly artifactKind: EvidenceArtifactKind;
    readonly contentType: string;
    readonly body: Uint8Array;
    readonly createdBy: string;
    readonly now?: number;
  }): Promise<EvidenceObjectSummary> {
    assertScope(input.scope);
    if (
      !IDENTIFIER.test(input.runId) ||
      (input.snapshotId !== undefined && input.snapshotId !== null && !IDENTIFIER.test(input.snapshotId)) ||
      !IDENTIFIER.test(input.createdBy) ||
      !CONTENT_TYPE.test(input.contentType) ||
      ![
        "aws_snapshot_raw",
        "export_json",
        "export_csv",
        "finops_source_snapshot",
      ].includes(input.artifactKind) ||
      input.body.byteLength < 1 ||
      input.body.byteLength > MAX_EVIDENCE_OBJECT_BYTES
    ) reject("INVALID_INPUT");
    const db = await this.ready();
    const now = input.now ?? Date.now();
    const contentSha256 = await sha256Hex(input.body);
    const snapshotId = input.snapshotId ?? null;
    let row = await this.findRunArtifact(input.scope, input.runId, input.artifactKind);
    if (row !== null && (
      row.snapshot_id !== snapshotId ||
      row.content_type !== input.contentType ||
      row.content_sha256 !== contentSha256 ||
      Number(row.byte_size) !== input.body.byteLength ||
      row.created_by !== input.createdBy
    )) reject("OBJECT_CONFLICT");
    if (row === null) {
      const objectId = `eobj_${randomHex(16)}`;
      // The S3 key exposes no tenant identifier or checksum. It is derived from
      // the complete tenant/content binding plus fresh server entropy, so even
      // a random collision cannot alias a different tenant's object.
      const objectKeyDigest = await sha256Hex(
        `${input.scope.orgId}\u0000${input.scope.customerId}\u0000${input.scope.connectionId}` +
        `\u0000${input.runId}\u0000${input.artifactKind}\u0000${contentSha256}\u0000${randomHex(32)}`,
      );
      await db.prepare(
        `INSERT OR IGNORE INTO evidence_objects
          (id, org_id, customer_id, connection_id, run_id, snapshot_id,
           artifact_kind, object_key, content_type, content_sha256, byte_size,
           status, retention_until, created_by, created_at)
         SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?,
                'staging', ?, ?, ?
           FROM aws_connections c
          WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?`,
      ).bind(
        objectId,
        input.runId,
        snapshotId,
        input.artifactKind,
        `evidence/v1/${objectKeyDigest}`,
        input.contentType,
        contentSha256,
        input.body.byteLength,
        now + this.retentionDays * 24 * 60 * 60 * 1000,
        input.createdBy,
        now,
        input.scope.connectionId,
        input.scope.orgId,
        input.scope.customerId,
      ).run();
      row = await this.findRunArtifact(input.scope, input.runId, input.artifactKind);
      if (row === null) reject("SCOPE_NOT_FOUND");
      if (
        row.snapshot_id !== snapshotId ||
        row.content_sha256 !== contentSha256 ||
        Number(row.byte_size) !== input.body.byteLength ||
        row.content_type !== input.contentType ||
        row.created_by !== input.createdBy
      ) reject("OBJECT_CONFLICT");
    }
    if (row.status === "available") return summary(row);
    try {
      await db.prepare(
        `UPDATE evidence_objects SET status = 'staging'
          WHERE id = ? AND org_id = ? AND status = 'failed'`,
      ).bind(row.id, input.scope.orgId).run();
      if (this.objectStore === null) {
        await this.putLocalImmutable(row, input.body);
      } else {
        await this.objectStore.putImmutable({
          objectKey: row.object_key,
          body: input.body,
          contentType: row.content_type,
          contentSha256: row.content_sha256,
        });
      }
    } catch (error) {
      await db.prepare(
        `UPDATE evidence_objects SET status = 'failed'
          WHERE id = ? AND org_id = ? AND status = 'staging'`,
      ).bind(row.id, input.scope.orgId).run().catch(() => undefined);
      if (error instanceof EvidenceRepositoryError) throw error;
      if (error instanceof EvidenceObjectStoreError && error.code === "OBJECT_CONFLICT") {
        return reject("OBJECT_CONFLICT");
      }
      return reject("STORAGE_UNAVAILABLE");
    }
    const availableAt = Math.max(now, Date.now());
    const result = await db.prepare(
      `UPDATE evidence_objects
          SET status = 'available', available_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = 'staging' AND content_sha256 = ? AND byte_size = ?`,
    ).bind(
      availableAt,
      row.id,
      input.scope.orgId,
      input.scope.customerId,
      input.scope.connectionId,
      contentSha256,
      input.body.byteLength,
    ).run();
    const available = await db.prepare(
      `SELECT * FROM evidence_objects
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = 'available' AND content_sha256 = ? AND byte_size = ?
        LIMIT 1`,
    ).bind(
      row.id,
      input.scope.orgId,
      input.scope.customerId,
      input.scope.connectionId,
      contentSha256,
      input.body.byteLength,
    ).first<StoredEvidenceObject>();
    if ((result.meta?.changes ?? 0) !== 1 && available === null) reject("STORAGE_UNAVAILABLE");
    if (available === null) reject("STORAGE_UNAVAILABLE");
    return summary(available);
  }

  public async list(scope: EvidenceScope): Promise<readonly EvidenceObjectSummary[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT * FROM evidence_objects
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = 'available' AND retention_until > ?
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, Date.now()).all<StoredEvidenceObject>();
    return (rows.results ?? []).map(summary);
  }

  public async issueGrant(input: {
    readonly scope: EvidenceScope;
    readonly objectId: string;
    readonly actorId: string;
    readonly purpose: EvidenceDownloadPurpose;
    readonly ttlMs?: number;
    readonly now?: number;
  }): Promise<{
    readonly token: string;
    readonly expiresAt: string;
    readonly object: EvidenceObjectSummary;
  }> {
    assertScope(input.scope);
    if (
      !OBJECT_ID.test(input.objectId) ||
      !IDENTIFIER.test(input.actorId) ||
      (input.purpose !== "raw_evidence_review" && input.purpose !== "export_download")
    ) reject("INVALID_INPUT");
    const ttlMs = input.ttlMs ?? 2 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_GRANT_TTL_MS || ttlMs > MAX_GRANT_TTL_MS) {
      reject("INVALID_INPUT");
    }
    const db = await this.ready();
    const now = input.now ?? Date.now();
    const object = await db.prepare(
      `SELECT * FROM evidence_objects
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = 'available' AND retention_until > ?
        LIMIT 1`,
    ).bind(
      input.objectId,
      input.scope.orgId,
      input.scope.customerId,
      input.scope.connectionId,
      now,
    ).first<StoredEvidenceObject>();
    if (object === null) reject("SCOPE_NOT_FOUND");
    if (
      (input.purpose === "raw_evidence_review" && object.artifact_kind !== "aws_snapshot_raw") ||
      (input.purpose === "export_download" &&
        object.artifact_kind !== "export_json" &&
        object.artifact_kind !== "export_csv")
    ) reject("INVALID_INPUT");
    const token = `sutra_evd_${randomBase64Url(32)}`;
    const tokenSha256 = await sha256Hex(token);
    const expiresAt = now + ttlMs;
    const grantId = `egrant_${randomHex(16)}`;
    const result = await db.prepare(
      `INSERT INTO evidence_download_grants
        (id, org_id, customer_id, object_id, actor_id, purpose,
         token_sha256, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      grantId,
      input.scope.orgId,
      input.scope.customerId,
      object.id,
      input.actorId,
      input.purpose,
      tokenSha256,
      expiresAt,
      now,
    ).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("STORAGE_UNAVAILABLE");
    return { token, expiresAt: new Date(expiresAt).toISOString(), object: summary(object) };
  }

  private async candidate(
    orgId: string,
    actorId: string,
    token: string,
    now: number,
  ): Promise<GrantCandidateRow | null> {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(actorId) || !DOWNLOAD_TOKEN.test(token)) {
      return null;
    }
    const tokenSha256 = await sha256Hex(token);
    return this.database.prepare(
      `SELECT o.*, g.id AS grant_id, g.purpose, g.expires_at
         FROM evidence_download_grants g
         JOIN evidence_objects o ON o.id = g.object_id
          AND o.org_id = g.org_id AND o.customer_id = g.customer_id
        WHERE g.org_id = ? AND g.actor_id = ? AND g.token_sha256 = ?
          AND g.consumed_at IS NULL AND g.expires_at > ?
          AND o.status = 'available' AND o.retention_until > ?
        LIMIT 1`,
    ).bind(orgId, actorId, tokenSha256, now, now).first<GrantCandidateRow>();
  }

  public async peekGrantScope(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly token: string;
    readonly now?: number;
  }): Promise<{
    readonly customerId: string;
    readonly connectionId: string;
    readonly objectId: string;
    readonly purpose: EvidenceDownloadPurpose;
  } | null> {
    await this.ready();
    const row = await this.candidate(
      input.orgId,
      input.actorId,
      input.token,
      input.now ?? Date.now(),
    );
    return row === null ? null : {
      customerId: row.customer_id,
      connectionId: row.connection_id,
      objectId: row.id,
      purpose: row.purpose,
    };
  }

  public async consumeGrant(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly token: string;
    readonly now?: number;
  }): Promise<StoredEvidenceObject | null> {
    const db = await this.ready();
    const now = input.now ?? Date.now();
    const candidate = await this.candidate(input.orgId, input.actorId, input.token, now);
    if (candidate === null) return null;
    const tokenSha256 = await sha256Hex(input.token);
    const result = await db.prepare(
      `UPDATE evidence_download_grants
          SET consumed_at = ?
        WHERE id = ? AND org_id = ? AND actor_id = ? AND token_sha256 = ?
          AND consumed_at IS NULL AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM evidence_objects o
             WHERE o.id = evidence_download_grants.object_id
               AND o.org_id = evidence_download_grants.org_id
               AND o.customer_id = evidence_download_grants.customer_id
               AND o.status = 'available' AND o.retention_until > ?
          )`,
    ).bind(
      now,
      candidate.grant_id,
      input.orgId,
      input.actorId,
      tokenSha256,
      now,
      now,
    ).run();
    if ((result.meta?.changes ?? 0) !== 1) return null;
    return candidate;
  }

  /**
   * Internal-only exact read for one sealed FinOps source artifact. The caller
   * must first authenticate the encrypted object id against the complete
   * tenant/source/generation AAD. This repository then independently rebinds
   * the object to the same live organization, customer, connection, snapshot,
   * kind, hash, status, and retention window before returning verified bytes.
   */
  public async readFinopsSourceSnapshot(input: {
    readonly scope: EvidenceScope;
    readonly objectId: string;
    readonly snapshotId: string;
    readonly contentSha256: string;
    readonly now?: number;
  }): Promise<EvidenceStoredObject> {
    assertScope(input.scope);
    if (
      !OBJECT_ID.test(input.objectId)
      || !FINOPS_SNAPSHOT_ID.test(input.snapshotId)
      || !SHA256_HEX.test(input.contentSha256)
    ) reject("INVALID_INPUT");
    const database = await this.ready();
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) reject("INVALID_INPUT");
    const row = await database.prepare(
      `SELECT e.*
         FROM evidence_objects e
         JOIN aws_connections c
           ON c.id = e.connection_id AND c.org_id = e.org_id
          AND c.customer_id = e.customer_id
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id
          AND cu.status = 'active'
        WHERE e.id = ? AND e.org_id = ? AND e.customer_id = ?
          AND e.connection_id = ? AND e.snapshot_id = ?
          AND e.artifact_kind = 'finops_source_snapshot'
          AND e.content_type = 'application/json'
          AND e.content_sha256 = ? AND e.status = 'available'
          AND e.retention_until > ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        LIMIT 1`,
    ).bind(
      input.objectId,
      input.scope.orgId,
      input.scope.customerId,
      input.scope.connectionId,
      input.snapshotId,
      input.contentSha256,
      now,
    ).first<StoredEvidenceObject>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return this.readVerified(row);
  }

  public async readVerified(row: StoredEvidenceObject): Promise<EvidenceStoredObject> {
    if (
      !OBJECT_ID.test(row.id) ||
      !SHA256_HEX.test(row.content_sha256) ||
      row.status !== "available"
    ) reject("OBJECT_CONFLICT");
    if (this.objectStore !== null) {
      try {
        return await this.objectStore.getVerified({
          objectKey: row.object_key,
          contentType: row.content_type,
          contentSha256: row.content_sha256,
          byteSize: Number(row.byte_size),
        });
      } catch (error) {
        if (error instanceof EvidenceObjectStoreError && error.code === "OBJECT_CONFLICT") {
          return reject("OBJECT_CONFLICT");
        }
        return reject("STORAGE_UNAVAILABLE");
      }
    }
    const local = await this.database.prepare(
      `SELECT content_sha256, byte_size, body_base64
         FROM evidence_local_payloads WHERE object_id = ? LIMIT 1`,
    ).bind(row.id).first<{
      content_sha256: string;
      byte_size: number;
      body_base64: string;
    }>();
    if (
      local === null ||
      local.content_sha256 !== row.content_sha256 ||
      Number(local.byte_size) !== Number(row.byte_size)
    ) reject("STORAGE_UNAVAILABLE");
    const body = decodeBase64(local.body_base64);
    if (
      body.byteLength !== Number(row.byte_size) ||
      await sha256Hex(body) !== row.content_sha256
    ) reject("OBJECT_CONFLICT");
    return { body, contentType: row.content_type, contentSha256: row.content_sha256 };
  }
}
