import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { RunnableJob } from "./background-job-runner.ts";
import { parsePilotSnapshot } from "./pilot-boundary.ts";
import { MAX_HOSTED_BROKER_INGEST_BODY_BYTES } from "./hosted-broker-ingest.ts";
import type { CreateSyncRunOptions } from "../db/pilot-repository.ts";
import type { PilotConnection, PilotSnapshotPayload, SnapshotOrigin } from "./pilot-types.ts";

/**
 * The app-side worker for the `hosted.broker.ingest` durable job.
 *
 * A hosted broker collects an AWS account with the SAME collector Sutra runs in
 * local mode and produces the SAME immutable inventory envelope
 * (`sutra.inventory.v1`, see {@link PilotSnapshotPayload}). Because the hosted
 * transport is asymmetric — the broker PUSHES a signed request to
 * `POST /api/hosted/broker/ingest` rather than the app pulling — the ingest
 * route authenticates that request (ed25519 signature + atomic replay guard +
 * fail-closed scope check) and enqueues THIS job carrying the server-derived
 * org/customer scope plus the exact request bytes the broker signed. This
 * handler is the second half: it re-validates those bytes and persists them
 * into the tenant through the same `createSyncRun` -> `persistSnapshot` path the
 * local collector uses.
 *
 * ── The broker request body envelope (defined here) ──────────────────────────
 * The broker's request body IS the JSON serialization of a `PilotSnapshotPayload`
 * (`schemaVersion: "sutra.inventory.v1"`). Its internal `jobId` MUST equal the
 * signed `x-sutra-job-id` (the broker's collector job id, carried as
 * `brokerJobId`), its `connectionId` MUST equal the connection the request was
 * signed for, and its `accountId`/`partition` MUST equal the persisted
 * connection row. All four bindings are enforced by {@link parsePilotSnapshot}
 * against server-resolved state, so a payload can never redirect the write.
 *
 * ── Honesty / safety properties ──────────────────────────────────────────────
 *  - Tenant identity comes STRICTLY from the durable job's scope (`job.orgId`,
 *    `job.customerId`), which the ingest route derived from the persisted
 *    connection row. Nothing tenant-bearing is ever read from the payload.
 *  - The base64 body is bounded, its byte length and SHA-256 are re-checked
 *    against what the broker signed, and the decoded inventory is fully
 *    re-validated. Any malformed / oversized / integrity-mismatched payload
 *    THROWS, so the durable queue applies its own backoff and finally
 *    dead-letters it. A partial or fabricated snapshot is never written.
 */

/** The synthetic actor recorded for a hosted broker-driven publication. */
export const HOSTED_BROKER_INGEST_ACTOR_ID = "system-hosted-broker-ingest";

/** Origin stamped on a hosted broker collection (a real AWS account, no fixture). */
const HOSTED_BROKER_SNAPSHOT_ORIGIN: SnapshotOrigin = {
  kind: "aws_sandbox",
  fixtureId: null,
  fixtureVersion: null,
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** The strictly-validated shape the ingest route enqueues. */
export interface HostedBrokerIngestJobPayload {
  readonly connectionId: string;
  readonly brokerJobId: string;
  readonly keyId: string;
  readonly bodySha256: string;
  readonly byteLength: number;
  readonly bodyBase64: string;
}

export interface HostedBrokerIngestJobDependencies {
  /** Resolve a connection scoped to the tenant org — never re-derived from the payload. */
  readonly getConnection: (orgId: string, connectionId: string) => Promise<PilotConnection | null>;
  /** Open a running sync run for the connection in the tenant org. */
  readonly createSyncRun: (connectionId: string, options: CreateSyncRunOptions) => Promise<string>;
  /** Persist the validated inventory into the tenant org (the shared local path). */
  readonly persistSnapshot: (input: {
    readonly runId: string;
    readonly payload: PilotSnapshotPayload;
    readonly actorId: string;
    readonly origin: SnapshotOrigin;
    readonly orgId: string;
  }) => Promise<string>;
  readonly maximumBodyBytes?: number;
}

export class HostedBrokerIngestJobError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HostedBrokerIngestJobError";
  }
}

function reject(message: string): never {
  throw new HostedBrokerIngestJobError(message);
}

