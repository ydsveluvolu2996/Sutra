import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type {
  AwsPartition,
  ConnectionStatus,
  JsonValue,
  PilotConnection,
  PilotCoverageEntry,
  PilotFinding,
  PilotRelationship,
  PilotResource,
  PilotSnapshotPayload,
  PilotState,
  PilotSyncRun,
  SnapshotOrigin,
} from "../lib/pilot-types";
import {
  deriveLocalAwsConnectionIdentity,
  parseIamRoleArn,
  parseSafePilotFailure,
} from "../lib/aws-pilot-security";
import {
  diffCmdbResources,
  toComparableResource,
  type CmdbComparableResource,
  type CmdbResourceChangeType,
} from "../lib/cmdb-change-history";
import { canonicalJson } from "../lib/canonical-json";
import type { AwsRegionSelection } from "../lib/aws-region-selection.ts";
import { LIVE_AWS_RUN_RECLAIM_AFTER_MS } from "../services/aws-collector/src/live-collection-limits";

export const LOCAL_ORG_ID = "org_local_sutra";
export const LOCAL_ORG_SLUG = "local-sutra";
const PILOT_PERMISSION_PACK = "live-demo-2026-07.1";
const OFFBOARDED_EXTERNAL_ID_MARKER = "sutra-offboarded-no-trust-material-v1";
const OFFBOARDED_KEY_VERSION = "offboarded";

export class PilotRepositoryError extends Error {
  public readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "PERSISTENCE_FAILED";

  public constructor(
    code: "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "PERSISTENCE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PilotRepositoryError";
    this.code = code;
  }
}

export interface CreateConnectionDraftInput {
  readonly actorId: string;
  readonly operationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly customerName: string;
  readonly customerSlug: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly enabledRegions: AwsRegionSelection;
  readonly externalIdCiphertext: string;
  readonly externalIdKeyVersion: string;
}

export interface PendingConnectionHandoff {
  readonly connection: PilotConnection;
  readonly externalIdCiphertext: string;
  readonly externalIdKeyVersion: string;
  readonly recovered: boolean;
}

export interface StoredConnectionSecret {
  readonly connectionId: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly externalIdCiphertext: string;
  readonly externalIdKeyVersion: string;
  readonly enabledRegions: AwsRegionSelection;
  readonly status: ConnectionStatus;
}

export interface VerifiedRoleEvidence {
  readonly verified: true;
  readonly accountId: string;
  readonly callerIdentityArn: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
  readonly trustPolicyAttested: true;
  readonly permissionPolicyAttested: true;
  readonly sessionPolicyApplied: true;
  readonly permissionPackVersion: "live-demo-2026-07.1";
}

export interface CommitVerifiedConnectionRoleInput {
  readonly connectionId: string;
  readonly expectedPreviousRoleArn: string | null;
  readonly roleArn: string;
  readonly actorId: string;
  readonly verification: VerifiedRoleEvidence;
}

interface ConnectionRow {
  id: string;
  customer_id: string;
  customer_name: string;
  source_kind: PilotConnection["sourceKind"];
  fixture_id: string | null;
  fixture_version: string | null;
  partition: AwsPartition;
  aws_account_id: string;
  role_arn: string;
  status: ConnectionStatus;
  enabled_regions_json: string;
  permission_pack_version: string;
  last_validated_at: number | null;
  last_successful_sync_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ResourceRow {
  resource_key: string;
  service: string;
  resource_type: string;
  native_id: string;
  arn: string | null;
  name: string | null;
  region_key: string;
  state: string;
  tags_json: string;
  configuration_json: string;
  source_json: string;
  content_sha256: string;
}

interface RelationshipRow {
  from_resource_key: string;
  to_resource_key: string;
  relation_type: string;
  evidence_json: string;
}

interface FindingRow {
  resource_key: string | null;
  control_key: string;
  control_version: string;
  fingerprint: string;
  severity: PilotFinding["severity"];
  snapshot_status: PilotFinding["status"];
  workflow_status: "open" | "acknowledged" | "suppressed" | null;
  title: string;
  summary: string;
  remediation: string;
  evidence_json: string;
  evaluated_at: number;
}

interface SyncRow {
  id: string;
  connection_id: string;
  status: PilotSyncRun["status"];
  coverage_state: PilotSyncRun["coverageState"];
  totals_json: string;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

interface CollectorRunRow {
  collector_key: string;
  region_key: string;
  status: PilotCoverageEntry["status"];
  items_observed: number;
  pages_observed: number;
  error_code: string | null;
  error_message: string | null;
}

interface SnapshotHeadRow {
  id: string;
  collected_at: number;
  status: "complete" | "partial";
  coverage_json: string;
  snapshot_sha256: string;
  origin_kind: SnapshotOrigin["kind"];
  fixture_id: string | null;
  fixture_version: string | null;
}

interface ChangeEventRow {
  id: string;
  from_snapshot_id: string | null;
  to_snapshot_id: string;
  resource_key: string;
  change_type: CmdbResourceChangeType;
  changed_paths_json: string;
  before_json: string | null;
  after_json: string | null;
  occurred_at: number;
}

export interface ChangeHistoryScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly limit?: number;
}

export interface CmdbChangeHistoryEvent {
  readonly id: string;
  readonly fromSnapshotId: string | null;
  readonly toSnapshotId: string;
  readonly resourceKey: string;
  readonly changeType: CmdbResourceChangeType;
  readonly changedPaths: readonly string[];
  readonly before: CmdbComparableResource | null;
  readonly after: CmdbComparableResource | null;
  readonly occurredAt: string;
}

function database(): D1Database {
  return getRawDb();
}

async function readyDatabase(): Promise<D1Database> {
  const db = database();
  await ensureRuntimeSchema(db);
  return db;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toPilotConnection(row: ConnectionRow): PilotConnection {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    sourceKind: row.source_kind,
    fixtureId: row.fixture_id,
    fixtureVersion: row.fixture_version,
    partition: row.partition,
    awsAccountId: row.aws_account_id,
    roleArn: row.role_arn.length > 0 ? row.role_arn : null,
    status: row.status,
    enabledRegions: parseJson<string[]>(row.enabled_regions_json, []),
    permissionPackVersion: row.permission_pack_version,
    lastValidatedAt: iso(row.last_validated_at),
    lastSuccessfulSyncAt: iso(row.last_successful_sync_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function resourceRowToComparable(row: ResourceRow): CmdbComparableResource {
  return {
    resourceKey: row.resource_key,
    service: row.service,
    resourceType: row.resource_type,
    nativeId: row.native_id,
    arn: row.arn,
    name: row.name,
    region: row.region_key,
    state: row.state,
    tags: parseJson<Record<string, string>>(row.tags_json, {}),
    configuration: parseJson<Record<string, JsonValue>>(row.configuration_json, {}),
    contentSha256: row.content_sha256,
  };
}

export function createConnectionDraft(
  input: CreateConnectionDraftInput,
): Promise<PendingConnectionHandoff> {
  return serializeAuditOperation(() => createConnectionDraftWithAtomicAudit(input));
}

async function createConnectionDraftWithAtomicAudit(
  input: CreateConnectionDraftInput,
): Promise<PendingConnectionHandoff> {
  const db = await readyDatabase();
  const now = Date.now();
  const customerId = input.customerId;
  const connectionId = input.connectionId;
  const expectedIdentity = await deriveLocalAwsConnectionIdentity(input.accountId, input.partition);
  if (
    !/^onb_[a-f0-9]{32}$/u.test(input.operationId) ||
    expectedIdentity.customerId !== customerId ||
    expectedIdentity.connectionId !== connectionId
  ) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The local AWS onboarding identity is invalid",
    );
  }
  if (
    input.externalIdCiphertext.length < 20 ||
    input.externalIdCiphertext.length > 2_048 ||
    input.externalIdKeyVersion.length < 1 ||
    input.externalIdKeyVersion.length > 128
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "The onboarding trust secret is invalid");
  }

  const audit = resolveAuditInput({
    actorId: input.actorId,
    action: "aws.connection.created",
    targetType: "aws_connection",
    targetId: connectionId,
    customerId,
    outcome: "allowed",
    metadata: {
      accountId: input.accountId,
      partition: input.partition,
      regions: [...input.enabledRegions],
      customerName: input.customerName,
      customerSlug: input.customerSlug,
      handoffVersion: 1,
    },
    requestId: connectionCreationAuditRequestId(input.operationId),
  });

  const replay = await recoverPendingConnectionHandoff(db, input, audit, true);
  if (replay !== null) return replay;

  const existing = await db.prepare(
    `SELECT id FROM aws_connections WHERE org_id = ? AND partition = ? AND aws_account_id = ? LIMIT 1`,
  ).bind(LOCAL_ORG_ID, input.partition, input.accountId).first<{ id: string }>();
  if (existing !== null) {
    throw new PilotRepositoryError("CONFLICT", "That AWS account already has a local Sutra connection");
  }

  try {
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO organizations (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
      ).bind(LOCAL_ORG_ID, LOCAL_ORG_SLUG, "Sutra local MSP", now),
      db.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(customerId, LOCAL_ORG_ID, input.customerSlug, input.customerName, now, now),
      db.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, partition, aws_account_id, role_arn,
           external_id_ciphertext, external_id_key_version, permission_pack_version,
           status, enabled_regions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(
        connectionId,
        LOCAL_ORG_ID,
        customerId,
        input.partition,
        input.accountId,
        input.externalIdCiphertext,
        input.externalIdKeyVersion,
        PILOT_PERMISSION_PACK,
        JSON.stringify(input.enabledRegions),
        now,
        now,
      ),
      await prepareAuditEventStatement(db, audit),
    ]);
  } catch {
    // A concurrent request or a response-path failure may have committed the
    // exact operation. Only its actor-bound audit record is eligible for
    // recovery; every other conflict fails closed.
    const committed = await recoverPendingConnectionHandoff(db, input, audit, true);
    if (committed !== null) return committed;
    const conflicting = await db.prepare(
      `SELECT id FROM aws_connections
        WHERE org_id = ? AND partition = ? AND aws_account_id = ? LIMIT 1`,
    ).bind(LOCAL_ORG_ID, input.partition, input.accountId).first<{ id: string }>();
    if (conflicting !== null) {
      throw new PilotRepositoryError("CONFLICT", "That AWS account already has a local Sutra connection");
    }
    throw new PilotRepositoryError(
      "PERSISTENCE_FAILED",
      "The connection and its audit evidence could not be committed atomically",
    );
  }

  const created = await recoverPendingConnectionHandoff(db, input, audit, false);
  if (created === null) {
    throw new PilotRepositoryError(
      "PERSISTENCE_FAILED",
      "The connection draft could not be read after creation",
    );
  }
  return created;
}

