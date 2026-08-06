import { env } from "cloudflare:workers";
import { isCollectableAwsSourceKind } from "../lib/aws-connection-source.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type {
  AwsPartition,
  AwsPermissionCapabilityAssessment,
  AwsRoleProvisioningMode,
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
  deriveScopedAwsConnectionIdentity,
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
import { isExactDeclaredAwsCapabilityPartition } from "../lib/aws-permission-capabilities.ts";
import { computeAuditEventHash } from "../lib/audit-export.ts";
import { resolveResourceRetirementCompleteMisses } from "../lib/resource-retirement.ts";
import { EvidenceRepository, type EvidenceObjectSummary } from "./evidence-repository.ts";

export const LOCAL_ORG_ID = "org_local_sutra";
export const LOCAL_ORG_SLUG = "local-sutra";
const PILOT_PERMISSION_PACK = "standard-2026-07.4";
export const CURRENT_PILOT_PERMISSION_PACK = PILOT_PERMISSION_PACK;
const OFFBOARDED_EXTERNAL_ID_MARKER = "sutra-offboarded-no-trust-material-v1";
const OFFBOARDED_KEY_VERSION = "offboarded";
const AWS_OWNERSHIP_CONFLICT_MESSAGE = "The AWS ownership claim could not be accepted";

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
  readonly orgId?: string;
  /** Live connection kind. Defaults to the CloudFormation trust-role flow. */
  readonly sourceKind?: "aws_trust_role" | "aws_static_credentials";
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
  readonly roleProvisioningMode: AwsRoleProvisioningMode;
  readonly expectedRolePath: string;
  readonly expectedRoleName: string;
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
  /** Simulated fixtures are rejected before this shape is produced. */
  readonly sourceKind: "aws_trust_role" | "aws_static_credentials";
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly externalIdCiphertext: string;
  readonly externalIdKeyVersion: string;
  readonly enabledRegions: AwsRegionSelection;
  readonly status: ConnectionStatus;
  readonly permissionPackVersion: string;
  readonly roleProvisioningMode: AwsRoleProvisioningMode;
  readonly expectedRolePath: string;
  readonly expectedRoleName: string;
  readonly permissionCapabilities: AwsPermissionCapabilityAssessment | null;
}

export interface VerifiedRoleEvidence {
  readonly verified: true;
  readonly accountId: string;
  readonly roleArn: string;
  readonly roleSessionName: string;
  readonly callerIdentityArn: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
  readonly trustPolicyAttested: true;
  readonly permissionPolicyAttested: true;
  readonly sessionPolicyApplied: true;
  readonly permissionPackVersion: "standard-2026-07.4";
  readonly capabilityAssessment: AwsPermissionCapabilityAssessment;
}

export interface CommitVerifiedConnectionRoleInput {
  readonly orgId?: string;
  readonly connectionId: string;
  readonly expectedPreviousRoleArn: string | null;
  readonly roleArn: string;
  readonly actorId: string;
  readonly verification: VerifiedRoleEvidence;
}

/**
 * Collector proof for a static-credential connection. Contains only credential
 * derivatives (accessKeyLast4, caller identity) — never the secret material.
 */
export interface VerifiedStaticCredentialsEvidence {
  readonly verified: true;
  readonly credentialKind: "static_credentials";
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly callerIdentityArn: string;
  readonly accessKeyLast4: string;
}

