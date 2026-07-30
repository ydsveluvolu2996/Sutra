import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  LOCAL_ORG_ID,
  PilotRepositoryError,
  persistSnapshot,
} from "./pilot-repository";
import type {
  LocalFixtureDescriptor,
  LocalFixtureJobResult,
  LocalFixtureVersion,
} from "../lib/local-ops-types";

const LOCAL_FIXTURE_PACK = "sutra-simulated-2026-07";
const JOB_ID = /^job_[a-f0-9]{48}$/u;

interface FixtureConnectionRow {
  id: string;
  org_id: string;
  customer_id: string;
  source_kind: "aws_trust_role" | "simulated_fixture";
  fixture_id: string | null;
  fixture_version: string | null;
  partition: "aws" | "aws-us-gov" | "aws-cn";
  aws_account_id: string;
  status: string;
}

interface CustomerRow {
  id: string;
  org_id: string;
  slug: string;
  status: string;
}

interface SyncRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  trigger_kind: "manual" | "scheduled";
  schedule_id: string | null;
  status: "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
  created_at: number;
}

interface SnapshotRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  sync_run_id: string;
  status: "staging" | "complete" | "partial" | "failed";
  origin_kind: "unknown" | "simulated_fixture" | "aws_live";
  fixture_id: string | null;
  fixture_version: string | null;
}

interface PublicationRow {
  job_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  sync_run_id: string;
  snapshot_id: string;
  fixture_id: string;
  fixture_version: string;
  schedule_id: string | null;
  published_at: number;
}

export interface LocalJobPublication {
  readonly jobId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly syncRunId: string;
  readonly snapshotId: string;
  readonly fixtureId: string;
  readonly fixtureVersion: LocalFixtureVersion;
  readonly scheduleId: string | null;
  readonly publishedAt: string;
}

function database(): D1Database {
  return getRawDb();
}

async function readyDatabase(): Promise<D1Database> {
  const db = database();
  await ensureRuntimeSchema(db);
  return db;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publication(row: PublicationRow): LocalJobPublication {
  return {
    jobId: row.job_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    syncRunId: row.sync_run_id,
    snapshotId: row.snapshot_id,
    fixtureId: row.fixture_id,
    fixtureVersion: row.fixture_version as LocalFixtureVersion,
    scheduleId: row.schedule_id,
    publishedAt: new Date(row.published_at).toISOString(),
  };
}

async function fixtureSlug(fixture: LocalFixtureDescriptor): Promise<string> {
  return `fixture-${(await sha256Hex(fixture.fixtureId)).slice(0, 20)}`;
}

function assertFixtureResult(
  fixture: LocalFixtureDescriptor,
  result: LocalFixtureJobResult,
): void {
  if (
    fixture.tenantId !== LOCAL_ORG_ID ||
    result.tenantId !== LOCAL_ORG_ID ||
    result.fixtureId !== fixture.fixtureId ||
    result.customerId !== fixture.customerId ||
    result.connectionId !== fixture.connectionId ||
    result.job.fixtureId !== fixture.fixtureId ||
    result.job.customerId !== fixture.customerId ||
    result.job.connectionId !== fixture.connectionId ||
    (result.job.triggerKind !== "manual" && result.job.triggerKind !== "scheduled") ||
    (result.job.triggerKind === "manual") !== (result.job.scheduleId === null) ||
    !fixture.availableVersions.includes(result.version) ||
    result.snapshot.coverageState !== "complete" ||
    result.snapshot.connectionId !== fixture.connectionId ||
    result.snapshot.accountId !== fixture.accountId
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "The fixture result does not match its signed workspace scope");
  }
}