function parseJobPayload(value: unknown): HostedBrokerIngestJobPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("hosted-broker-ingest-payload-invalid");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["connectionId", "brokerJobId", "keyId", "bodySha256", "byteLength", "bodyBase64"];
  const actual = Object.keys(record);
  if (actual.length !== expectedKeys.length || actual.some((key) => !expectedKeys.includes(key))) {
    reject("hosted-broker-ingest-payload-invalid");
  }
  const { connectionId, brokerJobId, keyId, bodySha256, byteLength, bodyBase64 } = record;
  if (
    typeof connectionId !== "string" || !IDENTIFIER.test(connectionId) ||
    typeof brokerJobId !== "string" || !IDENTIFIER.test(brokerJobId) ||
    typeof keyId !== "string" || keyId.length === 0 || keyId.length > 64 ||
    typeof bodySha256 !== "string" || !HEX_SHA256.test(bodySha256) ||
    !Number.isSafeInteger(byteLength) || (byteLength as number) < 0 ||
    typeof bodyBase64 !== "string" || bodyBase64.length === 0 || !BASE64.test(bodyBase64)
  ) {
    reject("hosted-broker-ingest-payload-invalid");
  }
  return {
    connectionId: connectionId as string,
    brokerJobId: brokerJobId as string,
    keyId: keyId as string,
    bodySha256: bodySha256 as string,
    byteLength: byteLength as number,
    bodyBase64: bodyBase64 as string,
  };
}

/**
 * Process ONE `hosted.broker.ingest` job. Deps are injected exactly like
 * {@link runScheduledReportJob} so the scope-safety and validation logic is
 * unit-testable, and so the persistence path is the real repository in
 * production. Throws on any rejection so the durable queue governs retry and
 * dead-lettering — a rejection is never a silent no-op or a partial write.
 */
export async function runHostedBrokerIngestJob(
  job: RunnableJob,
  deps: HostedBrokerIngestJobDependencies,
): Promise<void> {
  // Tenant identity is taken ONLY from the durable job's server-derived scope.
  if (job.customerId === null) reject("hosted-broker-ingest-requires-customer");
  const orgId = job.orgId;
  const envelope = parseJobPayload(job.payload);

  // The bytes the broker signed, re-bounded and integrity-checked here.
  const maximumBodyBytes = deps.maximumBodyBytes ?? MAX_HOSTED_BROKER_INGEST_BODY_BYTES;
  const body = Buffer.from(envelope.bodyBase64, "base64");
  if (body.byteLength === 0 || body.byteLength > maximumBodyBytes || body.byteLength !== envelope.byteLength) {
    reject("hosted-broker-ingest-body-length-mismatch");
  }
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== envelope.bodySha256) reject("hosted-broker-ingest-body-hash-mismatch");

  let candidate: unknown;
  try {
    candidate = JSON.parse(body.toString("utf8"));
  } catch {
    reject("hosted-broker-ingest-body-not-json");
  }

  // Server-state resolution: the connection MUST belong to the job's org and
  // customer, be a real AWS trust connection, and be active. A miss is a
  // wrong-scope rejection — the write can only ever target the owning tenant.
  const connection = await deps.getConnection(orgId, envelope.connectionId);
  if (connection === null) reject("hosted-broker-ingest-connection-unknown");
  if (connection.customerId !== job.customerId) reject("hosted-broker-ingest-scope-mismatch");
  if (connection.sourceKind !== "aws_trust_role") reject("hosted-broker-ingest-connection-not-live");
  if (connection.status !== "active") reject("hosted-broker-ingest-connection-inactive");

  // Full inventory re-validation. jobId is bound to the SIGNED broker job id and
  // connection/account/partition to the resolved server row, so the payload can
  // neither cross tenants nor claim a different account. A failure throws.
  let payload: PilotSnapshotPayload;
  try {
    payload = await parsePilotSnapshot(candidate, {
      jobId: envelope.brokerJobId,
      connectionId: connection.id,
      accountId: connection.awsAccountId,
      partition: connection.partition,
    });
  } catch {
    reject("hosted-broker-ingest-inventory-invalid");
  }

  // Persist through the shared path. The sync run's idempotency key is the
  // broker's signed job id, which persistSnapshot re-checks against payload.jobId.
  const runId = await deps.createSyncRun(connection.id, {
    orgId,
    idempotencyKey: envelope.brokerJobId,
    triggerKind: "scheduled",
  });
  await deps.persistSnapshot({
    runId,
    payload,
    actorId: HOSTED_BROKER_INGEST_ACTOR_ID,
    origin: HOSTED_BROKER_SNAPSHOT_ORIGIN,
    orgId,
  });
}