export interface CommitVerifiedConnectionCredentialsInput {
  readonly orgId?: string;
  readonly connectionId: string;
  readonly actorId: string;
  readonly verification: VerifiedStaticCredentialsEvidence;
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
  role_provisioning_mode: AwsRoleProvisioningMode;
  expected_role_path: string;
  expected_role_name: string;
  permission_capabilities_json: string | null;
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
  lifecycle_state?: PilotResource["lifecycleState"];
  consecutive_complete_misses?: number;
  evidence_snapshot_id?: string;
  evidence_snapshot_sha256?: string;
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
    roleProvisioningMode: row.role_provisioning_mode,
    expectedRolePath: row.expected_role_path,
    expectedRoleName: row.expected_role_name,
    permissionCapabilities: row.permission_capabilities_json === null
      ? null
      : parseJson<AwsPermissionCapabilityAssessment | null>(row.permission_capabilities_json, null),
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
  const orgId = input.orgId ?? LOCAL_ORG_ID;
  const sourceKind = input.sourceKind ?? "aws_trust_role";
  if (sourceKind !== "aws_trust_role" && sourceKind !== "aws_static_credentials") {
    throw new PilotRepositoryError("INVALID_STATE", "The onboarding connection kind is invalid");
  }
  const roleProvisioningMode = input.roleProvisioningMode ?? "sutra_template";
  const expectedRolePath = input.expectedRolePath ?? "/sutra/";
  const expectedRoleName = input.expectedRoleName ?? "SutraCollectorRole";
  const expectedIdentity = orgId === LOCAL_ORG_ID
    ? await deriveLocalAwsConnectionIdentity(input.accountId, input.partition)
    : await deriveScopedAwsConnectionIdentity(orgId, input.accountId, input.partition);
  if (
    !/^onb_[a-f0-9]{32}$/u.test(input.operationId) ||
    expectedIdentity.customerId !== customerId ||
    expectedIdentity.connectionId !== connectionId
  ) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The AWS onboarding identity is invalid",
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
  if (
    (roleProvisioningMode !== "sutra_template" && roleProvisioningMode !== "customer_managed") ||
    (roleProvisioningMode === "sutra_template" &&
      (expectedRolePath !== "/sutra/" ||
        (expectedRoleName !== "SutraCollectorRole" && expectedRoleName !== "SutraReadOnlyRole"))) ||
    (roleProvisioningMode === "customer_managed" &&
      (expectedRolePath.length > 512 ||
        !/^\/sutra\/(?:[A-Za-z0-9+=,.@_-]+\/)*$/u.test(expectedRolePath) ||
        !/^[A-Za-z0-9+=,.@_-]{1,64}$/u.test(expectedRoleName) ||
        /(admin|poweruser|root|shared|operation|break[-_.]?glass)/iu.test(expectedRoleName) ||
        expectedRoleName.toLowerCase() === "organizationaccountaccessrole"))
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "The onboarding IAM role contract is invalid");
  }

  const audit = resolveAuditInput({
    orgId,
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
      handoffVersion: 2,
      roleProvisioningMode,
      expectedRolePath,
      expectedRoleName,
      // Trust-role drafts keep their pre-existing byte-identical audit payload
      // so committed handoffs remain recoverable across this change; only the
      // new static-credential kind is recorded explicitly.
      ...(sourceKind === "aws_static_credentials" ? { sourceKind } : {}),
    },
    requestId: connectionCreationAuditRequestId(input.operationId),
  });

  const replay = await recoverPendingConnectionHandoff(db, input, audit, true);
  if (replay !== null) return replay;

  if (orgId !== LOCAL_ORG_ID) {
    const organization = await db.prepare(
      `SELECT id FROM organizations WHERE id = ? AND status = 'active' LIMIT 1`,
    ).bind(orgId).first<{ id: string }>();
    if (organization === null) {
      throw new PilotRepositoryError("INVALID_STATE", "The onboarding organization is not active");
    }
  }
  if (await liveAccountOwnershipExists(db, input.partition, input.accountId)) {
    await recordAwsOwnershipCollision({
      db,
      orgId,
      actorId: input.actorId,
      connectionId,
      customerId: null,
      partition: input.partition,
      collisionKind: "account",
      requestId: `security.aws_ownership:${input.operationId}:account`,
    });
    throw new PilotRepositoryError("CONFLICT", AWS_OWNERSHIP_CONFLICT_MESSAGE);
  }

  try {
    const organizationStatement = orgId === LOCAL_ORG_ID
      ? db.prepare(
        `INSERT OR IGNORE INTO organizations (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
      ).bind(LOCAL_ORG_ID, LOCAL_ORG_SLUG, "Sutra local MSP", now)
      : db.prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM organizations WHERE id = ? AND status = 'active'
         ) THEN 1 ELSE NULL END AS organization_active`,
      ).bind(orgId);
    await db.batch([
      organizationStatement,
      db.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(customerId, orgId, input.customerSlug, input.customerName, now, now),
      db.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
           external_id_ciphertext, external_id_key_version, permission_pack_version,
           role_provisioning_mode, expected_role_path, expected_role_name,
           status, enabled_regions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(
        connectionId,
        orgId,
        customerId,
        sourceKind,
        input.partition,
        input.accountId,
        input.externalIdCiphertext,
        input.externalIdKeyVersion,
        PILOT_PERMISSION_PACK,
        roleProvisioningMode,
        expectedRolePath,
        expectedRoleName,
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
    if (await liveAccountOwnershipExists(db, input.partition, input.accountId)) {
      await recordAwsOwnershipCollision({
        db,
        orgId,
        actorId: input.actorId,
        connectionId,
        customerId: null,
        partition: input.partition,
        collisionKind: "account",
        requestId: `security.aws_ownership:${input.operationId}:account`,
      });
      throw new PilotRepositoryError("CONFLICT", AWS_OWNERSHIP_CONFLICT_MESSAGE);
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
  const existingAudit = await findAuditRequest(db, audit.requestId, audit.orgId);
  if (existingAudit === null) return null;
  try {
    assertMatchingAuditRequest(existingAudit, audit);
  } catch (error) {
    const isCanonicalLegacyTemplateRequest =
      (input.roleProvisioningMode ?? "sutra_template") === "sutra_template" &&
      (input.expectedRolePath ?? "/sutra/") === "/sutra/" &&
      ((input.expectedRoleName ?? "SutraCollectorRole") === "SutraCollectorRole" ||
        input.expectedRoleName === "SutraReadOnlyRole");
    if (!isCanonicalLegacyTemplateRequest) throw error;
    // Permission-pack .2 added an explicit role contract to the audit payload.
    // Recover only the exact v1 canonical-template request so a browser retry
    // can complete an already-committed handoff without weakening the actor,
    // account, region, customer, or idempotency binding.
    assertMatchingAuditRequest(existingAudit, resolveAuditInput({
      orgId: input.orgId ?? LOCAL_ORG_ID,
      actorId: input.actorId,
      action: "aws.connection.created",
      targetType: "aws_connection",
      targetId: input.connectionId,
      customerId: input.customerId,
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
    }));
  }
  const row = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, cu.slug AS customer_slug,
            c.source_kind, c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.role_provisioning_mode,
            c.expected_role_path, c.expected_role_name, c.permission_capabilities_json,
            c.external_id_ciphertext,
            c.external_id_key_version, c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ? AND c.id = ? AND c.customer_id = ?
      LIMIT 1`,
  ).bind(input.orgId ?? LOCAL_ORG_ID, input.connectionId, input.customerId).first<PendingHandoffRow>();
  if (row === null) {
    throw new PilotRepositoryError(
      "PERSISTENCE_FAILED",
      "The audited onboarding operation has no connection record",
    );
  }
  const enabledRegions = parseJson<string[]>(row.enabled_regions_json, []);
  if (
    row.source_kind !== (input.sourceKind ?? "aws_trust_role") ||
    row.partition !== input.partition ||
    row.aws_account_id !== input.accountId ||
    row.customer_name !== input.customerName ||
    row.customer_slug !== input.customerSlug ||
    row.role_provisioning_mode !== (input.roleProvisioningMode ?? "sutra_template") ||
    row.expected_role_path !== (input.expectedRolePath ?? "/sutra/") ||
    row.expected_role_name !== (input.expectedRoleName ?? "SutraReadOnlyRole") ||
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

export async function getConnectionForOrg(
  orgId: string,
  connectionId: string,
): Promise<PilotConnection | null> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, c.source_kind,
            c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.role_provisioning_mode,
            c.expected_role_path, c.expected_role_name, c.permission_capabilities_json,
            c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ? AND c.id = ?
      LIMIT 1`,
  ).bind(orgId, connectionId).first<ConnectionRow>();
  return row === null ? null : toPilotConnection(row);
}

export function getConnection(connectionId: string): Promise<PilotConnection | null> {
  return getConnectionForOrg(LOCAL_ORG_ID, connectionId);
}

export async function getLatestConnectionForOrg(orgId: string): Promise<PilotConnection | null> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, c.source_kind,
            c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.role_provisioning_mode,
            c.expected_role_path, c.expected_role_name, c.permission_capabilities_json,
            c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ?
      ORDER BY c.created_at DESC
      LIMIT 1`,
  ).bind(orgId).first<ConnectionRow>();
  return row === null ? null : toPilotConnection(row);
}

/** Resolve the latest connection only inside an authenticated org+customer scope. */
export async function getLatestConnectionForCustomer(
  orgId: string,
  customerId: string,
): Promise<PilotConnection | null> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, c.source_kind,
            c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.role_provisioning_mode,
            c.expected_role_path, c.expected_role_name, c.permission_capabilities_json,
            c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ? AND c.customer_id = ?
      ORDER BY c.created_at DESC, c.id ASC
      LIMIT 1`,
  ).bind(orgId, customerId).first<ConnectionRow>();
  return row === null ? null : toPilotConnection(row);
}

export function getLatestConnection(): Promise<PilotConnection | null> {
  return getLatestConnectionForOrg(LOCAL_ORG_ID);
}

/**
 * Read-only, org-scoped listing of every AWS connection in an organization,
 * across all of its customers. This is the org/MSP-level counterpart to
 * {@link getConnectionForOrg} (single connection) and is used by the
 * cross-customer showback view, which aggregates already-persisted billing
 * lines grouped by customer. Every lifecycle status is returned: billing lines
 * survive a connection being disabled or offboarded, so a showback over
 * historical spend must still see those connections. Tenant-scoped by org_id;
 * rows are mapped through the same {@link toPilotConnection} mapper the
 * single-connection getters use.
 */
export async function listConnectionsForOrg(orgId: string): Promise<readonly PilotConnection[]> {
  const db = await readyDatabase();
  const rows = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, c.source_kind,
            c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.role_provisioning_mode,
            c.expected_role_path, c.expected_role_name, c.permission_capabilities_json,
            c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
      WHERE c.org_id = ?
      ORDER BY c.created_at DESC, c.id ASC`,
  ).bind(orgId).all<ConnectionRow>();
  return (rows.results ?? []).map(toPilotConnection);
}

/**
 * Bounded server-owned member-account discovery for ADV-01. This is narrower
 * than the org-wide administrative listing: only runnable commercial AWS
 * connections for one exact customer and permission pack are returned.
 * LIMIT 10001 lets the orchestration reject an organization beyond its 10k
 * account evidence bound without loading an unbounded result.
 */
export async function listActiveAwsConnectionsForCustomer(
  orgId: string,
  customerId: string,
  permissionPackVersion: string,
): Promise<readonly PilotConnection[]> {
  const db = await readyDatabase();
  const rows = await db.prepare(
    `SELECT c.id, c.customer_id, cu.name AS customer_name, c.source_kind,
            c.fixture_id, c.fixture_version, c.partition,
            c.aws_account_id, c.role_arn, c.status, c.enabled_regions_json,
            c.permission_pack_version, c.role_provisioning_mode,
            c.expected_role_path, c.expected_role_name, c.permission_capabilities_json,
            c.last_validated_at,
            c.last_successful_sync_at, c.created_at, c.updated_at
       FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu
         ON cu.id = c.customer_id AND cu.org_id = c.org_id
        AND cu.status IN ('active', 'trial')
      WHERE c.org_id = ? AND c.customer_id = ?
        AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        AND c.partition = 'aws' AND c.permission_pack_version = ?
      ORDER BY c.aws_account_id ASC, c.id ASC
      LIMIT 10001`,
  ).bind(orgId, customerId, permissionPackVersion).all<ConnectionRow>();
  return (rows.results ?? []).map(toPilotConnection);
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
  const orgId = input.orgId ?? LOCAL_ORG_ID;
  const current = await getConnectionForOrg(orgId, input.connectionId);
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
  let parsedRole;
  try {
    parsedRole = parseIamRoleArn(input.roleArn, {
      accountId: current.awsAccountId,
      partition: current.partition,
    });
    const expectedPathAndName = `${current.expectedRolePath.slice(1)}${current.expectedRoleName}`;
    if (parsedRole.rolePathAndName !== expectedPathAndName) {
      throw new Error("unexpected role path");
    }
  } catch {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The verified IAM role does not match the reviewed Sutra role contract",
    );
  }
  const roleSessionName = input.verification.roleSessionName;
  const expectedCallerIdentity =
    `arn:${current.partition}:sts::${current.awsAccountId}:assumed-role/${parsedRole.roleName}/${roleSessionName}`;
  const grantedActions = [...input.verification.capabilityAssessment.grantedActions].sort();
  const missingActions = [...input.verification.capabilityAssessment.missingActions].sort();
  const capabilityAssessmentIsSafe =
    isExactDeclaredAwsCapabilityPartition(grantedActions, missingActions) &&
    (current.roleProvisioningMode !== "sutra_template" || missingActions.length === 0);
  if (
    input.verification.verified !== true ||
    input.verification.accountId !== current.awsAccountId ||
    input.verification.roleArn !== input.roleArn ||
    !/^[A-Za-z0-9_+=,.@-]{2,64}$/u.test(roleSessionName) ||
    !roleSessionName.startsWith("sutra-") ||
    input.verification.callerIdentityArn !== expectedCallerIdentity ||
    input.verification.missingExternalIdDenied !== true ||
    input.verification.wrongExternalIdDenied !== true ||
    input.verification.trustPolicyAttested !== true ||
    input.verification.permissionPolicyAttested !== true ||
    input.verification.sessionPolicyApplied !== true ||
    input.verification.permissionPackVersion !== PILOT_PERMISSION_PACK ||
    !capabilityAssessmentIsSafe
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
  const permissionCapabilitiesJson = canonicalJson({ grantedActions, missingActions });
  // A role can be re-attested without changing its ARN (for example after the
  // customer adds a previously missing read capability). Bind the audit
  // idempotency key to the complete actor-scoped role contract so an exact
  // replay remains stable while a real capability change receives a new key.
  const roleRegistrationRevision = await sha256Hex(canonicalJson({
    actorId: input.actorId,
    roleArn: input.roleArn,
    permissionPackVersion: PILOT_PERMISSION_PACK,
    capabilityAssessment: { grantedActions, missingActions },
  }));
  const roleCollisionRequestId =
    `security.aws_ownership:${input.connectionId}:${roleRegistrationRevision.slice(0, 32)}:role`;
  if (await liveRoleOwnershipExists(db, input.roleArn, input.connectionId)) {
    await recordAwsOwnershipCollision({
      db,
      orgId,
      actorId: input.actorId,
      connectionId: input.connectionId,
      customerId: current.customerId,
      partition: current.partition,
      collisionKind: "role",
      requestId: roleCollisionRequestId,
    });
    throw new PilotRepositoryError("CONFLICT", AWS_OWNERSHIP_CONFLICT_MESSAGE);
  }
  const audit = resolveAuditInput({
    orgId,
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
        capabilityAssessment: { grantedActions, missingActions },
      },
    },
    requestId: `aws.connection.role_verified:${input.connectionId}:${roleRegistrationRevision.slice(0, 32)}`,
  });
  if (await connectionHasActiveWork(db, input.connectionId, orgId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The AWS connection changed or has active work; retry role registration after it settles",
    );
  }
  const mutation = db.prepare(
    `UPDATE aws_connections
        SET role_arn = ?, permission_pack_version = ?, permission_capabilities_json = ?, status = 'active',
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
    permissionCapabilitiesJson,
    now,
    now,
    orgId,
    input.connectionId,
    expectedPreviousRole,
    orgId,
    input.connectionId,
  );
  try {
    return await commitAuditedConnectionMutation({
      db,
      connectionId: input.connectionId,
      mutation,
      audit,
      mutationGuard: {
        sql: `SELECT 1 FROM aws_connections
               WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
                 AND role_arn = ? AND status = 'active'
                 AND permission_pack_version = ? AND permission_capabilities_json = ?
                 AND last_validated_at = ? AND updated_at = ?`,
        values: [
          orgId,
          input.connectionId,
          input.roleArn,
          PILOT_PERMISSION_PACK,
          permissionCapabilitiesJson,
          now,
          now,
        ],
      },
      committedState: {
        sql: `SELECT 1 FROM aws_connections
               WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
                 AND role_arn = ? AND status = 'active'
                 AND permission_pack_version = ? AND permission_capabilities_json = ?
                 AND last_validated_at IS NOT NULL`,
        values: [orgId, input.connectionId, input.roleArn, PILOT_PERMISSION_PACK, permissionCapabilitiesJson],
      },
      persistenceMessage: "The verified IAM role and its audit evidence could not be committed atomically",
    });
  } catch (error) {
    if (await liveRoleOwnershipExists(db, input.roleArn, input.connectionId)) {
      await recordAwsOwnershipCollision({
        db,
        orgId,
        actorId: input.actorId,
        connectionId: input.connectionId,
        customerId: current.customerId,
        partition: current.partition,
        collisionKind: "role",
        requestId: roleCollisionRequestId,
      });
      throw new PilotRepositoryError("CONFLICT", AWS_OWNERSHIP_CONFLICT_MESSAGE);
    }
    throw error;
  }
}