async function ensureFixtureConnection(
  db: D1Database,
  fixture: LocalFixtureDescriptor,
  allowProvisioning: boolean,
): Promise<void> {
  const organization = await db.prepare(
    `SELECT id FROM organizations WHERE id = ? AND status = 'active' LIMIT 1`,
  ).bind(LOCAL_ORG_ID).first<{ id: string }>();
  if (organization === null) {
    throw new PilotRepositoryError("INVALID_STATE", "Complete local workspace setup before publishing fixture inventory");
  }

  const slug = await fixtureSlug(fixture);
  const [customerBefore, connectionBefore] = await Promise.all([
    db.prepare(`SELECT id, org_id, slug, status FROM customers WHERE id = ? LIMIT 1`)
      .bind(fixture.customerId).first<CustomerRow>(),
    db.prepare(
      `SELECT id, org_id, customer_id, source_kind, fixture_id, fixture_version,
              partition, aws_account_id, status
         FROM aws_connections WHERE id = ? LIMIT 1`,
    ).bind(fixture.connectionId).first<FixtureConnectionRow>(),
  ]);
  if (
    customerBefore !== null && (
      customerBefore.org_id !== LOCAL_ORG_ID ||
      customerBefore.slug !== slug ||
      customerBefore.status !== "active"
    )
  ) {
    throw new PilotRepositoryError("CONFLICT", "The fixture customer identity conflicts with existing workspace data");
  }
  if (connectionBefore !== null && !isMatchingFixtureConnection(connectionBefore, fixture)) {
    throw new PilotRepositoryError("CONFLICT", "The fixture connection identity conflicts with existing workspace data");
  }

  if ((customerBefore === null || connectionBefore === null) && !allowProvisioning) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "An organization administrator must provision this simulated customer before collection can be published",
    );
  }

  if (customerBefore === null || connectionBefore === null) {
    const now = Date.now();
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO customers
          (id, org_id, slug, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(fixture.customerId, LOCAL_ORG_ID, slug, fixture.customerName, now, now),
      db.prepare(
        `INSERT OR IGNORE INTO aws_connections
          (id, org_id, customer_id, source_kind, fixture_id, fixture_version,
           partition, aws_account_id, role_arn, external_id_ciphertext,
           external_id_key_version, permission_pack_version, status,
           enabled_regions_json, last_validated_at, created_at, updated_at)
         VALUES (?, ?, ?, 'simulated_fixture', ?, NULL, ?, ?, '', '', '', ?, 'active', ?, NULL, ?, ?)`,
      ).bind(
        fixture.connectionId,
        LOCAL_ORG_ID,
        fixture.customerId,
        fixture.fixtureId,
        fixture.partition,
        fixture.accountId,
        LOCAL_FIXTURE_PACK,
        JSON.stringify(fixture.enabledRegions),
        now,
        now,
      ),
    ]);
  }

  const [customer, connection] = await Promise.all([
    db.prepare(`SELECT id, org_id, slug, status FROM customers WHERE id = ? LIMIT 1`)
      .bind(fixture.customerId).first<CustomerRow>(),
    db.prepare(
      `SELECT id, org_id, customer_id, source_kind, fixture_id, fixture_version,
              partition, aws_account_id, status
         FROM aws_connections WHERE id = ? LIMIT 1`,
    ).bind(fixture.connectionId).first<FixtureConnectionRow>(),
  ]);
  if (
    customer === null ||
    customer.org_id !== LOCAL_ORG_ID ||
    customer.slug !== slug ||
    customer.status !== "active"
  ) {
    throw new PilotRepositoryError("CONFLICT", "The fixture customer could not be reserved safely");
  }
  if (connection === null || !isMatchingFixtureConnection(connection, fixture)) {
    throw new PilotRepositoryError("CONFLICT", "The fixture connection could not be reserved safely");
  }
}

function isMatchingFixtureConnection(
  connection: FixtureConnectionRow,
  fixture: LocalFixtureDescriptor,
): boolean {
  return connection.org_id === LOCAL_ORG_ID &&
    connection.customer_id === fixture.customerId &&
    connection.source_kind === "simulated_fixture" &&
    connection.fixture_id === fixture.fixtureId &&
    connection.partition === fixture.partition &&
    connection.aws_account_id === fixture.accountId &&
    connection.status === "active";
}