function connectionCreationAuditRequestId(operationId: string): string {
  return `aws.connection.created:${operationId}`;
}

interface PendingHandoffRow extends ConnectionRow {
  customer_slug: string;
  external_id_ciphertext: string;
  external_id_key_version: string;
}

async function recoverPendingConnectionHandoff(
  db: D1Database,
  input: CreateConnectionDraftInput,
  audit: ResolvedAuditInput,
  recovered: boolean,
): Promise<PendingConnectionHandoff | null> {
  const existingAudit = await findAuditRequest(db, audit.requestId);
  if (existingAudit === null) return null;
  assertMatchingAuditRequest(existingAudit, audit);
  const row = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, cu.slug AS customer_slug,
            c.source_kind, c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.external_id_ciphertext,
            c.external_id_key_version, c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ? AND c.id = ? AND c.customer_id = ?
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, input.connectionId, input.customerId).first<PendingHandoffRow>();
  if (row === null) {
    throw new PilotRepositoryError(
      "PERSISTENCE_FAILED",
      "The audited onboarding operation has no connection record",
    );
  }
  const enabledRegions = parseJson<string[]>(row.enabled_regions_json, []);
  if (
    row.source_kind !== "aws_trust_role" ||
    row.partition !== input.partition ||
    row.aws_account_id !== input.accountId ||
    row.customer_name !== input.customerName ||
    row.customer_slug !== input.customerSlug ||
    JSON.stringify(enabledRegions) !== JSON.stringify(input.enabledRegions)
  ) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The onboarding retry identifier does not match its original connection request",
    );
  }
  if (
    row.status !== "pending" ||
    row.role_arn.length !== 0 ||
    row.external_id_ciphertext === OFFBOARDED_EXTERNAL_ID_MARKER
  ) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The initial ExternalId handoff closed when the customer role was registered",
    );
  }
  return {
    connection: toPilotConnection(row),
    externalIdCiphertext: row.external_id_ciphertext,
    externalIdKeyVersion: row.external_id_key_version,
    recovered,
  };
}

export async function getConnection(connectionId: string): Promise<PilotConnection | null> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, c.source_kind,
            c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ? AND c.id = ?
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, connectionId).first<ConnectionRow>();
  return row === null ? null : toPilotConnection(row);
}

export async function getLatestConnection(): Promise<PilotConnection | null> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, c.source_kind,
            c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ?
      ORDER BY c.created_at DESC
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID).first<ConnectionRow>();
  return row === null ? null : toPilotConnection(row);
}

export function commitVerifiedConnectionRole(
  input: CommitVerifiedConnectionRoleInput,
): Promise<PilotConnection> {
  return serializeAuditOperation(() => commitVerifiedConnectionRoleWithAtomicAudit(input));
}

async function commitVerifiedConnectionRoleWithAtomicAudit(
  input: CommitVerifiedConnectionRoleInput,
): Promise<PilotConnection> {
  const db = await readyDatabase();
  const current = await getConnection(input.connectionId);
  if (current === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (current.status === "disabled") {
    throw new PilotRepositoryError("INVALID_STATE", "A disabled AWS connection cannot be changed");
  }
  if (current.status === "validating") {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The AWS connection changed or has active work; retry role registration after it settles",
    );
  }
  if (current.sourceKind === "simulated_fixture") {
    throw new PilotRepositoryError("INVALID_STATE", "Simulated fixture connections do not accept IAM roles");
  }
  try {
    const parsedRole = parseIamRoleArn(input.roleArn, {
      accountId: current.awsAccountId,
      partition: current.partition,
    });
    if (parsedRole.rolePathAndName !== "sutra/SutraReadOnlyRole") {
      throw new Error("unexpected role path");
    }
  } catch {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The verified IAM role does not match the reviewed Sutra role contract",
    );
  }
  const expectedCallerIdentity = new RegExp(
    `^arn:${current.partition}:sts::${current.awsAccountId}:assumed-role/SutraReadOnlyRole/sutra-[A-Za-z0-9_+=,.@-]+$`,
    "u",
  );
  if (
    input.verification.verified !== true ||
    input.verification.accountId !== current.awsAccountId ||
    !expectedCallerIdentity.test(input.verification.callerIdentityArn) ||
    input.verification.missingExternalIdDenied !== true ||
    input.verification.wrongExternalIdDenied !== true ||
    input.verification.trustPolicyAttested !== true ||
    input.verification.permissionPolicyAttested !== true ||
    input.verification.sessionPolicyApplied !== true ||
    input.verification.permissionPackVersion !== PILOT_PERMISSION_PACK
  ) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The collector trust proof is incomplete or does not match this AWS connection",
    );
  }
  const expectedPreviousRole = input.expectedPreviousRoleArn ?? "";
  const alreadyCommitted = current.roleArn === input.roleArn &&
    current.status === "active" && current.lastValidatedAt !== null;
  if (!alreadyCommitted && (current.roleArn ?? "") !== expectedPreviousRole) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The AWS connection changed while the customer role was being verified",
    );
  }
  const now = nextMutationTimestamp(current);
  const audit = resolveAuditInput({
    actorId: input.actorId,
    action: "aws.connection.role_registered",
    targetType: "aws_connection",
    targetId: input.connectionId,
    customerId: current.customerId,
    outcome: "allowed",
    metadata: {
      roleArn: input.roleArn,
      trustProof: {
        assumeRoleSucceeded: true,
        expectedCallerIdentityMatched: true,
        missingExternalIdDenied: true,
        wrongExternalIdDenied: true,
        exactTrustPolicyAttested: true,
        exactPermissionPolicyAttested: true,
        sessionPolicyApplied: true,
        permissionPackVersion: PILOT_PERMISSION_PACK,
      },
    },
    requestId: `aws.connection.role_verified:${input.connectionId}:${(await sha256Hex(input.roleArn)).slice(0, 32)}`,
  });
  if (await connectionHasActiveWork(db, input.connectionId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The AWS connection changed or has active work; retry role registration after it settles",
    );
  }
  const mutation = db.prepare(
    `UPDATE aws_connections
        SET role_arn = ?, permission_pack_version = ?, status = 'active',
            last_validated_at = ?, updated_at = ?
      WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
        AND status IN ('pending', 'active', 'needs_attention')
        AND role_arn = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs
           WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
        )`,
  ).bind(
    input.roleArn,
    PILOT_PERMISSION_PACK,
    now,
    now,
    LOCAL_ORG_ID,
    input.connectionId,
    expectedPreviousRole,
    LOCAL_ORG_ID,
    input.connectionId,
  );
  return commitAuditedConnectionMutation({
    db,
    connectionId: input.connectionId,
    mutation,
    audit,
    mutationGuard: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND role_arn = ? AND status = 'active'
               AND permission_pack_version = ?
               AND last_validated_at = ? AND updated_at = ?`,
      values: [
        LOCAL_ORG_ID,
        input.connectionId,
        input.roleArn,
        PILOT_PERMISSION_PACK,
        now,
        now,
      ],
    },
    committedState: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND role_arn = ? AND status = 'active'
               AND permission_pack_version = ? AND last_validated_at IS NOT NULL`,
      values: [LOCAL_ORG_ID, input.connectionId, input.roleArn, PILOT_PERMISSION_PACK],
    },
    persistenceMessage: "The verified IAM role and its audit evidence could not be committed atomically",
  });
}

