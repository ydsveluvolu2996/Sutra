/**
 * Immutable server-owned discovery/outbox for AWS billing deliveries.
 *
 * Only a trusted, signature-verifying control-plane adapter may call
 * recordVerifiedObservation. User-facing routes can resolve an existing id in
 * their exact tenant/customer/connection scope, but cannot write or override
 * manifest coordinates or reconciliation evidence.
 */
import {
  parseFinopsDataExportIngestJobPayload,
  type FinopsDataExportIngestJobPayload,
} from "../lib/finops-data-export-ingest-job.ts";
import type {
  VerifiedHostedBrokerRequest,
} from "../lib/hosted-broker-request-security.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const OBSERVATION_ID = /^fdo_[a-f0-9]{32}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface FinopsDataExportObservationScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface FinopsDataExportProducerAttestation {
  readonly scheme: "hosted-broker-ed25519-v1";
  readonly keyId: string;
  readonly operationId: string;
  readonly nonce: string;
  readonly bodySha256: string;
  readonly observedAtIso: string;
}

export interface FinopsDataExportObservation {
  readonly id: string;
  readonly scope: FinopsDataExportObservationScope;
  readonly payload: FinopsDataExportIngestJobPayload;
  readonly payloadSha256: string;
  readonly attestation: FinopsDataExportProducerAttestation;
  readonly createdAtIso: string;
}

interface ObservationRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  payload_json: string;
  payload_sha256: string;
  producer_key_id: string;
  producer_operation_id: string;
  producer_nonce: string;
  producer_body_sha256: string;
  observed_at: number | string;
  created_at: number | string;
}

export class FinopsDataExportObservationRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "CORRUPT_OBSERVATION";

  public constructor(
    code: FinopsDataExportObservationRepositoryError["code"],
  ) {
    super("FinOps Data Export observation operation rejected");
    this.name = "FinopsDataExportObservationRepositoryError";
    this.code = code;
  }
}

function reject(
  code: FinopsDataExportObservationRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new FinopsDataExportObservationRepositoryError(code);
}

function validScope(scope: FinopsDataExportObservationScope): boolean {
  return scope !== null
    && typeof scope === "object"
    && IDENTIFIER.test(scope.orgId)
    && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId);
}

function validVerification(
  value: VerifiedHostedBrokerRequest,
  scope: FinopsDataExportObservationScope,
): boolean {
  return value !== null
    && typeof value === "object"
    && value.tenantId === scope.orgId
    && value.connectionId === scope.connectionId
    && KEY_ID.test(value.keyId)
    && OPERATION_ID.test(value.jobId)
    && NONCE.test(value.nonce)
    && SHA256.test(value.bodySha256)
    && Number.isSafeInteger(value.timestamp)
    && value.timestamp >= 0;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    copy.buffer,
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function epoch(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("CORRUPT_OBSERVATION");
  return parsed;
}

async function parseStored(
  row: ObservationRow,
  expectedScope: FinopsDataExportObservationScope,
): Promise<FinopsDataExportObservation> {
  if (
    !OBSERVATION_ID.test(row.id)
    || row.org_id !== expectedScope.orgId
    || row.customer_id !== expectedScope.customerId
    || row.connection_id !== expectedScope.connectionId
    || !SHA256.test(row.payload_sha256)
    || !KEY_ID.test(row.producer_key_id)
    || !OPERATION_ID.test(row.producer_operation_id)
    || !NONCE.test(row.producer_nonce)
    || !SHA256.test(row.producer_body_sha256)
  ) reject("CORRUPT_OBSERVATION");
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload_json) as unknown;
  } catch {
    return reject("CORRUPT_OBSERVATION");
  }
  let payload: FinopsDataExportIngestJobPayload;
  try {
    payload = parseFinopsDataExportIngestJobPayload(raw);
  } catch {
    return reject("CORRUPT_OBSERVATION");
  }
  if (
    payload.connectionId !== expectedScope.connectionId
    || await sha256Bytes(encoded(JSON.stringify(payload))) !== row.payload_sha256
  ) reject("CORRUPT_OBSERVATION");
  return {
    id: row.id,
    scope: { ...expectedScope },
    payload,
    payloadSha256: row.payload_sha256,
    attestation: {
      scheme: "hosted-broker-ed25519-v1",
      keyId: row.producer_key_id,
      operationId: row.producer_operation_id,
      nonce: row.producer_nonce,
      bodySha256: row.producer_body_sha256,
      observedAtIso: new Date(epoch(row.observed_at)).toISOString(),
    },
    createdAtIso: new Date(epoch(row.created_at)).toISOString(),
  };
}