async function findPublication(
  db: D1Database,
  jobId: string,
): Promise<LocalJobPublication | null> {
  const row = await db.prepare(
    `SELECT job_id, org_id, customer_id, connection_id, sync_run_id,
            snapshot_id, fixture_id, fixture_version, schedule_id, published_at
       FROM local_job_publications
      WHERE org_id = ? AND job_id = ? LIMIT 1`,
  ).bind(LOCAL_ORG_ID, jobId).first<PublicationRow>();
  return row === null ? null : publication(row);
}

async function insertPublication(
  db: D1Database,
  input: {
    readonly jobId: string;
    readonly fixture: LocalFixtureDescriptor;
    readonly version: LocalFixtureVersion;
    readonly syncRunId: string;
    readonly snapshotId: string;
    readonly scheduleId: string | null;
    readonly actorId: string;
  },
): Promise<LocalJobPublication> {
  const now = Date.now();
  await db.prepare(
    `INSERT OR IGNORE INTO local_job_publications
      (job_id, org_id, customer_id, connection_id, sync_run_id, snapshot_id,
       fixture_id, fixture_version, schedule_id, actor_id, published_at)
     SELECT ?, r.org_id, r.customer_id, r.connection_id, r.id, s.id, ?, ?, ?, ?, ?
       FROM sync_runs r
       JOIN cmdb_snapshots s ON s.id = ? AND s.sync_run_id = r.id
        AND s.org_id = r.org_id AND s.customer_id = r.customer_id
        AND s.connection_id = r.connection_id
       JOIN aws_connections c ON c.id = r.connection_id
        AND c.org_id = r.org_id AND c.customer_id = r.customer_id
      WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ? AND r.connection_id = ?
        AND r.idempotency_key = ? AND r.status IN ('succeeded', 'partial')
        AND s.status IN ('complete', 'partial')
        AND s.origin_kind = 'simulated_fixture' AND s.fixture_id = ? AND s.fixture_version = ?
        AND c.source_kind = 'simulated_fixture' AND c.fixture_id = ?`,
  ).bind(
    input.jobId,
    input.fixture.fixtureId,
    input.version,
    input.scheduleId,
    input.actorId,
    now,
    input.snapshotId,
    input.syncRunId,
    LOCAL_ORG_ID,
    input.fixture.customerId,
    input.fixture.connectionId,
    input.jobId,
    input.fixture.fixtureId,
    input.version,
    input.fixture.fixtureId,
  ).run();
  const stored = await findPublication(db, input.jobId);
  if (
    stored === null ||
    stored.customerId !== input.fixture.customerId ||
    stored.connectionId !== input.fixture.connectionId ||
    stored.syncRunId !== input.syncRunId ||
    stored.snapshotId !== input.snapshotId ||
    stored.fixtureId !== input.fixture.fixtureId ||
    stored.fixtureVersion !== input.version ||
    stored.scheduleId !== input.scheduleId
  ) {
    throw new PilotRepositoryError("CONFLICT", "The fixture job publication conflicts with existing workspace data");
  }
  return stored;
}

async function snapshotForRun(db: D1Database, syncRunId: string): Promise<SnapshotRow | null> {
  return db.prepare(
    `SELECT id, org_id, customer_id, connection_id, sync_run_id,
            status, origin_kind, fixture_id, fixture_version
       FROM cmdb_snapshots
      WHERE org_id = ? AND sync_run_id = ? LIMIT 1`,
  ).bind(LOCAL_ORG_ID, syncRunId).first<SnapshotRow>();
}