export function commitVerifiedConnectionCredentials(
  input: CommitVerifiedConnectionCredentialsInput,
): Promise<PilotConnection> {
  return serializeAuditOperation(() => commitVerifiedConnectionCredentialsWithAtomicAudit(input));
}

/**
 * Durable activation commit for a verified static-credential connection.
 * Mirrors {@link commitVerifiedConnectionRoleWithAtomicAudit}: the connection
 * mutation and its audit evidence land in one atomic batch, replays recover
 * through the audit idempotency key, and no credential value — access key,
 * secret, or session token — is EVER written to any database column. The only
 * credential derivative persisted is accessKeyLast4 inside audit metadata.
 */
async function commitVerifiedConnectionCredentialsWithAtomicAudit(
  input: CommitVerifiedConnectionCredentialsInput,
): Promise<PilotConnection> {
  const db = await readyDatabase();
  const orgId = input.orgId ?? LOCAL_ORG_ID;
  const current = await getConnectionForOrg(orgId, input.connectionId);
  if (current === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (current.status === "disabled") {
    throw new PilotRepositoryError("INVALID_STATE", "A disabled AWS connection cannot be changed");
  }
  if (current.status === "validating") {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The AWS connection changed or has active work; retry credential registration after it settles",
    );
  }
  if (current.sourceKind !== "aws_static_credentials") {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "Only static-credential AWS connections accept static credentials",
    );
  }
  if (
    input.verification.verified !== true ||
    input.verification.credentialKind !== "static_credentials" ||
    input.verification.accountId !== current.awsAccountId ||
    input.verification.partition !== current.partition ||
    !/^[A-Z0-9]{4}$/u.test(input.verification.accessKeyLast4) ||
    typeof input.verification.callerIdentityArn !== "string" ||
    input.verification.callerIdentityArn.length > 2_048 ||
    !new RegExp(
      `^arn:${current.partition}:(?:iam|sts)::${current.awsAccountId}:[A-Za-z0-9_+=,.@/-]{1,512}$`,
      "u",
    ).test(input.verification.callerIdentityArn)
  ) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The collector credential proof is incomplete or does not match this AWS connection",
    );
  }
  const now = nextMutationTimestamp(current);
  // The same credentials can be re-attested, and rotated keys arrive with a
  // different accessKeyLast4/caller identity. Bind the audit idempotency key
  // to the complete actor-scoped proof so an exact replay stays stable while
  // a real credential change receives a new key.
  const credentialRegistrationRevision = await sha256Hex(canonicalJson({
    actorId: input.actorId,
    accessKeyLast4: input.verification.accessKeyLast4,
    callerIdentityArn: input.verification.callerIdentityArn,
  }));
  const audit = resolveAuditInput({
    orgId,
    actorId: input.actorId,
    action: "aws.connection.credentials_registered",
    targetType: "aws_connection",
    targetId: input.connectionId,
    customerId: current.customerId,
    outcome: "allowed",
    metadata: {
      credentialKind: "static_credentials",
      accessKeyLast4: input.verification.accessKeyLast4,
      callerIdentityArn: input.verification.callerIdentityArn,
      credentialsStoredInControlPlane: false,
    },
    requestId: `aws.connection.credentials_verified:${input.connectionId}:${credentialRegistrationRevision.slice(0, 32)}`,
  });
  if (await connectionHasActiveWork(db, input.connectionId, orgId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The AWS connection changed or has active work; retry credential registration after it settles",
    );
  }
  const mutation = db.prepare(
    `UPDATE aws_connections
        SET status = 'active', last_validated_at = ?, updated_at = ?
      WHERE org_id = ? AND id = ? AND source_kind = 'aws_static_credentials'
        AND status IN ('pending', 'active', 'needs_attention')
        AND role_arn = ''
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs
           WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
        )`,
  ).bind(
    now,
    now,
    orgId,
    input.connectionId,
    orgId,
    input.connectionId,
  );
  return commitAuditedConnectionMutation({
    db,
    connectionId: input.connectionId,
    mutation,
    audit,
    mutationGuard: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_static_credentials'
               AND role_arn = '' AND status = 'active'
               AND last_validated_at = ? AND updated_at = ?`,
      values: [orgId, input.connectionId, now, now],
    },
    committedState: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_static_credentials'
               AND role_arn = '' AND status = 'active'
               AND last_validated_at IS NOT NULL`,
      values: [orgId, input.connectionId],
    },
    persistenceMessage: "The verified static credentials and their audit evidence could not be committed atomically",
  });
}

export function disableAwsConnection(
  connectionId: string,
  actorId: string,
  orgId: string,
): Promise<PilotConnection> {
  return serializeAuditOperation(() => disableAwsConnectionWithAtomicAudit(connectionId, actorId, orgId));
}