export function disableAwsConnection(
  connectionId: string,
  actorId: string,
): Promise<PilotConnection> {
  return serializeAuditOperation(() => disableAwsConnectionWithAtomicAudit(connectionId, actorId));
}

async function disableAwsConnectionWithAtomicAudit(
  connectionId: string,
  actorId: string,
): Promise<PilotConnection> {
  const db = await readyDatabase();
  const current = await getConnection(connectionId);
  if (current === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (current.sourceKind !== "aws_trust_role") {
    throw new PilotRepositoryError("INVALID_STATE", "Simulated fixture connections use the simulation controls");
  }
  if (current.status === "disabled" && current.roleArn === null) return current;
  if (await connectionHasActiveWork(db, connectionId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "Wait for the active inventory operation to finish before disabling this connection",
    );
  }

  const now = nextMutationTimestamp(current);
  const audit = resolveConnectionDisabledAudit(current, actorId);
  const mutation = db.prepare(
    `UPDATE aws_connections
        SET status = 'disabled', updated_at = ?
      WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
        AND status IN ('pending', 'validating', 'active', 'needs_attention', 'disabled')
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs
           WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
        )`,
  ).bind(now, LOCAL_ORG_ID, connectionId, LOCAL_ORG_ID, connectionId);
  return commitAuditedConnectionMutation({
    db,
    connectionId,
    mutation,
    audit,
    mutationGuard: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND status = 'disabled' AND updated_at = ?`,
      values: [LOCAL_ORG_ID, connectionId, now],
    },
    committedState: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND status = 'disabled'`,
      values: [LOCAL_ORG_ID, connectionId],
    },
    persistenceMessage: "The disabled state and its audit evidence could not be committed atomically",
  });
}

export function offboardAwsConnection(
  connectionId: string,
  actorId: string,
): Promise<PilotConnection> {
  return serializeAuditOperation(() => offboardAwsConnectionWithAtomicAudit(connectionId, actorId));
}

async function offboardAwsConnectionWithAtomicAudit(
  connectionId: string,
  actorId: string,
): Promise<PilotConnection> {
  const db = await readyDatabase();
  const current = await getConnection(connectionId);
  if (current === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (current.sourceKind !== "aws_trust_role") {
    throw new PilotRepositoryError("INVALID_STATE", "Simulated fixture connections use the simulation controls");
  }
  const lifecycle = await db.prepare(
    `SELECT role_arn, external_id_ciphertext
       FROM aws_connections
      WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, connectionId).first<{
    role_arn: string;
    external_id_ciphertext: string;
  }>();
  if (lifecycle === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (
    lifecycle.role_arn.length === 0 &&
    lifecycle.external_id_ciphertext === OFFBOARDED_EXTERNAL_ID_MARKER
  ) {
    const audit = resolveConnectionOffboardedAudit(current, actorId);
    if (await auditRequestAlreadySatisfied(db, audit)) return current;
  }
  if (await connectionHasActiveWork(db, connectionId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "Wait for the active inventory operation to finish before offboarding this connection",
    );
  }

  const now = nextMutationTimestamp(current);
  const audit = resolveConnectionOffboardedAudit(current, actorId);
  const mutation = db.prepare(
    `UPDATE aws_connections
        SET role_arn = '', external_id_ciphertext = ?, external_id_key_version = ?,
            status = 'disabled', updated_at = ?
      WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs
           WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
        )`,
  ).bind(
    OFFBOARDED_EXTERNAL_ID_MARKER,
    OFFBOARDED_KEY_VERSION,
    now,
    LOCAL_ORG_ID,
    connectionId,
    LOCAL_ORG_ID,
    connectionId,
  );
  return commitAuditedConnectionMutation({
    db,
    connectionId,
    mutation,
    audit,
    mutationGuard: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND role_arn = '' AND external_id_ciphertext = ?
               AND external_id_key_version = ? AND status = 'disabled'
               AND updated_at = ?`,
      values: [
        LOCAL_ORG_ID,
        connectionId,
        OFFBOARDED_EXTERNAL_ID_MARKER,
        OFFBOARDED_KEY_VERSION,
        now,
      ],
    },
    committedState: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND role_arn = '' AND external_id_ciphertext = ?
               AND external_id_key_version = ? AND status = 'disabled'`,
      values: [
        LOCAL_ORG_ID,
        connectionId,
        OFFBOARDED_EXTERNAL_ID_MARKER,
        OFFBOARDED_KEY_VERSION,
      ],
    },
    persistenceMessage: "The offboarded trust state and its audit evidence could not be committed atomically",
  });
}

function resolveConnectionDisabledAudit(
  connection: PilotConnection,
  actorId: string,
): ResolvedAuditInput {
  return resolveAuditInput({
    actorId,
    action: "aws.connection.disabled",
    targetType: "aws_connection",
    targetId: connection.id,
    customerId: connection.customerId,
    outcome: "allowed",
    metadata: { accountId: connection.awsAccountId, partition: connection.partition },
    requestId: `aws.connection.disabled:${connection.id}`,
  });
}

function resolveConnectionOffboardedAudit(
  connection: PilotConnection,
  actorId: string,
): ResolvedAuditInput {
  return resolveAuditInput({
    actorId,
    action: "aws.connection.offboarded",
    targetType: "aws_connection",
    targetId: connection.id,
    customerId: connection.customerId,
    outcome: "allowed",
    metadata: {
      accountId: connection.awsAccountId,
      partition: connection.partition,
      cmdbHistoryRetained: true,
      controlPlaneTrustMaterialRemoved: true,
      customerIamRoleRevocationRequired: true,
    },
    requestId: `aws.connection.offboarded:${connection.id}`,
  });
}

interface SqlExistenceGuard {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface AuditedConnectionMutation {
  readonly db: D1Database;
  readonly connectionId: string;
  readonly mutation: D1PreparedStatement;
  readonly audit: ResolvedAuditInput;
  readonly mutationGuard: SqlExistenceGuard;
  readonly committedState: SqlExistenceGuard;
  readonly persistenceMessage: string;
}

function nextMutationTimestamp(connection: PilotConnection): number {
  return Math.max(Date.now(), Date.parse(connection.updatedAt) + 1);
}

async function connectionHasActiveWork(db: D1Database, connectionId: string): Promise<boolean> {
  return await db.prepare(
    `SELECT 1 FROM sync_runs
      WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, connectionId).first() !== null;
}

async function existenceGuardSatisfied(
  db: D1Database,
  guard: SqlExistenceGuard,
): Promise<boolean> {
  return (await db.prepare(guard.sql).bind(...guard.values).first()) !== null;
}