function assertPublishedSnapshot(
  snapshot: SnapshotRow,
  fixture: LocalFixtureDescriptor,
  version: LocalFixtureVersion,
  syncRunId: string,
): void {
  if (
    snapshot.org_id !== LOCAL_ORG_ID ||
    snapshot.customer_id !== fixture.customerId ||
    snapshot.connection_id !== fixture.connectionId ||
    snapshot.sync_run_id !== syncRunId ||
    (snapshot.status !== "complete" && snapshot.status !== "partial") ||
    snapshot.origin_kind !== "simulated_fixture" ||
    snapshot.fixture_id !== fixture.fixtureId ||
    snapshot.fixture_version !== version
  ) {
    throw new PilotRepositoryError("CONFLICT", "The fixture job sync contains mismatched snapshot evidence");
  }
}

async function recoverAbandonedRun(
  db: D1Database,
  run: SyncRow,
  fixture: LocalFixtureDescriptor,
  version: LocalFixtureVersion,
): Promise<SnapshotRow | null> {
  const snapshot = await snapshotForRun(db, run.id);
  if (run.status === "succeeded" || run.status === "partial") {
    if (snapshot === null) {
      throw new PilotRepositoryError("INVALID_STATE", "The fixture sync completed without immutable snapshot evidence");
    }
    assertPublishedSnapshot(snapshot, fixture, version, run.id);
    return snapshot;
  }
  if (run.status === "running" && Date.now() - run.created_at < 2 * 60 * 1000) {
    throw new PilotRepositoryError("CONFLICT", "This fixture job is already being published");
  }

  if (snapshot !== null) {
    if (snapshot.status === "complete" || snapshot.status === "partial") {
      assertPublishedSnapshot(snapshot, fixture, version, run.id);
      return snapshot;
    }
    await db.batch([
      db.prepare(
        `DELETE FROM cmdb_change_events
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND to_snapshot_id = ?`,
      ).bind(LOCAL_ORG_ID, fixture.customerId, fixture.connectionId, snapshot.id),
      db.prepare(
        `DELETE FROM cmdb_findings
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND snapshot_id = ?`,
      ).bind(LOCAL_ORG_ID, fixture.customerId, fixture.connectionId, snapshot.id),
      db.prepare(
        `DELETE FROM cmdb_relationships
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND snapshot_id = ?`,
      ).bind(LOCAL_ORG_ID, fixture.customerId, fixture.connectionId, snapshot.id),
      db.prepare(
        `DELETE FROM cmdb_resources
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND snapshot_id = ?`,
      ).bind(LOCAL_ORG_ID, fixture.customerId, fixture.connectionId, snapshot.id),
      db.prepare(
        `DELETE FROM collector_runs
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND sync_run_id = ?`,
      ).bind(LOCAL_ORG_ID, fixture.customerId, fixture.connectionId, run.id),
      db.prepare(
        `DELETE FROM cmdb_snapshots
          WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ? AND sync_run_id = ?`,
      ).bind(snapshot.id, LOCAL_ORG_ID, fixture.customerId, fixture.connectionId, run.id),
    ]);
  }
  const reset = await db.prepare(
    `UPDATE sync_runs
        SET status = 'running', coverage_state = 'unknown', totals_json = '{}',
            started_at = ?, finished_at = NULL
      WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
        AND status IN ('running', 'failed', 'cancelled', 'queued')`,
  ).bind(Date.now(), run.id, LOCAL_ORG_ID, fixture.customerId, fixture.connectionId).run();
  if ((reset.meta?.changes ?? 0) !== 1) {
    throw new PilotRepositoryError("CONFLICT", "The fixture sync changed while recovery was in progress");
  }
  return null;
}