async function disableAwsConnectionWithAtomicAudit(
  connectionId: string,
  actorId: string,
  orgId: string,
): Promise<PilotConnection> {
  const db = await readyDatabase();
  const current = await getConnectionForOrg(orgId, connectionId);
  if (current === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (!isCollectableAwsSourceKind(current.sourceKind)) {
    throw new PilotRepositoryError("INVALID_STATE", "Simulated fixture connections use the simulation controls");
  }
  if (current.status === "disabled" && current.roleArn === null) return current;
  if (await connectionHasActiveWork(db, connectionId, orgId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "Wait for the active inventory operation to finish before disabling this connection",
    );
  }

  const now = nextMutationTimestamp(current);
  const audit = resolveConnectionDisabledAudit(current, actorId, orgId);
  const mutation = db.prepare(
    `UPDATE aws_connections
        SET status = 'disabled', updated_at = ?
      WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
        AND status IN ('pending', 'validating', 'active', 'needs_attention', 'disabled')
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs
           WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
        )`,
  ).bind(now, orgId, connectionId, orgId, connectionId);
  return commitAuditedConnectionMutation({
    db,
    connectionId,
    mutation,
    audit,
    mutationGuard: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND status = 'disabled' AND updated_at = ?`,
      values: [orgId, connectionId, now],
    },
    committedState: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
               AND status = 'disabled'`,
      values: [orgId, connectionId],
    },
    persistenceMessage: "The disabled state and its audit evidence could not be committed atomically",
  });
}

export function offboardAwsConnection(
  connectionId: string,
  actorId: string,
  orgId: string,
): Promise<PilotConnection> {
  return serializeAuditOperation(() => offboardAwsConnectionWithAtomicAudit(connectionId, actorId, orgId));
}