async function recoverAuditedConnectionMutation(
  input: AuditedConnectionMutation,
): Promise<PilotConnection | null> {
  if (!await auditRequestAlreadySatisfied(input.db, input.audit)) return null;
  if (!await existenceGuardSatisfied(input.db, input.committedState)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The audited connection operation is no longer the current connection state",
    );
  }
  return requireUpdatedConnection(
    input.connectionId,
    "AWS connection disappeared after its audited mutation",
  );
}

async function commitAuditedConnectionMutation(
  input: AuditedConnectionMutation,
): Promise<PilotConnection> {
  const replay = await recoverAuditedConnectionMutation(input);
  if (replay !== null) return replay;

  let results: D1Result<unknown>[];
  try {
    results = await input.db.batch([
      input.mutation,
      await prepareAuditEventStatement(input.db, input.audit, true, input.mutationGuard),
    ]);
  } catch {
    const recovered = await recoverAuditedConnectionMutation(input);
    if (recovered !== null) return recovered;
    throw new PilotRepositoryError("PERSISTENCE_FAILED", input.persistenceMessage);
  }

  if (
    (results[0]?.meta?.changes ?? 0) !== 1 ||
    (results[1]?.meta?.changes ?? 0) !== 1
  ) {
    const recovered = await recoverAuditedConnectionMutation(input);
    if (recovered !== null) return recovered;
    throw new PilotRepositoryError("PERSISTENCE_FAILED", input.persistenceMessage);
  }
  const updated = await recoverAuditedConnectionMutation(input);
  if (updated === null) {
    throw new PilotRepositoryError("PERSISTENCE_FAILED", input.persistenceMessage);
  }
  return updated;
}

async function requireUpdatedConnection(connectionId: string, message: string): Promise<PilotConnection> {
  const updated = await getConnection(connectionId);
  if (updated === null) throw new PilotRepositoryError("PERSISTENCE_FAILED", message);
  return updated;
}

export async function getStoredConnectionSecret(connectionId: string): Promise<StoredConnectionSecret> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT id, customer_id, source_kind, partition, aws_account_id, role_arn,
            external_id_ciphertext, external_id_key_version,
            enabled_regions_json, status
       FROM aws_connections
      WHERE org_id = ? AND id = ?
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, connectionId).first<{
    id: string;
    customer_id: string;
    source_kind: PilotConnection["sourceKind"];
    partition: AwsPartition;
    aws_account_id: string;
    role_arn: string;
    external_id_ciphertext: string;
    external_id_key_version: string;
    enabled_regions_json: string;
    status: ConnectionStatus;
  }>();
  if (row === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (row.source_kind === "simulated_fixture") {
    throw new PilotRepositoryError("INVALID_STATE", "Simulated fixture connections have no AWS trust secret");
  }
  if (
    row.status === "disabled" &&
    row.role_arn.length === 0 &&
    row.external_id_ciphertext === OFFBOARDED_EXTERNAL_ID_MARKER
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "The AWS connection has been offboarded");
  }
  return {
    connectionId: row.id,
    customerId: row.customer_id,
    accountId: row.aws_account_id,
    partition: row.partition,
    roleArn: row.role_arn,
    externalIdCiphertext: row.external_id_ciphertext,
    externalIdKeyVersion: row.external_id_key_version,
    enabledRegions: parseJson<string[]>(row.enabled_regions_json, []),
    status: row.status,
  };
}

export async function markConnectionValidating(connectionId: string): Promise<void> {
  const db = await readyDatabase();
  const result = await db.prepare(
    `UPDATE aws_connections SET status = 'validating', updated_at = ?
      WHERE org_id = ? AND id = ? AND status IN ('pending', 'needs_attention', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs
           WHERE org_id = ? AND connection_id = ? AND status = 'running'
        )`,
  ).bind(Date.now(), LOCAL_ORG_ID, connectionId, LOCAL_ORG_ID, connectionId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new PilotRepositoryError("INVALID_STATE", "Connection is not ready for validation");
  }
}