export class FinopsDataExportObservationRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  /** Called only after the hosted control plane verifies the producer signature. */
  public async recordVerifiedObservation(input: {
    readonly scope: FinopsDataExportObservationScope;
    /** Exact bytes whose digest/signature were verified by the broker boundary. */
    readonly body: Uint8Array;
    readonly verification: VerifiedHostedBrokerRequest;
  }): Promise<FinopsDataExportObservation> {
    if (
      !validScope(input.scope)
      || !validVerification(input.verification, input.scope)
      || !(input.body instanceof Uint8Array)
      || input.body.byteLength < 2
      || input.body.byteLength > 24 * 1_024
    ) reject();
    if (await sha256Bytes(input.body) !== input.verification.bodySha256) reject();
    let raw: unknown;
    try {
      raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(input.body),
      ) as unknown;
    } catch {
      return reject();
    }
    const payload = parseFinopsDataExportIngestJobPayload(raw);
    if (payload.connectionId !== input.scope.connectionId) reject();
    const payloadJson = JSON.stringify(payload);
    const payloadSha256 = await sha256Bytes(encoded(payloadJson));
    const observedAt = input.verification.timestamp;
    const now = Date.now();
    const id = `fdo_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = this.database;
    await ensureRuntimeSchema(db);
    await db.prepare(
      `INSERT OR IGNORE INTO finops_data_export_observations
        (id, org_id, customer_id, connection_id, payload_json, payload_sha256,
         producer_key_id, producer_operation_id, producer_nonce,
         producer_body_sha256,
         observed_at, created_at)
       SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?
         FROM aws_connections c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
           AND cu.status IN ('active', 'trial')
        WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?
          AND c.status = 'active' AND c.source_kind = 'aws_trust_role'`,
    ).bind(
      id,
      payloadJson,
      payloadSha256,
      input.verification.keyId,
      input.verification.jobId,
      input.verification.nonce,
      input.verification.bodySha256,
      observedAt,
      now,
      input.scope.connectionId,
      input.scope.orgId,
      input.scope.customerId,
    ).run();
    const row = await db.prepare(
      `SELECT * FROM finops_data_export_observations
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND payload_sha256 = ? LIMIT 1`,
    ).bind(
      input.scope.orgId,
      input.scope.customerId,
      input.scope.connectionId,
      payloadSha256,
    ).first<ObservationRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return parseStored(row, input.scope);
  }

  public async getExact(
    scope: FinopsDataExportObservationScope,
    observationId: string,
  ): Promise<FinopsDataExportObservation | null> {
    if (!validScope(scope) || !OBSERVATION_ID.test(observationId)) reject();
    const db = this.database;
    await ensureRuntimeSchema(db);
    const row = await db.prepare(
      `SELECT d.* FROM finops_data_export_observations d
         JOIN organizations o ON o.id = d.org_id AND o.status = 'active'
         JOIN customers cu ON cu.id = d.customer_id AND cu.org_id = d.org_id
           AND cu.status IN ('active', 'trial')
         JOIN aws_connections c ON c.id = d.connection_id
           AND c.org_id = d.org_id AND c.customer_id = d.customer_id
           AND c.status = 'active' AND c.source_kind = 'aws_trust_role'
        WHERE d.id = ? AND d.org_id = ? AND d.customer_id = ?
          AND d.connection_id = ? LIMIT 1`,
    ).bind(
      observationId,
      scope.orgId,
      scope.customerId,
      scope.connectionId,
    ).first<ObservationRow>();
    return row === null ? null : parseStored(row, scope);
  }
}