async function offboardAwsConnectionWithAtomicAudit(
  connectionId: string,
  actorId: string,
  orgId: string,
): Promise<PilotConnection> {
  const db = await readyDatabase();
  const current = await getConnectionForOrg(orgId, connectionId);
  if (current === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (!isCollectableAwsSourceKind(current.sourceKind)) {
    throw new PilotRepositoryError("INVALID_STATE", "Simulated fixture connections use the simulation controls");
  }
  const lifecycle = await db.prepare(
    `SELECT role_arn, external_id_ciphertext
       FROM aws_connections
      WHERE org_id = ? AND id = ? AND source_kind = 'aws_trust_role'
      LIMIT 1`,
  ).bind(orgId, connectionId).first<{
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
    const audit = resolveConnectionOffboardedAudit(current, actorId, orgId);
    if (await auditRequestAlreadySatisfied(db, audit)) return current;
  }
  if (await connectionHasActiveWork(db, connectionId, orgId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "Wait for the active inventory operation to finish before offboarding this connection",
    );
  }

  const now = nextMutationTimestamp(current);
  const audit = resolveConnectionOffboardedAudit(current, actorId, orgId);
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
    orgId,
    connectionId,
    orgId,
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
        orgId,
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
        orgId,
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
  orgId: string,
): ResolvedAuditInput {
  return resolveAuditInput({
    orgId,
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
  orgId: string,
): ResolvedAuditInput {
  return resolveAuditInput({
    orgId,
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

export interface SqlExistenceGuard {
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

async function connectionHasActiveWork(
  db: D1Database,
  connectionId: string,
  orgId: string,
): Promise<boolean> {
  return await db.prepare(
    `SELECT 1 FROM sync_runs
      WHERE org_id = ? AND connection_id = ? AND status IN ('queued', 'running')
      LIMIT 1`,
  ).bind(orgId, connectionId).first() !== null;
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
    input.audit.orgId,
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

async function requireUpdatedConnection(
  connectionId: string,
  message: string,
  orgId: string,
): Promise<PilotConnection> {
  const updated = await getConnectionForOrg(orgId, connectionId);
  if (updated === null) throw new PilotRepositoryError("PERSISTENCE_FAILED", message);
  return updated;
}

export async function getStoredConnectionSecretForOrg(
  orgId: string,
  connectionId: string,
): Promise<StoredConnectionSecret> {
  const db = await readyDatabase();
  const row = await db.prepare(
    `SELECT id, customer_id, source_kind, partition, aws_account_id, role_arn,
            external_id_ciphertext, external_id_key_version,
            enabled_regions_json, status, permission_pack_version,
            role_provisioning_mode, expected_role_path, expected_role_name,
            permission_capabilities_json
       FROM aws_connections
      WHERE org_id = ? AND id = ?
      LIMIT 1`,
  ).bind(orgId, connectionId).first<{
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
    permission_pack_version: string;
    role_provisioning_mode: AwsRoleProvisioningMode;
    expected_role_path: string;
    expected_role_name: string;
    permission_capabilities_json: string | null;
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
    sourceKind: row.source_kind,
    accountId: row.aws_account_id,
    partition: row.partition,
    roleArn: row.role_arn,
    externalIdCiphertext: row.external_id_ciphertext,
    externalIdKeyVersion: row.external_id_key_version,
    enabledRegions: parseJson<string[]>(row.enabled_regions_json, []),
    status: row.status,
    permissionPackVersion: row.permission_pack_version,
    roleProvisioningMode: row.role_provisioning_mode,
    expectedRolePath: row.expected_role_path,
    expectedRoleName: row.expected_role_name,
    permissionCapabilities: row.permission_capabilities_json === null
      ? null
      : parseJson<AwsPermissionCapabilityAssessment | null>(row.permission_capabilities_json, null),
  };
}

export function getStoredConnectionSecret(connectionId: string): Promise<StoredConnectionSecret> {
  return getStoredConnectionSecretForOrg(LOCAL_ORG_ID, connectionId);
}

export async function markConnectionValidating(
  connectionId: string,
  orgId: string,
): Promise<void> {
  const db = await readyDatabase();
  const result = await db.prepare(
    `UPDATE aws_connections SET status = 'validating', updated_at = ?
      WHERE org_id = ? AND id = ? AND status IN ('pending', 'needs_attention', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs
           WHERE org_id = ? AND connection_id = ? AND status = 'running'
        )`,
  ).bind(Date.now(), orgId, connectionId, orgId, connectionId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new PilotRepositoryError("INVALID_STATE", "Connection is not ready for validation");
  }
}

export async function markConnectionValidated(
  connectionId: string,
  actorId: string,
  verification: VerifiedRoleEvidence,
  orgId: string,
): Promise<void> {
  const db = await readyDatabase();
  const now = Date.now();
  const connection = await getConnectionForOrg(orgId, connectionId);
  if (connection === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  let parsedRole;
  try {
    if (connection.sourceKind !== "aws_trust_role" || connection.roleArn === null) {
      throw new Error("connection has no AWS role");
    }
    parsedRole = parseIamRoleArn(connection.roleArn, {
      accountId: connection.awsAccountId,
      partition: connection.partition,
    });
    if (parsedRole.rolePathAndName !== `${connection.expectedRolePath.slice(1)}${connection.expectedRoleName}`) {
      throw new Error("connection role does not match its contract");
    }
  } catch {
    throw new PilotRepositoryError("INVALID_STATE", "The stored AWS role contract is invalid");
  }
  const grantedActions = [...verification.capabilityAssessment.grantedActions].sort();
  const missingActions = [...verification.capabilityAssessment.missingActions].sort();
  const expectedCallerIdentity =
    `arn:${connection.partition}:sts::${connection.awsAccountId}:assumed-role/${parsedRole.roleName}/${verification.roleSessionName}`;
  if (
    verification.verified !== true ||
    verification.accountId !== connection.awsAccountId ||
    verification.roleArn !== connection.roleArn ||
    !/^[A-Za-z0-9_+=,.@-]{2,64}$/u.test(verification.roleSessionName) ||
    !verification.roleSessionName.startsWith("sutra-") ||
    verification.callerIdentityArn !== expectedCallerIdentity ||
    verification.missingExternalIdDenied !== true ||
    verification.wrongExternalIdDenied !== true ||
    verification.trustPolicyAttested !== true ||
    verification.permissionPolicyAttested !== true ||
    verification.sessionPolicyApplied !== true ||
    verification.permissionPackVersion !== PILOT_PERMISSION_PACK ||
    !isExactDeclaredAwsCapabilityPartition(grantedActions, missingActions) ||
    (connection.roleProvisioningMode === "sutra_template" && missingActions.length !== 0)
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "The collector trust proof does not match this AWS connection");
  }
  const permissionCapabilitiesJson = canonicalJson({ grantedActions, missingActions });
  await commitAuditedStatements({
    db,
    statements: [db.prepare(
      `UPDATE aws_connections
          SET status = 'active', permission_pack_version = ?, permission_capabilities_json = ?,
              last_validated_at = ?, updated_at = ?
        WHERE org_id = ? AND id = ? AND status = 'validating'`,
    ).bind(PILOT_PERMISSION_PACK, permissionCapabilitiesJson, now, now, orgId, connectionId)],
    audit: {
      orgId,
      actorId,
      action: "aws.connection.trust_validated",
      targetType: "aws_connection",
      targetId: connectionId,
      customerId: connection.customerId,
      outcome: "allowed",
      requestId: `aws.connection.trust_validated:${connectionId}:${now}`,
      metadata: {
        permissionPackVersion: PILOT_PERMISSION_PACK,
        capabilityAssessment: { grantedActions, missingActions },
      },
    },
    mutationGuard: {
      sql: `SELECT 1 FROM aws_connections
             WHERE org_id = ? AND id = ? AND status = 'active'
               AND permission_pack_version = ? AND permission_capabilities_json = ?
               AND last_validated_at = ? AND updated_at = ?`,
      values: [orgId, connectionId, PILOT_PERMISSION_PACK, permissionCapabilitiesJson, now, now],
    },
    persistenceMessage: "The verified permission pack and audit evidence could not be committed atomically",
  });
}

export async function markConnectionNeedsAttention(
  connectionId: string,
  actorId: string,
  safeReason: string,
  orgId: string,
): Promise<void> {
  const db = await readyDatabase();
  const failure = parseSafePilotFailure({ code: safeReason });
  const connection = await getConnectionForOrg(orgId, connectionId);
  if (connection === null) return;
  const result = await db.prepare(
    `UPDATE aws_connections SET status = 'needs_attention', updated_at = ?
      WHERE org_id = ? AND id = ? AND status IN ('validating', 'active')`,
  ).bind(Date.now(), orgId, connectionId).run();
  if ((result.meta?.changes ?? 0) !== 1) return;
  await appendAuditEvent({
    orgId,
    actorId,
    action: "aws.connection.validation_failed",
    targetType: "aws_connection",
    targetId: connectionId,
    customerId: connection.customerId,
    outcome: "failed",
    metadata: { reason: failure.code },
  });
}

/**
 * Options for scoping a sync run beyond the local pilot organization.
 *
 * `orgId` defaults to {@link LOCAL_ORG_ID}, so every local caller that passes no
 * options gets byte-identical behaviour. Hosted callers (the broker-ingest job
 * handler) pass the org resolved STRICTLY from the durable job's server-derived
 * scope, plus the `idempotencyKey` = the broker's signed collector job id so the
 * created run's idempotency key matches the snapshot payload's `jobId` that
 * {@link persistSnapshot} re-checks.
 */
export interface CreateSyncRunOptions {
  readonly orgId?: string;
  readonly idempotencyKey?: string;
  readonly triggerKind?: "manual" | "scheduled" | "onboarding";
}

export interface HostedCollectorOperationRun {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly status: PilotSyncRun["status"];
}

/**
 * Read only sync runs belonging to one server-derived hosted collection
 * operation. The prefix boundary prevents `abc` from matching `abcd`; all
 * tenant and connection columns are part of the predicate.
 */
export async function listHostedCollectorOperationRuns(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly idempotencyBase: string;
}): Promise<readonly HostedCollectorOperationRun[]> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(input.orgId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(input.customerId) ||
    !/^conn_[a-f0-9]{32}$/u.test(input.connectionId) ||
    !/^hosted_collector_[a-f0-9]{64}$/u.test(input.idempotencyBase)
  ) {
    throw new PilotRepositoryError("INVALID_STATE", "Hosted collection scope is invalid");
  }
  const db = await readyDatabase();
  const rows = await db.prepare(
    `SELECT id, idempotency_key, status
       FROM sync_runs
      WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        AND (
          idempotency_key = ? OR
          (substr(idempotency_key, 1, ?) = ? AND substr(idempotency_key, ?, 1) = '.')
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 25`,
  ).bind(
    input.orgId,
    input.customerId,
    input.connectionId,
    input.idempotencyBase,
    input.idempotencyBase.length,
    input.idempotencyBase,
    input.idempotencyBase.length + 1,
  ).all<{ id: string; idempotency_key: string; status: PilotSyncRun["status"] }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
  }));
}

export async function createSyncRun(
  connectionId: string,
  options: CreateSyncRunOptions = {},
): Promise<string> {
  const orgId = options.orgId ?? LOCAL_ORG_ID;
  const triggerKind = options.triggerKind ?? "manual";
  const db = await readyDatabase();
  const abandonedBefore = Date.now() - LIVE_AWS_RUN_RECLAIM_AFTER_MS;
  await db.batch([
    db.prepare(
      `UPDATE cmdb_snapshots SET status = 'failed', completed_at = ?
        WHERE org_id = ? AND connection_id = ? AND status = 'staging' AND collected_at < ?`,
    ).bind(Date.now(), orgId, connectionId, abandonedBefore),
    db.prepare(
      `UPDATE sync_runs SET status = 'failed', coverage_state = 'unknown',
          totals_json = '{"error":"COLLECTION_FAILED"}', finished_at = ?
        WHERE org_id = ? AND connection_id = ? AND status = 'running' AND created_at < ?`,
    ).bind(Date.now(), orgId, connectionId, abandonedBefore),
  ]);
  const connection = await getConnectionForOrg(orgId, connectionId);
  if (connection === null) {
    throw new PilotRepositoryError("NOT_FOUND", "AWS connection not found");
  }
  if (connection.status !== "active") {
    throw new PilotRepositoryError("INVALID_STATE", "Validate the AWS connection before running inventory");
  }
  if (connection.permissionPackVersion !== PILOT_PERMISSION_PACK) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "Revalidate the current AWS permission pack before running inventory",
    );
  }
  if (connection.sourceKind === "simulated_fixture") {
    throw new PilotRepositoryError("INVALID_STATE", "Run simulated inventory through the durable local jobs workflow");
  }
  const runId = id("sync");
  const idempotencyKey = options.idempotencyKey ?? runId;
  const previousRun = await db.prepare(
    `SELECT created_at FROM sync_runs
      WHERE org_id = ? AND customer_id = ? AND connection_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
  ).bind(orgId, connection.customerId, connectionId).first<{ created_at: number }>();
  // The per-connection run clock is monotonic even when several runs begin
  // inside the same wall-clock millisecond. Projection ordering never depends
  // on a random identifier except as a defensive legacy tie-breaker.
  const now = Math.max(Date.now(), (previousRun?.created_at ?? -1) + 1);
  let result: D1Result<unknown>;
  try {
    result = await db.prepare(
      `INSERT INTO sync_runs
      (id, org_id, customer_id, connection_id, trigger_kind, status,
       coverage_state, collector_pack_version, totals_json, idempotency_key,
       started_at, created_at)
     SELECT ?, c.org_id, c.customer_id, c.id, ?, 'running', 'unknown',
            'aws-pilot-v1', '{}', ?, ?, ?
       FROM aws_connections c
      WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
        AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        AND c.permission_pack_version = ?
        AND NOT EXISTS (
          SELECT 1 FROM sync_runs r
           WHERE r.org_id = c.org_id AND r.connection_id = c.id
             AND r.status IN ('queued', 'running')
        )`,
    ).bind(
      runId,
      triggerKind,
      idempotencyKey,
      now,
      now,
      orgId,
      connection.customerId,
      connectionId,
      PILOT_PERMISSION_PACK,
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
    ).bind(orgId, connectionId).first<{ id: string }>();
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
  orgId: string,
): Promise<void> {
  const db = await readyDatabase();
  const failure = parseSafePilotFailure({ code: safeReason });
  const now = Date.now();
  const result = await db.prepare(
    `UPDATE sync_runs SET status = 'failed', coverage_state = 'unknown',
        totals_json = ?, finished_at = ?
      WHERE org_id = ? AND id = ? AND connection_id = ? AND status = 'running'`,
  ).bind(JSON.stringify({ error: failure.code }), now, orgId, runId, connectionId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    throw new PilotRepositoryError("INVALID_STATE", "The sync failure result is stale");
  }
  const connection = await getConnectionForOrg(orgId, connectionId);
  await appendAuditEvent({
    orgId,
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

function configuredResourceRetirementCompleteMisses(): number {
  const runtime = env as unknown as {
    readonly SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES?: string;
  };
  return resolveResourceRetirementCompleteMisses(
    runtime.SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES ??
      process.env.SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES,
  );
}

function hostedEvidenceBytesRequired(): boolean {
  const runtime = env as unknown as {
    readonly SUTRA_DEPLOYMENT_ENV?: string;
    readonly SUTRA_HOSTED_ENABLED?: string;
  };
  const deployment =
    runtime.SUTRA_DEPLOYMENT_ENV ?? process.env.SUTRA_DEPLOYMENT_ENV;
  const hosted =
    runtime.SUTRA_HOSTED_ENABLED ?? process.env.SUTRA_HOSTED_ENABLED;
  return deployment === "production" || hosted === "true";
}

export async function persistSnapshot(
  runId: string,
  payload: PilotSnapshotPayload,
  actorId: string,
  origin: SnapshotOrigin = { kind: "unknown", fixtureId: null, fixtureVersion: null },
  localFixtureJobId: string | null = null,
  localFixtureScheduleId: string | null = null,
  // `orgId` defaults to the local pilot organization so every existing local
  // caller is byte-identical. Hosted callers pass the org resolved STRICTLY from
  // the durable job's server-derived scope; the whole persist is then scoped to
  // that tenant and never to anything read from the payload.
  orgId: string,
  // Hosted ingestion supplies the exact request bytes covered by the broker
  // signature. Manual live collection omits this and archives canonical JSON.
  rawEvidenceBytes?: Uint8Array,
): Promise<string> {
  const db = await readyDatabase();
  const connection = await getConnectionForOrg(orgId, payload.connectionId);
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
    `SELECT id, idempotency_key, trigger_kind, schedule_id, created_at FROM sync_runs
      WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND id = ? AND status = 'running'
      LIMIT 1`,
  ).bind(orgId, connection.customerId, payload.connectionId, runId).first<{
    id: string;
    idempotency_key: string;
    trigger_kind: "manual" | "scheduled" | "onboarding";
    schedule_id: string | null;
    created_at: number;
  }>();
  if (scopedRun === null || scopedRun.idempotency_key !== payload.jobId) {
    throw new PilotRepositoryError("INVALID_STATE", "The collector result does not belong to an active scoped sync");
  }

  const retirementCompleteMisses = payload.coverageState === "complete"
    ? configuredResourceRetirementCompleteMisses()
    : null;
  let previousSnapshotId: string | null = null;
  let previousResources: readonly CmdbComparableResource[] = [];
  const previousCompleteMisses = new Map<string, number>();
  if (payload.coverageState === "complete") {
    const previousHead = await db.prepare(
      `SELECT s.id
         FROM connection_heads h
         JOIN cmdb_snapshots s ON s.id = h.snapshot_id
          AND s.org_id = h.org_id AND s.customer_id = h.customer_id
          AND s.connection_id = h.connection_id AND s.status = 'complete'
        WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
        LIMIT 1`,
    ).bind(orgId, connection.customerId, payload.connectionId).first<{ id: string }>();
    if (previousHead !== null) {
      previousSnapshotId = previousHead.id;
      const projectedResult = await db.prepare(
        `SELECT r.resource_key, r.service, r.resource_type, r.native_id,
                r.arn, r.name, r.region_key, r.state, r.tags_json,
                r.configuration_json, r.source_json, r.content_sha256,
                p.consecutive_complete_misses
           FROM cmdb_resource_projection_states p
           JOIN cmdb_resources r
             ON r.id = p.last_observed_resource_id
            AND r.org_id = p.org_id AND r.customer_id = p.customer_id
            AND r.connection_id = p.connection_id
            AND r.snapshot_id = p.last_observed_snapshot_id
            AND r.resource_key = p.resource_key
          WHERE p.org_id = ? AND p.customer_id = ? AND p.connection_id = ?
            AND p.lifecycle_state <> 'retired'
          ORDER BY r.resource_key`,
      ).bind(orgId, connection.customerId, payload.connectionId).all<ResourceRow>();
      const projectedRows = projectedResult.results ?? [];
      if (projectedRows.length > 0) {
        previousResources = projectedRows.map(resourceRowToComparable);
        for (const row of projectedRows) {
          previousCompleteMisses.set(
            row.resource_key,
            Number(row.consecutive_complete_misses ?? 0),
          );
        }
      } else {
        // Compatibility fallback for a manually seeded or pre-migration head.
        const previousResult = await db.prepare(
          `SELECT resource_key, service, resource_type, native_id, arn, name,
                  region_key, state, tags_json, configuration_json, source_json,
                  content_sha256
             FROM cmdb_resources
            WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND snapshot_id = ?
            ORDER BY resource_key`,
        ).bind(orgId, connection.customerId, payload.connectionId, previousHead.id).all<ResourceRow>();
        const fallbackRows = previousResult.results ?? [];
        previousResources = fallbackRows.map(resourceRowToComparable);
        for (const row of fallbackRows) previousCompleteMisses.set(row.resource_key, 0);
      }
    }
  }
  const snapshotId = id("snap");
  const collectedAt = Date.parse(payload.collectedAt);
  const now = Date.now();
  const snapshotStatus = payload.coverageState === "complete" ? "complete" : "partial";
  if (
    (origin.kind !== "unknown" && origin.kind !== "simulated_fixture" && origin.kind !== "aws_live") ||
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
  let evidenceObject: EvidenceObjectSummary | null = null;
  if (origin.kind === "aws_live") {
    if (rawEvidenceBytes === undefined && hostedEvidenceBytesRequired()) {
      throw new PilotRepositoryError(
        "PERSISTENCE_FAILED",
        "Authenticated collector evidence bytes are required before hosted publication",
      );
    }
    const body = rawEvidenceBytes ?? new TextEncoder().encode(canonicalJson(payload));
    // This archive is intentionally BEFORE the first staging snapshot write.
    // Managed production therefore cannot promote or partially persist a live
    // snapshot when private evidence storage is unavailable.
    evidenceObject = await new EvidenceRepository(db).archive({
      scope: {
        orgId,
        customerId: connection.customerId,
        connectionId: payload.connectionId,
      },
      runId,
      snapshotId,
      artifactKind: "aws_snapshot_raw",
      contentType: "application/json",
      body,
      createdBy: actorId,
    });
  }
  const resourceChanges = payload.coverageState === "complete"
    ? diffCmdbResources(previousResources, payload.resources.map(toComparableResource))
      .filter((change) =>
        change.changeType !== "removed" ||
        (previousCompleteMisses.get(change.resourceKey) ?? 0) + 1 >=
          (retirementCompleteMisses ?? Number.POSITIVE_INFINITY))
    : [];

  await db.prepare(
    `INSERT INTO cmdb_snapshots
      (id, org_id, customer_id, connection_id, sync_run_id, status,
       collected_at, coverage_json, summary_json, origin_kind, fixture_id, fixture_version)
     VALUES (?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    snapshotId,
    orgId,
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
      orgId,
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
      orgId,
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
      orgId,
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
      orgId,
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
         before_json, after_json, projection_applied, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(
      `${snapshotId}:change:${change.changeType}:${index}:${change.resourceKey}`,
      orgId,
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
    ).bind(snapshotStatus, now, payload.snapshotSha256, snapshotId, orgId, runId, orgId, payload.connectionId),
  ];
  if (shouldPublishHead) {
    // Lifecycle is a mutable projection over immutable collected rows. Only a
    // complete run can enter this branch. Missing resources advance one grace
    // step, while resources observed in this snapshot reset to active and point
    // at their new immutable evidence. The run ordering guards make a late
    // completion a retained snapshot, never a projection regression.
    publicationStatements.push(db.prepare(
      `UPDATE cmdb_resource_projection_states
          SET consecutive_complete_misses = consecutive_complete_misses + 1,
              lifecycle_state = CASE
                WHEN consecutive_complete_misses + 1 >= ? THEN 'retired'
                ELSE 'retirement_pending'
              END,
              first_missing_snapshot_id = CASE
                WHEN consecutive_complete_misses = 0 THEN ?
                ELSE first_missing_snapshot_id
              END,
              state_changed_snapshot_id = ?,
              last_complete_run_id = ?,
              last_complete_run_created_at = CAST(? AS BIGINT),
              retirement_pending_at = CASE
                WHEN consecutive_complete_misses = 0 THEN CAST(? AS BIGINT)
                ELSE retirement_pending_at
              END,
              retired_at = CASE
                WHEN consecutive_complete_misses + 1 >= ? THEN CAST(? AS BIGINT)
                ELSE retired_at
              END,
              updated_at = CAST(? AS BIGINT)
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND lifecycle_state <> 'retired'
          AND (
            last_complete_run_created_at < CAST(? AS BIGINT) OR
            (last_complete_run_created_at = CAST(? AS BIGINT) AND last_complete_run_id < ?)
          )
          AND NOT EXISTS (
            SELECT 1
              FROM cmdb_resources observed
             WHERE observed.org_id = ? AND observed.customer_id = ?
               AND observed.connection_id = ? AND observed.snapshot_id = ?
               AND observed.resource_key = cmdb_resource_projection_states.resource_key
          )`,
    ).bind(
      retirementCompleteMisses,
      snapshotId,
      snapshotId,
      runId,
      scopedRun.created_at,
      now,
      retirementCompleteMisses,
      now,
      now,
      orgId,
      connection.customerId,
      payload.connectionId,
      scopedRun.created_at,
      scopedRun.created_at,
      runId,
      orgId,
      connection.customerId,
      payload.connectionId,
      snapshotId,
    ));
    publicationStatements.push(db.prepare(
      `INSERT INTO cmdb_resource_projection_states
        (org_id, customer_id, connection_id, resource_key,
         lifecycle_state, consecutive_complete_misses,
         last_observed_resource_id, last_observed_snapshot_id,
         first_missing_snapshot_id, state_changed_snapshot_id,
         last_complete_run_id, last_complete_run_created_at,
         retirement_pending_at, retired_at, updated_at)
       SELECT r.org_id, r.customer_id, r.connection_id, r.resource_key,
              'active', 0, r.id, r.snapshot_id, NULL, r.snapshot_id,
              ?, CAST(? AS BIGINT), NULL, NULL, CAST(? AS BIGINT)
         FROM cmdb_resources r
        WHERE r.org_id = ? AND r.customer_id = ? AND r.connection_id = ?
          AND r.snapshot_id = ?
          AND (
            NOT EXISTS (
              SELECT 1 FROM connection_heads h
               WHERE h.connection_id = ? AND h.org_id = ? AND h.customer_id = ?
            ) OR EXISTS (
              SELECT 1
                FROM connection_heads h
                JOIN cmdb_snapshots current_snapshot
                  ON current_snapshot.id = h.snapshot_id
                 AND current_snapshot.org_id = h.org_id
                 AND current_snapshot.customer_id = h.customer_id
                 AND current_snapshot.connection_id = h.connection_id
                JOIN sync_runs current_run
                  ON current_run.id = current_snapshot.sync_run_id
                 AND current_run.org_id = current_snapshot.org_id
                 AND current_run.customer_id = current_snapshot.customer_id
                 AND current_run.connection_id = current_snapshot.connection_id
               WHERE h.connection_id = ? AND h.org_id = ? AND h.customer_id = ?
                 AND (
                   current_run.created_at < CAST(? AS BIGINT) OR
                   (current_run.created_at = CAST(? AS BIGINT) AND current_run.id < ?)
                 )
            )
          )
       ON CONFLICT (org_id, connection_id, resource_key) DO UPDATE SET
         customer_id = excluded.customer_id,
         lifecycle_state = 'active',
         consecutive_complete_misses = 0,
         last_observed_resource_id = excluded.last_observed_resource_id,
         last_observed_snapshot_id = excluded.last_observed_snapshot_id,
         first_missing_snapshot_id = NULL,
         state_changed_snapshot_id = excluded.state_changed_snapshot_id,
         last_complete_run_id = excluded.last_complete_run_id,
         last_complete_run_created_at = excluded.last_complete_run_created_at,
         retirement_pending_at = NULL,
         retired_at = NULL,
         updated_at = excluded.updated_at
       WHERE (
         cmdb_resource_projection_states.last_complete_run_created_at <
           excluded.last_complete_run_created_at OR
         (
           cmdb_resource_projection_states.last_complete_run_created_at =
             excluded.last_complete_run_created_at AND
           cmdb_resource_projection_states.last_complete_run_id <
             excluded.last_complete_run_id
         )
       )`,
    ).bind(
      runId,
      scopedRun.created_at,
      now,
      orgId,
      connection.customerId,
      payload.connectionId,
      snapshotId,
      payload.connectionId,
      orgId,
      connection.customerId,
      payload.connectionId,
      orgId,
      connection.customerId,
      scopedRun.created_at,
      scopedRun.created_at,
      runId,
    ));
    publicationStatements.push(db.prepare(
      `INSERT INTO connection_heads (connection_id, org_id, customer_id, snapshot_id, updated_at)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sync_runs r WHERE r.id = ? AND r.org_id = ?
          AND r.connection_id = ? AND r.status = 'running')
       ON CONFLICT(connection_id) DO UPDATE SET snapshot_id = excluded.snapshot_id,
         customer_id = excluded.customer_id, updated_at = excluded.updated_at
       WHERE connection_heads.org_id = excluded.org_id
         AND connection_heads.customer_id = excluded.customer_id
         AND EXISTS (
           SELECT 1
             FROM cmdb_snapshots current_snapshot
             JOIN sync_runs current_run
               ON current_run.id = current_snapshot.sync_run_id
              AND current_run.org_id = current_snapshot.org_id
              AND current_run.customer_id = current_snapshot.customer_id
              AND current_run.connection_id = current_snapshot.connection_id
            WHERE current_snapshot.id = connection_heads.snapshot_id
              AND current_snapshot.org_id = connection_heads.org_id
              AND current_snapshot.customer_id = connection_heads.customer_id
              AND current_snapshot.connection_id = connection_heads.connection_id
              AND (
                current_run.created_at < CAST(? AS BIGINT) OR
                (current_run.created_at = CAST(? AS BIGINT) AND current_run.id < ?)
              )
         )`,
    ).bind(
      payload.connectionId,
      orgId,
      connection.customerId,
      snapshotId,
      now,
      runId,
      orgId,
      payload.connectionId,
      scopedRun.created_at,
      scopedRun.created_at,
      runId,
    ));
    publicationStatements.splice(publicationStatements.length - 1, 0, db.prepare(
      `UPDATE cmdb_change_events
          SET projection_applied = 1
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND to_snapshot_id = ? AND projection_applied = 0
          AND (
            NOT EXISTS (
              SELECT 1 FROM connection_heads h
               WHERE h.connection_id = ? AND h.org_id = ? AND h.customer_id = ?
            ) OR EXISTS (
              SELECT 1
                FROM connection_heads h
                JOIN cmdb_snapshots current_snapshot
                  ON current_snapshot.id = h.snapshot_id
                 AND current_snapshot.org_id = h.org_id
                 AND current_snapshot.customer_id = h.customer_id
                 AND current_snapshot.connection_id = h.connection_id
                JOIN sync_runs current_run
                  ON current_run.id = current_snapshot.sync_run_id
                 AND current_run.org_id = current_snapshot.org_id
                 AND current_run.customer_id = current_snapshot.customer_id
                 AND current_run.connection_id = current_snapshot.connection_id
               WHERE h.connection_id = ? AND h.org_id = ? AND h.customer_id = ?
                 AND (
                   current_run.created_at < CAST(? AS BIGINT) OR
                   (current_run.created_at = CAST(? AS BIGINT) AND current_run.id < ?)
                 )
            )
          )`,
    ).bind(
      orgId,
      connection.customerId,
      payload.connectionId,
      snapshotId,
      payload.connectionId,
      orgId,
      connection.customerId,
      payload.connectionId,
      orgId,
      connection.customerId,
      scopedRun.created_at,
      scopedRun.created_at,
      runId,
    ));
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
      orgId,
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
    orgId,
    runId,
    payload.connectionId,
  ));
  publicationStatements.push(payload.coverageState === "complete"
    ? db.prepare(
      `UPDATE aws_connections
          SET status = 'active', last_successful_sync_at = ?, updated_at = ?,
              fixture_version = CASE WHEN source_kind = 'simulated_fixture' THEN ? ELSE fixture_version END
        WHERE org_id = ? AND id = ? AND status = 'active'`,
    ).bind(now, now, origin.fixtureVersion, orgId, payload.connectionId)
    : db.prepare(
      `UPDATE aws_connections
          SET updated_at = ?,
              fixture_version = CASE WHEN source_kind = 'simulated_fixture' THEN ? ELSE fixture_version END
        WHERE org_id = ? AND id = ? AND status = 'active'`,
    ).bind(now, origin.fixtureVersion, orgId, payload.connectionId));

  const publicationAudit: AuditInput = origin.kind === "simulated_fixture" && localFixtureJobId !== null
    ? {
      orgId,
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
      orgId,
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
        evidenceObjectId: evidenceObject?.id ?? "",
        evidenceContentSha256: evidenceObject?.contentSha256 ?? "",
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
        AND e.projection_applied = 1
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

export async function getPilotStateForOrg(
  orgId: string,
  connectionId?: string,
): Promise<PilotState> {
  const db = await readyDatabase();
  const connection = connectionId === undefined
    ? await getLatestConnectionForOrg(orgId)
    : await getConnectionForOrg(orgId, connectionId);
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
  ).bind(orgId, connection.id).first<SnapshotHeadRow>();

  const syncResult = await db.prepare(
    `SELECT id, connection_id, status, coverage_state, totals_json,
            started_at, finished_at, created_at
       FROM sync_runs
      WHERE org_id = ? AND connection_id = ?
      ORDER BY created_at DESC
      LIMIT 20`,
  ).bind(orgId, connection.id).all<SyncRow>();
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
      orgId,
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
              content_sha256, lifecycle_state, consecutive_complete_misses,
              evidence_snapshot_id, evidence_snapshot_sha256
         FROM (
           SELECT r.resource_key, r.service, r.resource_type, r.native_id,
                  r.arn, r.name, r.region_key, r.state, r.tags_json,
                  r.configuration_json, r.source_json, r.content_sha256,
                  p.lifecycle_state, p.consecutive_complete_misses,
                  s.id AS evidence_snapshot_id,
                  s.snapshot_sha256 AS evidence_snapshot_sha256
             FROM cmdb_resource_projection_states p
             JOIN cmdb_resources r
               ON r.id = p.last_observed_resource_id
              AND r.org_id = p.org_id AND r.customer_id = p.customer_id
              AND r.connection_id = p.connection_id
              AND r.snapshot_id = p.last_observed_snapshot_id
              AND r.resource_key = p.resource_key
             JOIN cmdb_snapshots s
               ON s.id = p.last_observed_snapshot_id
              AND s.org_id = p.org_id AND s.customer_id = p.customer_id
              AND s.connection_id = p.connection_id AND s.status = 'complete'
            WHERE p.org_id = ? AND p.customer_id = ? AND p.connection_id = ?
              AND p.lifecycle_state <> 'retired'
           UNION ALL
           SELECT r.resource_key, r.service, r.resource_type, r.native_id,
                  r.arn, r.name, r.region_key, r.state, r.tags_json,
                  r.configuration_json, r.source_json, r.content_sha256,
                  'active' AS lifecycle_state, 0 AS consecutive_complete_misses,
                  s.id AS evidence_snapshot_id,
                  s.snapshot_sha256 AS evidence_snapshot_sha256
             FROM cmdb_resources r
             JOIN cmdb_snapshots s
               ON s.id = r.snapshot_id AND s.org_id = r.org_id
              AND s.customer_id = r.customer_id
              AND s.connection_id = r.connection_id AND s.status = 'complete'
            WHERE r.org_id = ? AND r.customer_id = ? AND r.connection_id = ?
              AND r.snapshot_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM cmdb_resource_projection_states p
                 WHERE p.org_id = r.org_id AND p.customer_id = r.customer_id
                   AND p.connection_id = r.connection_id
                   AND p.resource_key = r.resource_key
              )
         ) projected_resources
        ORDER BY service, resource_type, region_key, name, native_id`,
    ).bind(
      orgId,
      connection.customerId,
      connection.id,
      orgId,
      connection.customerId,
      connection.id,
      head.id,
    ).all<ResourceRow>(),
    db.prepare(
      `SELECT from_resource_key, to_resource_key, relation_type, evidence_json
         FROM cmdb_relationships
        WHERE org_id = ? AND connection_id = ? AND snapshot_id = ?
        ORDER BY relation_type, from_resource_key, to_resource_key`,
    ).bind(orgId, connection.id, head.id).all<RelationshipRow>(),
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
    ).bind(orgId, connection.id, head.id).all<FindingRow>(),
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
    lifecycleState: row.lifecycle_state ?? "active",
    consecutiveCompleteMisses: Number(row.consecutive_complete_misses ?? 0),
    evidenceSnapshot: {
      id: row.evidence_snapshot_id ?? head.id,
      snapshotSha256: row.evidence_snapshot_sha256 ?? head.snapshot_sha256,
    },
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

export function getPilotState(connectionId?: string): Promise<PilotState> {
  return getPilotStateForOrg(LOCAL_ORG_ID, connectionId);
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
  /** Defaults to the local pilot organization for local-only callers. */
  readonly orgId?: string;
  /**
   * The class of principal the event is attributed to. Defaults to "user" so
   * every existing caller (which omits it) is byte-identical. A "system" actor
   * is reserved for host-local platform operations that run without an
   * authenticated end-user session (e.g. cold-path recovery).
   */
  readonly actorType?: "user" | "service" | "system";
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

interface ResolvedAuditInput extends Omit<AuditInput, "orgId"> {
  readonly orgId: string;
  readonly actorType: "user" | "service" | "system";
  readonly requestId: string;
  readonly metadataJson: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function liveAccountOwnershipExists(
  db: D1Database,
  partition: AwsPartition,
  accountId: string,
): Promise<boolean> {
  // One live owner per AWS account across BOTH live kinds: a trust-role
  // connection and a static-credential connection must never share an account.
  return await db.prepare(
    `SELECT 1 FROM aws_connections
      WHERE source_kind IN ('aws_trust_role', 'aws_static_credentials')
        AND partition = ? AND aws_account_id = ?
      LIMIT 1`,
  ).bind(partition, accountId).first() !== null;
}

async function liveRoleOwnershipExists(
  db: D1Database,
  roleArn: string,
  exceptConnectionId: string,
): Promise<boolean> {
  return await db.prepare(
    `SELECT 1 FROM aws_connections
      WHERE source_kind = 'aws_trust_role' AND role_arn = ? AND id <> ?
      LIMIT 1`,
  ).bind(roleArn, exceptConnectionId).first() !== null;
}

/**
 * A collision is intentionally recorded only in the requesting tenant's
 * tamper-evident audit chain. The signal contains neither the submitted
 * account/role nor any identifier for the connection that already owns it.
 */
async function recordAwsOwnershipCollision(input: {
  readonly db: D1Database;
  readonly orgId: string;
  readonly actorId: string;
  readonly connectionId: string;
  readonly customerId: string | null;
  readonly partition: AwsPartition;
  readonly collisionKind: "account" | "role";
  readonly requestId: string;
}): Promise<void> {
  await appendAuditEventWithRetry(resolveAuditInput({
    orgId: input.orgId,
    actorId: input.actorId,
    action: "security.aws_connection_ownership_collision",
    targetType: "aws_connection",
    targetId: input.connectionId,
    customerId: input.customerId,
    outcome: "denied",
    requestId: input.requestId,
    metadata: {
      collisionKind: input.collisionKind,
      partition: input.partition,
      ownerDisclosure: false,
      automaticTransfer: false,
      transferRequiresExplicitAudit: true,
    },
  }));
}

function resolveAuditInput(input: AuditInput): ResolvedAuditInput {
  const orgId = input.orgId ?? LOCAL_ORG_ID;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(orgId)) {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "The audit organization identifier is invalid",
    );
  }
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
  return { ...input, orgId, actorType: input.actorType ?? "user", requestId, metadataJson };
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
 * Commit domain statements and their chained audit record in the same database
 * transaction. The post-mutation guard is evaluated by the audit INSERT inside
 * that transaction; a false guard intentionally violates the audit row's NOT
 * NULL constraints so D1/PostgreSQL roll the whole batch back.
 */
export function commitAuditedStatements(input: {
  readonly db: D1Database;
  readonly statements: readonly D1PreparedStatement[];
  readonly audit: AuditInput;
  readonly mutationGuard: SqlExistenceGuard;
  readonly persistenceMessage: string;
}): Promise<void> {
  let audit: ResolvedAuditInput;
  try {
    audit = resolveAuditInput(input.audit);
  } catch (error) {
    return Promise.reject(error);
  }
  return serializeAuditOperation(async () => {
    const recover = async (): Promise<boolean> =>
      await auditRequestAlreadySatisfied(input.db, audit) &&
      await existenceGuardSatisfied(input.db, input.mutationGuard);
    if (await recover()) return;
    let results: D1Result<unknown>[];
    try {
      results = await input.db.batch([
        ...input.statements,
        await prepareAuditEventStatement(input.db, audit, true, input.mutationGuard),
      ]);
    } catch {
      if (await recover()) return;
      throw new PilotRepositoryError("PERSISTENCE_FAILED", input.persistenceMessage);
    }
    if ((results.at(-1)?.meta?.changes ?? 0) !== 1 || !await recover()) {
      throw new PilotRepositoryError("PERSISTENCE_FAILED", input.persistenceMessage);
    }
  });
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
  orgId = LOCAL_ORG_ID,
): Promise<StoredAuditRequestRow | null> {
  return db.prepare(
    `SELECT id, customer_id, actor_type, actor_id, action, target_type,
            target_id, outcome, metadata_json
       FROM audit_events
      WHERE org_id = ? AND request_id = ?
      LIMIT 1`,
  ).bind(orgId, requestId).first<StoredAuditRequestRow>();
}

function assertMatchingAuditRequest(
  existing: StoredAuditRequestRow,
  input: ResolvedAuditInput,
): void {
  if (
    existing.customer_id !== input.customerId ||
    existing.actor_type !== input.actorType ||
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
  const existing = await findAuditRequest(db, input.requestId, input.orgId);
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
  ).bind(input.orgId).first<{ event_hash: string; occurred_at: number }>();
  const eventId = id("audit");
  const occurredAt = Math.max(Date.now(), (previous?.occurred_at ?? -1) + 1);
  const requestId = input.requestId;
  const metadataJson = input.metadataJson;
  const previousHash = previous?.event_hash ?? null;
  const hashVersion = 2 as const;
  const eventHash = await computeAuditEventHash({
    eventId,
    orgId: input.orgId,
    customerId: input.customerId,
    occurredAt,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome,
    requestId,
    metadataJson,
    previousEventHash: previousHash,
    hashVersion,
  });
  const mutationGuardCte = mutationGuard === undefined
    ? `, mutation_guard(valid) AS (SELECT 1)`
    : `, mutation_guard(valid) AS (
       SELECT CASE WHEN EXISTS (${mutationGuard.sql}) THEN 1 ELSE 0 END
     )`;
  const invalidGuard = failClosed
    ? `UNION ALL
     SELECT NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, CAST(NULL AS SMALLINT)
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
       previous_event_hash, event_hash, hash_version)
     SELECT ?, ?, ?, CAST(? AS BIGINT), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM chain_guard, mutation_guard
      WHERE chain_guard.valid = 1 AND mutation_guard.valid = 1
     ${invalidGuard}`,
  ).bind(
    previousHash,
    input.orgId,
    input.orgId,
    previousHash,
    ...(mutationGuard?.values ?? []),
    eventId,
    input.orgId,
    input.customerId,
    occurredAt,
    input.actorType,
    input.actorId,
    input.action,
    input.targetType,
    input.targetId,
    input.outcome,
    requestId,
    metadataJson,
    previousHash,
    eventHash,
    hashVersion,
  );
}