export async function publishLocalFixtureJob(input: {
  readonly fixture: LocalFixtureDescriptor;
  readonly result: LocalFixtureJobResult;
  readonly actorId: string;
  readonly allowProvisioning: boolean;
}): Promise<LocalJobPublication> {
  assertFixtureResult(input.fixture, input.result);
  if (!JOB_ID.test(input.result.job.jobId)) {
    throw new PilotRepositoryError("INVALID_STATE", "The fixture job identity is invalid");
  }
  const db = await readyDatabase();
  const existing = await findPublication(db, input.result.job.jobId);
  if (existing !== null) {
    if (
      existing.customerId !== input.fixture.customerId ||
      existing.connectionId !== input.fixture.connectionId ||
      existing.fixtureId !== input.fixture.fixtureId ||
      existing.fixtureVersion !== input.result.version ||
      existing.scheduleId !== input.result.job.scheduleId
    ) {
      throw new PilotRepositoryError("CONFLICT", "The fixture job was already published to another workspace scope");
    }
    return existing;
  }

  await ensureFixtureConnection(db, input.fixture, input.allowProvisioning);
  const syncRunId = `sync_${(await sha256Hex(`local-fixture\u0000${input.result.job.jobId}`)).slice(0, 32)}`;
  const now = Date.now();
  const insertedRun = await db.prepare(
    `INSERT OR IGNORE INTO sync_runs
      (id, org_id, customer_id, connection_id, trigger_kind, schedule_id, status,
       coverage_state, collector_pack_version, totals_json, idempotency_key,
       started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 'unknown', ?, '{}', ?, ?, ?)`,
  ).bind(
    syncRunId,
    LOCAL_ORG_ID,
    input.fixture.customerId,
    input.fixture.connectionId,
    input.result.job.triggerKind,
    input.result.job.scheduleId,
    LOCAL_FIXTURE_PACK,
    input.result.job.jobId,
    now,
    now,
  ).run();
  const run = await db.prepare(
    `SELECT id, org_id, customer_id, connection_id, trigger_kind, schedule_id, status, created_at
       FROM sync_runs
      WHERE org_id = ? AND connection_id = ? AND idempotency_key = ? LIMIT 1`,
  ).bind(LOCAL_ORG_ID, input.fixture.connectionId, input.result.job.jobId).first<SyncRow>();
  if (
    run === null || run.id !== syncRunId || run.org_id !== LOCAL_ORG_ID ||
    run.customer_id !== input.fixture.customerId || run.connection_id !== input.fixture.connectionId ||
    run.trigger_kind !== input.result.job.triggerKind ||
    run.schedule_id !== input.result.job.scheduleId
  ) {
    throw new PilotRepositoryError("CONFLICT", "The fixture job idempotency key conflicts with another sync");
  }

  const recovered = (insertedRun.meta?.changes ?? 0) === 1
    ? null
    : await recoverAbandonedRun(db, run, input.fixture, input.result.version);
  const snapshotId = recovered?.id ?? await persistSnapshot(
    syncRunId,
    input.result.snapshot,
    input.actorId,
    {
      kind: "simulated_fixture",
      fixtureId: input.fixture.fixtureId,
      fixtureVersion: input.result.version,
    },
    input.result.job.jobId,
    input.result.job.scheduleId,
  );
  const stored = await insertPublication(db, {
    jobId: input.result.job.jobId,
    fixture: input.fixture,
    version: input.result.version,
    syncRunId,
    snapshotId,
    scheduleId: input.result.job.scheduleId,
    actorId: input.actorId,
  });
  return stored;
}

export async function getLocalJobPublications(
  orgId: string,
  jobIds: readonly string[],
): Promise<ReadonlyMap<string, LocalJobPublication>> {
  if (orgId !== LOCAL_ORG_ID || jobIds.length > 100 || jobIds.some((jobId) => !JOB_ID.test(jobId))) {
    throw new PilotRepositoryError("INVALID_STATE", "The local publication scope is invalid");
  }
  if (jobIds.length === 0) return new Map();
  const db = await readyDatabase();
  const placeholders = jobIds.map(() => "?").join(", ");
  const result = await db.prepare(
    `SELECT job_id, org_id, customer_id, connection_id, sync_run_id,
            snapshot_id, fixture_id, fixture_version, schedule_id, published_at
       FROM local_job_publications
      WHERE org_id = ? AND job_id IN (${placeholders})`,
  ).bind(orgId, ...jobIds).all<PublicationRow>();
  return new Map((result.results ?? []).map((row) => [row.job_id, publication(row)]));
}