export async function markConnectionValidated(connectionId: string, actorId: string): Promise<void> {
  const db = await readyDatabase();
  const now = Date.now();
  const connection = await getConnection(connectionId);
  if (connection === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  const result = await db.prepare(
    `UPDATE aws_connections
        SET status = 'active', last_validated_at = ?, updated_at = ?
      WHERE org_id = ? AND id = ? AND status = 'validating'`,
  ).bind(now, now, LOCAL_ORG_ID, connectionId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new PilotRepositoryError("INVALID_STATE", "Connection validation result is stale");
  }
  await appendAuditEvent({
    actorId,
    action: "aws.connection.trust_validated",
    targetType: "aws_connection",
    targetId: connectionId,
    customerId: connection.customerId,
    outcome: "allowed",
    metadata: {},
  });
}

export async function markConnectionNeedsAttention(
  connectionId: string,
  actorId: string,
  safeReason: string,
): Promise<void> {
  const db = await readyDatabase();
  const failure = parseSafePilotFailure({ code: safeReason });
  const connection = await getConnection(connectionId);
  if (connection === null) return;
  const result = await db.prepare(
    `UPDATE aws_connections SET status = 'needs_attention', updated_at = ?
      WHERE org_id = ? AND id = ? AND status IN ('validating', 'active')`,
  ).bind(Date.now(), LOCAL_ORG_ID, connectionId).run();
  if ((result.meta?.changes ?? 0) !== 1) return;
  await appendAuditEvent({
    actorId,
    action: "aws.connection.validation_failed",
    targetType: "aws_connection",
    targetId: connectionId,
    customerId: connection.customerId,
    outcome: "failed",
    metadata: { reason: failure.code },
  });
}

export async function createSyncRun(connectionId: string): Promise<string> {
  const db = await readyDatabase();
  const abandonedBefore = Date.now() - LIVE_AWS_RUN_RECLAIM_AFTER_MS;
  await db.batch([
    db.prepare(
      `UPDATE cmdb_snapshots SET status = 'failed', completed_at = ?
        WHERE org_id = ? AND connection_id = ? AND status = 'staging' AND collected_at < ?`,
    ).bind(Date.now(), LOCAL_ORG_ID, connectionId, abandonedBefore),
    db.prepare(
      `UPDATE sync_runs SET status = 'failed', coverage_state = 'unknown',
          totals_json = '{"error":"COLLECTION_FAILED"}', finished_at = ?
        WHERE org_id = ? AND connection_id = ? AND status = 'running' AND created_at < ?`,
    ).bind(Date.now(), LOCAL_ORG_ID, connectionId, abandonedBefore),
  ]);
  const connection = await getConnection(connectionId);
  if (connection === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (connection.status !== "active") {
    throw new PilotRepositoryError("INVALID_STATE", "Validate the AWS connection before running inventory");
  }
  if (connection.sourceKind === "simulated_fixture") {
    throw new PilotRepositoryError("INVALID_STATE", "Run simulated inventory through the durable local jobs workflow");
  }
  const runId = id("sync");
  const now = Date.now();
  let result: D1Result<unknown>;
  try {
    result = await db.prepare(
      `INSERT INTO sync_runs
      (id, org_id, customer_id, connection_id, trigger_kind, status,
       coverage_state, collector_pack_version, totals_json, idempotency_key,
       started_at, created_at)
     SELECT ?, c.org_id, c.customer_id, c.id, 'manual', 'running', 'unknown',
            'aws-pilot-v1', '{}', ?, ?, ?
       FROM aws_connections c
      WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
        AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs r
           WHERE r.org_id = c.org_id AND r.connection_id = c.id
             AND r.status IN ('queued', 'running')
        )`,
    ).bind(
      runId,
      runId,
      now,
      now,
      LOCAL_ORG_ID,
      connection.customerId,
      connectionId,
    ).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique|constraint/iu.test(message)) {
      throw new PilotRepositoryError("CONFLICT", "A sync is already running for this AWS connection");
    }
    throw error;
  }
  if ((result.meta?.changes ?? 0) !== 1) {
    const running = await db.prepare(
      `SELECT id FROM sync_runs
        WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
        LIMIT 1`,
    ).bind(LOCAL_ORG_ID, connectionId).first<{ id: string }>();
    if (running !== null) {
      throw new PilotRepositoryError("CONFLICT", "A sync is already running for this AWS connection");
    }
    throw new PilotRepositoryError("INVALID_STATE", "The AWS connection is no longer active for inventory");
  }
  return runId;
}

export async function failSyncRun(
  runId: string,
  connectionId: string,
  actorId: string,
  safeReason: string,
): Promise<void> {
  const db = await readyDatabase();
  const failure = parseSafePilotFailure({ code: safeReason });
  const now = Date.now();
  const result = await db.prepare(
    `UPDATE sync_runs SET status = 'failed', coverage_state = 'unknown',
        totals_json = ?, finished_at = ?
      WHERE org_id = ? AND id = ? AND connection_id = ? AND status = 'running'`,
  ).bind(JSON.stringify({ error: failure.code }), now, LOCAL_ORG_ID, runId, connectionId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new PilotRepositoryError("INVALID_STATE", "The sync failure result is stale");
  }
  const connection = await getConnection(connectionId);
  await appendAuditEvent({
    actorId,
    action: "aws.sync.failed",
    targetType: "sync_run",
    targetId: runId,
    customerId: connection?.customerId ?? null,
    outcome: "failed",
    metadata: { reason: failure.code },
  });
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function persistSnapshot(
  runId: string,
  payload: PilotSnapshotPayload,
  actorId: string,
  origin: SnapshotOrigin = { kind: "unknown", fixtureId: null, fixtureVersion: null },
  localFixtureJobId: string | null = null,
  localFixtureScheduleId: string | null = null,
): Promise<string> {
  const db = await readyDatabase();
  const connection = await getConnection(payload.connectionId);
  if (connection === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (connection.awsAccountId !== payload.accountId) {
    throw new PilotRepositoryError("PERSISTENCE_FAILED", "Collector payload account does not match the connection");
  }
  if (connection.partition !== payload.partition) {
    throw new PilotRepositoryError("PERSISTENCE_FAILED", "Collector payload partition does not match the connection");
  }
  if (connection.status !== "active") {
    throw new PilotRepositoryError("INVALID_STATE", "The AWS connection is not active for this sync");
  }
  const scopedRun = await db.prepare(
    `SELECT id, idempotency_key, trigger_kind, schedule_id FROM sync_runs
      WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND id = ? AND status = 'running'
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, connection.customerId, payload.connectionId, runId).first<{
    id: string;
    idempotency_key: string;
    trigger_kind: "manual" | "scheduled" | "onboarding";
    schedule_id: string | null;
  }>();
  if (scopedRun === null || scopedRun.idempotency_key !== payload.jobId) {
    throw new PilotRepositoryError("INVALID_STATE", "The collector result does not belong to an active scoped sync");
  }

  let previousSnapshotId: string | null = null;
  let previousResources: readonly CmdbComparableResource[] = [];
  if (payload.coverageState === "complete") {
    const previousHead = await db.prepare(
      `SELECT s.id
         FROM connection_heads h
         JOIN cmdb_snapshots s ON s.id = h.snapshot_id
          AND s.org_id = h.org_id AND s.customer_id = h.customer_id
          AND s.connection_id = h.connection_id AND s.status = 'complete'
        WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
        LIMIT 1`,
    ).bind(LOCAL_ORG_ID, connection.customerId, payload.connectionId).first<{ id: string }>();
    if (previousHead !== null) {
      previousSnapshotId = previousHead.id;
      const previousResult = await db.prepare(
        `SELECT resource_key, service, resource_type, native_id, arn, name,
                region_key, state, tags_json, configuration_json, source_json,
                content_sha256
           FROM cmdb_resources
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND snapshot_id = ?
          ORDER BY resource_key`,
      ).bind(LOCAL_ORG_ID, connection.customerId, payload.connectionId, previousHead.id).all<ResourceRow>();
      previousResources = (previousResult.results ?? []).map(resourceRowToComparable);
    }
  }
  const snapshotId = id("snap");
  const collectedAt = Date.parse(payload.collectedAt);
  const now = Date.now();
  const snapshotStatus = payload.coverageState === "complete" ? "complete" : "partial";
  if (
    (origin.kind !== "unknown" && origin.kind !== "simulated_fixture" && origin.kind !== "aws_sandbox") ||
    (origin.kind === "simulated_fixture" && (!origin.fixtureId || !origin.fixtureVersion)) ||
    (origin.kind !== "simulated_fixture" && (origin.fixtureId !== null || origin.fixtureVersion !== null)) ||
    (origin.kind === "simulated_fixture" && origin.fixtureVersion !== "2026.07.0" && origin.fixtureVersion !== "2026.07.1") ||
    (origin.kind === "simulated_fixture" && localFixtureJobId !== payload.jobId) ||
    (origin.kind !== "simulated_fixture" && localFixtureJobId !== null) ||
    (origin.kind !== "simulated_fixture" && localFixtureScheduleId !== null) ||
    (localFixtureJobId !== null && !/^job_[a-f0-9]{48}$/u.test(localFixtureJobId)) ||
    (localFixtureScheduleId !== null && !/^sched_[a-f0-9]{48}$/u.test(localFixtureScheduleId)) ||
    (localFixtureScheduleId !== null && localFixtureJobId === null) ||
    (localFixtureJobId !== null && (
      localFixtureScheduleId === null
        ? scopedRun.trigger_kind !== "manual" || scopedRun.schedule_id !== null
        : scopedRun.trigger_kind !== "scheduled" || scopedRun.schedule_id !== localFixtureScheduleId
    ))
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "Snapshot origin metadata is inconsistent");
  }
  if (
    (origin.kind === "simulated_fixture" && (
      connection.sourceKind !== "simulated_fixture" ||
      connection.fixtureId !== origin.fixtureId
    )) ||
    (origin.kind !== "simulated_fixture" && connection.sourceKind === "simulated_fixture")
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "Snapshot origin does not match the connection source");
  }
  const resourceChanges = payload.coverageState === "complete"
    ? diffCmdbResources(previousResources, payload.resources.map(toComparableResource))
    : [];

  await db.prepare(
    `INSERT INTO cmdb_snapshots
      (id, org_id, customer_id, connection_id, sync_run_id, status,
       collected_at, coverage_json, summary_json, origin_kind, fixture_id, fixture_version)
     VALUES (?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    snapshotId,
    LOCAL_ORG_ID,
    connection.customerId,
    payload.connectionId,
    runId,
    collectedAt,
    JSON.stringify(payload.coverage),
    JSON.stringify({
      resources: payload.resources.length,
      relationships: payload.relationships.length,
      findings: payload.findings.length,
    }),
    origin.kind,
    origin.fixtureId,
    origin.fixtureVersion,
  ).run();

  for (const group of chunks(payload.resources, 60)) {
    await db.batch(group.map((resource) => db.prepare(
      `INSERT INTO cmdb_resources
        (id, snapshot_id, org_id, customer_id, connection_id, resource_key,
         provider_key, service, resource_type, native_id, arn, name, region_key,
         state, tags_json, configuration_json, source_json, content_sha256,
         collected_at)
       VALUES (?, ?, ?, ?, ?, ?, 'aws', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `${snapshotId}:${resource.resourceKey}`,
      snapshotId,
      LOCAL_ORG_ID,
      connection.customerId,
      payload.connectionId,
      resource.resourceKey,
      resource.service,
      resource.resourceType,
      resource.nativeId,
      resource.arn,
      resource.name,
      resource.region,
      resource.state,
      JSON.stringify(resource.tags),
      JSON.stringify(resource.configuration),
      JSON.stringify(resource.source),
      resource.contentSha256,
      collectedAt,
    )));
  }

  for (const group of chunks(payload.relationships, 80)) {
    await db.batch(group.map((relationship, index) => db.prepare(
      `INSERT INTO cmdb_relationships
        (id, snapshot_id, org_id, customer_id, connection_id,
         from_resource_key, to_resource_key, relation_type, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `${snapshotId}:rel:${relationship.fromResourceKey}:${relationship.toResourceKey}:${relationship.relationType}:${index}`,
      snapshotId,
      LOCAL_ORG_ID,
      connection.customerId,
      payload.connectionId,
      relationship.fromResourceKey,
      relationship.toResourceKey,
      relationship.relationType,
      JSON.stringify(relationship.evidence),
    )));
  }

  for (const group of chunks(payload.findings, 60)) {
    await db.batch(group.map((finding) => db.prepare(
      `INSERT INTO cmdb_findings
        (id, snapshot_id, org_id, customer_id, connection_id, resource_key,
         control_key, control_version, fingerprint, severity, status, title,
         summary, remediation, evidence_json, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `${snapshotId}:finding:${finding.fingerprint}`,
      snapshotId,
      LOCAL_ORG_ID,
      connection.customerId,
      payload.connectionId,
      finding.resourceKey,
      finding.controlKey,
      finding.controlVersion,
      finding.fingerprint,
      finding.severity,
      finding.status,
      finding.title,
      finding.summary,
      finding.remediation,
      JSON.stringify(finding.evidence),
      Date.parse(finding.evaluatedAt),
    )));
  }

  if (payload.coverage.length > 0) {
    await db.batch(payload.coverage.map((coverage) => db.prepare(
      `INSERT INTO collector_runs
        (id, org_id, customer_id, connection_id, sync_run_id, collector_key,
         region_key, status, items_observed, pages_observed, error_code,
         error_message, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `${runId}:${coverage.collectorKey}:${coverage.region}`,
      LOCAL_ORG_ID,
      connection.customerId,
      payload.connectionId,
      runId,
      coverage.collectorKey,
      coverage.region,
      coverage.status,
      coverage.itemsObserved,
      coverage.pagesObserved,
      coverage.errorCode ?? null,
      coverage.message ?? null,
      collectedAt,
      now,
    )));
  }

  // Changes are populated while the target snapshot is staging and only become
  // queryable once the publication batch marks that snapshot complete. Partial
  // observations never enter this table.
  for (const group of chunks(resourceChanges, 60)) {
    await db.batch(group.map((change, index) => db.prepare(
      `INSERT INTO cmdb_change_events
        (id, org_id, customer_id, connection_id, from_snapshot_id,
         to_snapshot_id, resource_key, change_type, changed_paths_json,
         before_json, after_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `${snapshotId}:change:${change.changeType}:${index}:${change.resourceKey}`,
      LOCAL_ORG_ID,
      connection.customerId,
      payload.connectionId,
      previousSnapshotId,
      snapshotId,
      change.resourceKey,
      change.changeType,
      JSON.stringify(change.changedPaths),
      change.before === null ? null : JSON.stringify(change.before),
      change.after === null ? null : JSON.stringify(change.after),
      collectedAt,
    )));
  }

  // A partial observation is useful audit evidence, but it is never promoted to
  // the CMDB projection. This also prevents a first, incomplete collection from
  // presenting itself as an authoritative inventory.
  const shouldPublishHead = payload.coverageState === "complete";
  const publicationStatements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE cmdb_snapshots
          SET status = ?, completed_at = ?, snapshot_sha256 = ?
        WHERE id = ? AND org_id = ? AND status = 'staging'
          AND EXISTS (SELECT 1 FROM sync_runs r WHERE r.id = ? AND r.org_id = ?
            AND r.connection_id = ? AND r.status = 'running')`,
    ).bind(snapshotStatus, now, payload.snapshotSha256, snapshotId, LOCAL_ORG_ID, runId, LOCAL_ORG_ID, payload.connectionId),
  ];
  if (shouldPublishHead) {
    publicationStatements.push(db.prepare(
      `INSERT INTO connection_heads (connection_id, org_id, customer_id, snapshot_id, updated_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sync_runs r WHERE r.id = ? AND r.org_id = ?
          AND r.connection_id = ? AND r.status = 'running')
       ON CONFLICT(connection_id) DO UPDATE SET snapshot_id = excluded.snapshot_id,
         customer_id = excluded.customer_id, updated_at = excluded.updated_at
       WHERE connection_heads.org_id = excluded.org_id`,
    ).bind(payload.connectionId, LOCAL_ORG_ID, connection.customerId, snapshotId, now, runId, LOCAL_ORG_ID, payload.connectionId));
  }
  if (localFixtureJobId !== null && origin.kind === "simulated_fixture") {
    publicationStatements.push(db.prepare(
      `WITH scoped AS (
         SELECT r.org_id, r.customer_id, r.connection_id, r.id AS sync_run_id,
                s.id AS snapshot_id
           FROM sync_runs r
         JOIN cmdb_snapshots s ON s.sync_run_id = r.id
          AND s.org_id = r.org_id AND s.customer_id = r.customer_id
          AND s.connection_id = r.connection_id
         JOIN aws_connections c ON c.id = r.connection_id
          AND c.org_id = r.org_id AND c.customer_id = r.customer_id
          WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ? AND r.connection_id = ?
            AND r.idempotency_key = ? AND r.status = 'running'
            AND s.id = ? AND s.status IN ('complete', 'partial')
            AND s.origin_kind = 'simulated_fixture' AND s.fixture_id = ? AND s.fixture_version = ?
            AND c.source_kind = 'simulated_fixture' AND c.fixture_id = ?
       )
       INSERT INTO local_job_publications
        (job_id, org_id, customer_id, connection_id, sync_run_id, snapshot_id,
         fixture_id, fixture_version, schedule_id, actor_id, published_at)
       SELECT ?, org_id, customer_id, connection_id, sync_run_id, snapshot_id, ?, ?, ?, ?, CAST(? AS BIGINT)
         FROM scoped
       UNION ALL
       SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM scoped)`,
    ).bind(
      runId,
      LOCAL_ORG_ID,
      connection.customerId,
      payload.connectionId,
      payload.jobId,
      snapshotId,
      origin.fixtureId,
      origin.fixtureVersion,
      origin.fixtureId,
      localFixtureJobId,
      origin.fixtureId,
      origin.fixtureVersion,
      localFixtureScheduleId,
      actorId,
      now,
    ));
  }
  publicationStatements.push(db.prepare(
    `UPDATE sync_runs
        SET status = ?, coverage_state = ?, totals_json = ?, finished_at = ?
      WHERE org_id = ? AND id = ? AND connection_id = ? AND status = 'running'`,
  ).bind(
    payload.coverageState === "complete" ? "succeeded" : "partial",
    payload.coverageState,
    JSON.stringify({
      resources: payload.resources.length,
      relationships: payload.relationships.length,
      findings: payload.findings.length,
      collectors: payload.coverage.length,
    }),
    now,
    LOCAL_ORG_ID,
    runId,
    payload.connectionId,
  ));
  publicationStatements.push(payload.coverageState === "complete"
    ? db.prepare(
      `UPDATE aws_connections
          SET status = 'active', last_successful_sync_at = ?, updated_at = ?,
              fixture_version = CASE WHEN source_kind = 'simulated_fixture' THEN ? ELSE fixture_version END
        WHERE org_id = ? AND id = ? AND status = 'active'`,
    ).bind(now, now, origin.fixtureVersion, LOCAL_ORG_ID, payload.connectionId)
    : db.prepare(
      `UPDATE aws_connections
          SET updated_at = ?,
              fixture_version = CASE WHEN source_kind = 'simulated_fixture' THEN ? ELSE fixture_version END
        WHERE org_id = ? AND id = ? AND status = 'active'`,
    ).bind(now, origin.fixtureVersion, LOCAL_ORG_ID, payload.connectionId));

  const publicationAudit: AuditInput = origin.kind === "simulated_fixture" && localFixtureJobId !== null
    ? {
      actorId,
      action: "fixture.job.published",
      targetType: "local_fixture_job",
      targetId: localFixtureJobId,
      customerId: connection.customerId,
      outcome: "allowed",
      metadata: {
        connectionId: payload.connectionId,
        runId,
        coverageState: payload.coverageState,
        resources: payload.resources.length,
        findings: payload.findings.length,
        snapshotId,
        snapshotSha256: payload.snapshotSha256,
        originKind: origin.kind,
        fixtureId: origin.fixtureId ?? "",
        fixtureVersion: origin.fixtureVersion ?? "",
        scheduleId: localFixtureScheduleId ?? "",
      },
    }
    : {
      actorId,
      action: "aws.sync.published",
      targetType: "cmdb_snapshot",
      targetId: snapshotId,
      customerId: connection.customerId,
      outcome: "allowed",
      metadata: {
        connectionId: payload.connectionId,
        runId,
        coverageState: payload.coverageState,
        resources: payload.resources.length,
        findings: payload.findings.length,
        snapshotSha256: payload.snapshotSha256,
        originKind: origin.kind,
      },
    };
  publicationStatements.push(await prepareAuditEventStatement(db, resolveAuditInput(publicationAudit)));

  // This final batch is the publication boundary. Partial runs remain immutable
  // evidence while the last complete projection (if any) stays active. The
  // publication audit event is committed in the same transaction.
  await db.batch(publicationStatements);
  return snapshotId;
}

/** Returns only immutable events matching the complete tenant scope supplied by the caller. */
export async function getChangeHistory(scope: ChangeHistoryScope): Promise<readonly CmdbChangeHistoryEvent[]> {
  const db = await readyDatabase();
  const limit = scope.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new PilotRepositoryError("INVALID_STATE", "Change history limit must be between 1 and 500");
  }

  const result = await db.prepare(
    `SELECT e.id, e.from_snapshot_id, e.to_snapshot_id, e.resource_key,
            e.change_type, e.changed_paths_json, e.before_json, e.after_json,
            e.occurred_at
       FROM cmdb_change_events e
       JOIN cmdb_snapshots s ON s.id = e.to_snapshot_id
        AND s.org_id = e.org_id AND s.customer_id = e.customer_id
        AND s.connection_id = e.connection_id AND s.status = 'complete'
      WHERE e.org_id = ? AND e.customer_id = ? AND e.connection_id = ?
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ?`,
  ).bind(scope.orgId, scope.customerId, scope.connectionId, limit).all<ChangeEventRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    fromSnapshotId: row.from_snapshot_id,
    toSnapshotId: row.to_snapshot_id,
    resourceKey: row.resource_key,
    changeType: row.change_type,
    changedPaths: parseJson<string[]>(row.changed_paths_json, []),
    before: row.before_json === null ? null : parseJson<CmdbComparableResource | null>(row.before_json, null),
    after: row.after_json === null ? null : parseJson<CmdbComparableResource | null>(row.after_json, null),
    occurredAt: new Date(row.occurred_at).toISOString(),
  }));
}

export async function getPilotState(connectionId?: string): Promise<PilotState> {
  const db = await readyDatabase();
  const connection = connectionId === undefined
    ? await getLatestConnection()
    : await getConnection(connectionId);
  if (connection === null) {
    return {
      mode: "empty",
      connection: null,
      resources: [],
      relationships: [],
      findings: [],
      coverage: [],
      latestRunCoverage: null,
      syncRuns: [],
      activeSnapshot: null,
    };
  }

  const head = await db.prepare(
    `SELECT s.id, s.collected_at, s.status, s.coverage_json, s.snapshot_sha256,
            s.origin_kind, s.fixture_id, s.fixture_version
       FROM connection_heads h
       JOIN cmdb_snapshots s ON s.id = h.snapshot_id AND s.connection_id = h.connection_id
      WHERE h.org_id = ? AND h.connection_id = ?
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, connection.id).first<SnapshotHeadRow>();

  const syncResult = await db.prepare(
    `SELECT id, connection_id, status, coverage_state, totals_json,
            started_at, finished_at, created_at
       FROM sync_runs
      WHERE org_id = ? AND connection_id = ?
      ORDER BY created_at DESC
      LIMIT 20`,
  ).bind(LOCAL_ORG_ID, connection.id).all<SyncRow>();
  const syncRuns: PilotSyncRun[] = (syncResult.results ?? []).map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    status: row.status,
    coverageState: row.coverage_state,
    totals: parseJson<Record<string, JsonValue>>(row.totals_json, {}),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: new Date(row.created_at).toISOString(),
  }));
  const latestSyncRun = syncRuns[0];
  const latestCoverageResult = latestSyncRun === undefined
    ? null
    : await db.prepare(
      `SELECT collector_key, region_key, status, items_observed, pages_observed,
              error_code, error_message
         FROM collector_runs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND sync_run_id = ?
        ORDER BY collector_key, region_key`,
    ).bind(
      LOCAL_ORG_ID,
      connection.customerId,
      connection.id,
      latestSyncRun.id,
    ).all<CollectorRunRow>();
  const latestRunCoverage = latestSyncRun === undefined
    ? null
    : {
      syncRunId: latestSyncRun.id,
      entries: (latestCoverageResult?.results ?? []).map((row) => ({
        collectorKey: row.collector_key,
        region: row.region_key,
        status: row.status,
        itemsObserved: row.items_observed,
        pagesObserved: row.pages_observed,
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        ...(row.error_message === null ? {} : { message: row.error_message }),
      })),
    };

  if (head === null) {
    return {
      mode: "live",
      connection,
      resources: [],
      relationships: [],
      findings: [],
      coverage: [],
      latestRunCoverage,
      syncRuns,
      activeSnapshot: null,
    };
  }

  const [resourceResult, relationshipResult, findingResult] = await Promise.all([
    db.prepare(
      `SELECT resource_key, service, resource_type, native_id, arn, name,
              region_key, state, tags_json, configuration_json, source_json,
              content_sha256
         FROM cmdb_resources
        WHERE org_id = ? AND connection_id = ? AND snapshot_id = ?
        ORDER BY service, resource_type, region_key, name, native_id`,
    ).bind(LOCAL_ORG_ID, connection.id, head.id).all<ResourceRow>(),
    db.prepare(
      `SELECT from_resource_key, to_resource_key, relation_type, evidence_json
         FROM cmdb_relationships
        WHERE org_id = ? AND connection_id = ? AND snapshot_id = ?
        ORDER BY relation_type, from_resource_key, to_resource_key`,
    ).bind(LOCAL_ORG_ID, connection.id, head.id).all<RelationshipRow>(),
    db.prepare(
      `SELECT f.resource_key, f.control_key, f.control_version, f.fingerprint,
              f.severity, f.status AS snapshot_status, w.status AS workflow_status,
              f.title, f.summary, f.remediation, f.evidence_json, f.evaluated_at
         FROM cmdb_findings f
         LEFT JOIN finding_workflow_states w
           ON w.org_id = f.org_id AND w.connection_id = f.connection_id
          AND w.fingerprint = f.fingerprint
        WHERE f.org_id = ? AND f.connection_id = ? AND f.snapshot_id = ?
        ORDER BY CASE f.severity
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 ELSE 4 END, f.title`,
    ).bind(LOCAL_ORG_ID, connection.id, head.id).all<FindingRow>(),
  ]);

  const resources: PilotResource[] = (resourceResult.results ?? []).map((row) => ({
    resourceKey: row.resource_key,
    service: row.service,
    resourceType: row.resource_type,
    nativeId: row.native_id,
    arn: row.arn,
    name: row.name,
    region: row.region_key,
    state: row.state,
    tags: parseJson<Record<string, string>>(row.tags_json, {}),
    configuration: parseJson<Record<string, JsonValue>>(row.configuration_json, {}),
    source: parseJson<PilotResource["source"]>(row.source_json, {
      api: "unknown",
      accountId: connection.awsAccountId,
      collectedAt: new Date(head.collected_at).toISOString(),
    }),
    contentSha256: row.content_sha256,
  }));
  const relationships: PilotRelationship[] = (relationshipResult.results ?? []).map((row) => ({
    fromResourceKey: row.from_resource_key,
    toResourceKey: row.to_resource_key,
    relationType: row.relation_type,
    evidence: parseJson<Record<string, JsonValue>>(row.evidence_json, {}),
  }));
  const findings: PilotFinding[] = (findingResult.results ?? []).map((row) => ({
    fingerprint: row.fingerprint,
    resourceKey: row.resource_key,
    controlKey: row.control_key,
    controlVersion: row.control_version,
    severity: row.severity,
    status: row.workflow_status ?? row.snapshot_status,
    title: row.title,
    summary: row.summary,
    remediation: row.remediation,
    evidence: parseJson<Record<string, JsonValue>>(row.evidence_json, {}),
    evaluatedAt: new Date(row.evaluated_at).toISOString(),
  }));

  return {
    mode: "live",
    connection,
    resources,
    relationships,
    findings,
    coverage: parseJson<PilotCoverageEntry[]>(head.coverage_json, []),
    latestRunCoverage,
    syncRuns,
    activeSnapshot: {
      id: head.id,
      collectedAt: new Date(head.collected_at).toISOString(),
      coverageState: head.status,
      snapshotSha256: head.snapshot_sha256,
      origin: {
        kind: head.origin_kind,
        fixtureId: head.fixture_id,
        fixtureVersion: head.fixture_version,
      },
    },
  };
}

export async function setFindingWorkflowStatus(
  connectionId: string,
  fingerprint: string,
  status: "open" | "acknowledged" | "suppressed",
  note: string | null,
  actorId: string,
): Promise<void> {
  const db = await readyDatabase();
  const connection = await getConnection(connectionId);
  if (connection === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  const currentFinding = await db.prepare(
    `SELECT f.fingerprint
       FROM connection_heads h
       JOIN cmdb_findings f ON f.snapshot_id = h.snapshot_id
        AND f.org_id = h.org_id AND f.connection_id = h.connection_id
      WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
        AND f.fingerprint = ?
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, connection.customerId, connectionId, fingerprint).first<{ fingerprint: string }>();
  if (currentFinding === null) {
    throw new PilotRepositoryError("NOT_FOUND", "Finding is not present in the active CMDB snapshot");
  }
  const now = Date.now();
  await db.prepare(
    `INSERT INTO finding_workflow_states
      (id, org_id, customer_id, connection_id, fingerprint, status, note, actor_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, connection_id, fingerprint) DO UPDATE SET
       status = excluded.status, note = excluded.note,
       actor_id = excluded.actor_id, updated_at = excluded.updated_at`,
  ).bind(
    id("fw"),
    LOCAL_ORG_ID,
    connection.customerId,
    connectionId,
    fingerprint,
    status,
    note,
    actorId,
    now,
  ).run();
  await appendAuditEvent({
    actorId,
    action: "finding.workflow.updated",
    targetType: "finding",
    targetId: fingerprint,
    customerId: connection.customerId,
    outcome: "allowed",
    metadata: { status, note: note ?? "" },
  });
}

export interface AuditInput {
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly customerId: string | null;
  readonly outcome: "allowed" | "denied" | "failed";
  readonly metadata: Readonly<Record<string, JsonValue | readonly string[]>>;
  /**
   * A stable caller-supplied idempotency key. Reusing it for the exact same
   * event succeeds; reusing it for different evidence fails closed.
   */
  readonly requestId?: string;
}

let auditAppendTail: Promise<void> = Promise.resolve();
const AUDIT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;

interface StoredAuditRequestRow {
  id: string;
  customer_id: string | null;
  actor_type: "user" | "service" | "system";
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  outcome: "allowed" | "denied" | "failed";
  metadata_json: string;
}

interface ResolvedAuditInput extends AuditInput {
  readonly requestId: string;
  readonly metadataJson: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resolveAuditInput(input: AuditInput): ResolvedAuditInput {
  const requestId = input.requestId ?? crypto.randomUUID();
  if (!AUDIT_REQUEST_ID.test(requestId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The audit request identifier is invalid",
    );
  }
  let metadataJson: string;
  try {
    metadataJson = canonicalJson(input.metadata);
  } catch {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The audit event metadata is not safe JSON",
    );
  }
  return { ...input, requestId, metadataJson };
}

export function appendAuditEvent(input: AuditInput): Promise<void> {
  let resolved: ResolvedAuditInput;
  try {
    resolved = resolveAuditInput(input);
  } catch (error) {
    return Promise.reject(error);
  }
  return serializeAuditOperation(() => appendAuditEventWithRetry(resolved));
}

/**
 * The local process has one audit-chain writer. Connection creation uses this
 * same queue because its audit event is committed in the creation batch.
 */
function serializeAuditOperation<T>(operation: () => Promise<T>): Promise<T> {
  const task = auditAppendTail
    .catch(() => undefined)
    .then(operation);
  auditAppendTail = task.then(() => undefined, () => undefined);
  return task;
}

async function findAuditRequest(
  db: D1Database,
  requestId: string,
): Promise<StoredAuditRequestRow | null> {
  return db.prepare(
    `SELECT id, customer_id, actor_type, actor_id, action, target_type,
            target_id, outcome, metadata_json
       FROM audit_events
      WHERE org_id = ? AND request_id = ?
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID, requestId).first<StoredAuditRequestRow>();
}

function assertMatchingAuditRequest(
  existing: StoredAuditRequestRow,
  input: ResolvedAuditInput,
): void {
  if (
    existing.customer_id !== input.customerId ||
    existing.actor_type !== "user" ||
    existing.actor_id !== input.actorId ||
    existing.action !== input.action ||
    existing.target_type !== input.targetType ||
    existing.target_id !== input.targetId ||
    existing.outcome !== input.outcome ||
    existing.metadata_json !== input.metadataJson
  ) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The audit request identifier was already used for a different event",
    );
  }
}

async function auditRequestAlreadySatisfied(
  db: D1Database,
  input: ResolvedAuditInput,
): Promise<boolean> {
  const existing = await findAuditRequest(db, input.requestId);
  if (existing === null) return false;
  assertMatchingAuditRequest(existing, input);
  return true;
}

async function appendAuditEventWithRetry(input: ResolvedAuditInput): Promise<void> {
  const db = await readyDatabase();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await auditRequestAlreadySatisfied(db, input)) return;
    let result: D1Result<unknown>;
    try {
      result = await (await prepareAuditEventStatement(db, input, false)).run();
    } catch (error) {
      // A concurrent writer can win either the chain head or request-id race.
      // Resolve the latter as an idempotent replay before surfacing the error.
      if (await auditRequestAlreadySatisfied(db, input)) return;
      throw error;
    }
    if ((result.meta?.changes ?? 0) === 1) return;
    if (await auditRequestAlreadySatisfied(db, input)) return;
  }
  throw new PilotRepositoryError(
    "PERSISTENCE_FAILED",
    "The audit chain changed too frequently to append this event safely",
  );
}

async function prepareAuditEventStatement(
  db: D1Database,
  input: ResolvedAuditInput,
  failClosed = true,
  mutationGuard?: SqlExistenceGuard,
): Promise<D1PreparedStatement> {
  const previous = await db.prepare(
    `SELECT event_hash, occurred_at
       FROM audit_events
      WHERE org_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`,
  ).bind(LOCAL_ORG_ID).first<{ event_hash: string; occurred_at: number }>();
  const eventId = id("audit");
  const occurredAt = Math.max(Date.now(), (previous?.occurred_at ?? -1) + 1);
  const requestId = input.requestId;
  const metadataJson = input.metadataJson;
  const previousHash = previous?.event_hash ?? null;
  const eventHash = await sha256Hex(JSON.stringify({
    eventId,
    orgId: LOCAL_ORG_ID,
    customerId: input.customerId,
    occurredAt,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome,
    requestId,
    metadataJson,
    previousHash,
  }));
  const mutationGuardCte = mutationGuard === undefined
    ? `, mutation_guard(valid) AS (SELECT 1)`
    : `, mutation_guard(valid) AS (
       SELECT CASE WHEN EXISTS (${mutationGuard.sql}) THEN 1 ELSE 0 END
     )`;
  const invalidGuard = failClosed
    ? `UNION ALL
     SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL
       FROM chain_guard, mutation_guard
      WHERE chain_guard.valid = 0 OR mutation_guard.valid = 0`
    : "";
  return db.prepare(
    `WITH chain_guard(valid) AS (
       SELECT CASE
         WHEN CAST(? AS TEXT) IS NULL THEN CASE
           WHEN NOT EXISTS (SELECT 1 FROM audit_events WHERE org_id = ?) THEN 1 ELSE 0 END
         WHEN (SELECT event_hash FROM audit_events
                WHERE org_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1) = ? THEN 1
         ELSE 0
       END
     )
     ${mutationGuardCte}
     INSERT INTO audit_events
      (id, org_id, customer_id, occurred_at, actor_type, actor_id, action,
       target_type, target_id, outcome, request_id, metadata_json,
       previous_event_hash, event_hash)
     SELECT ?, ?, ?, CAST(? AS BIGINT), 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM chain_guard, mutation_guard
      WHERE chain_guard.valid = 1 AND mutation_guard.valid = 1
     ${invalidGuard}`,
  ).bind(
    previousHash,
    LOCAL_ORG_ID,
    LOCAL_ORG_ID,
    previousHash,
    ...(mutationGuard?.values ?? []),
    eventId,
    LOCAL_ORG_ID,
    input.customerId,
    occurredAt,
    input.actorId,
    input.action,
    input.targetType,
    input.targetId,
    input.outcome,
    requestId,
    metadataJson,
    previousHash,
    eventHash,
  );
}
