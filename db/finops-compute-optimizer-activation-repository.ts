/**
 * Durable app-side boundary for the separate Compute Optimizer .8.5
 * capability, deterministic daily activations, and an at-least-once
 * materializer outbox. Generic aws_connections permission-pack state is never
 * read as the .8.5 capability and is never mutated here.
 *
 * Regional sealed plans and their immutable plan set are deliberately owned by
 * the existing plan repositories. This repository transactionally attaches an
 * already-finalized plan set and exact discovery lineage to one activation and
 * stages the existing materializer queue payload. Queue publication remains a
 * separate leased operation.
 */
import { canonicalJson } from "../lib/canonical-json.ts";
import {
  verifyComputeOptimizerMaterializationActivation,
  verifyComputeOptimizerMaterializationPlanCheckpoint,
  type ComputeOptimizerMaterializationActivation,
  type ComputeOptimizerMaterializationPlanCheckpoint,
} from "../lib/finops-compute-optimizer-export-coordinator.ts";
import {
  parseComputeOptimizerMaterializationJobPayload,
  type ComputeOptimizerMaterializationJobPayload,
} from "../lib/finops-compute-optimizer-materialization-runtime.ts";
import {
  verifyComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchExecution,
} from "../lib/finops-compute-optimizer-export-launch.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CAPABILITY_ID = /^cocp_[a-f0-9]{64}$/u;
const ACTIVATION_ID = /^comra_[a-f0-9]{64}$/u;
const CHECKPOINT_ID = /^comrp_[a-f0-9]{64}$/u;
const PLAN_SET_ID = /^copes_[a-f0-9]{64}$/u;
const OUTBOX_ID = /^coob_[a-f0-9]{64}$/u;
const DISCOVERY_RUN_ID = /^cor_[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const LEASE_TOKEN = /^[A-Za-z0-9._:@+-]{16,256}$/u;
const OBJECT_ID = /^eobj_[a-f0-9]{32}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const MAX_DATE_MS = 8_640_000_000_000_000;
const DAY_MS = 86_400_000;
const MAX_LEASE_MS = 15 * 60_000;
const DISCOVERY_SEAL_LEASE_MS = 120_000;
const PERMISSION_PACK = "standard-2026-08.5" as const;

type Partition = "aws" | "aws-us-gov" | "aws-cn";
export type ComputeOptimizerActivationState =
  | "SEALED"
  | "RECONCILING"
  | "DISCOVERY_PENDING"
  | "MATERIALIZATION_PENDING"
  | "COMPLETE"
  | "FAILED";
export type ComputeOptimizerMaterializerOutboxState =
  | "PENDING"
  | "LEASED"
  | "RECOVERABLE"
  | "DISPATCHED";

export interface ComputeOptimizerActivationPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface RecordComputeOptimizerCapabilityInput {
  readonly accountId: string;
  readonly partition: Partition;
  readonly regions: readonly string[];
  readonly manifestSha256: string;
  readonly verifiedAtMs: number;
  readonly enabled: boolean;
}

export interface StoredComputeOptimizerCapability {
  readonly capabilityId: string;
  readonly scope: ComputeOptimizerActivationPersistenceScope;
  readonly accountId: string;
  readonly partition: Partition;
  readonly permissionPackVersion: typeof PERMISSION_PACK;
  readonly regions: readonly string[];
  readonly manifestSha256: string;
  readonly verifiedAtIso: string;
  readonly enabled: boolean;
  readonly contentSha256: string;
  readonly createdAtIso: string;
}

export interface CreateComputeOptimizerActivationInput {
  readonly capabilityId: string;
  readonly activation: unknown;
  readonly sealedAtMs: number;
  readonly attempt: number;
}

export interface StoredComputeOptimizerActivation {
  readonly activationId: string;
  readonly scope: ComputeOptimizerActivationPersistenceScope;
  readonly capabilityId: string;
  readonly accountId: string;
  readonly partition: Partition;
  readonly scheduledWindow: string;
  readonly sealedAtIso: string;
  readonly attempt: number;
  readonly state: ComputeOptimizerActivationState;
  readonly activationContentSha256: string;
  readonly planCheckpointId: string | null;
  readonly planCheckpointSha256: string | null;
  readonly planSetId: string | null;
  readonly discoveryLineageSha256: string | null;
  readonly failureCodeSha256: string | null;
  readonly revision: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface RecordComputeOptimizerRegionalLaunchCheckpointInput {
  readonly activation: unknown;
  readonly region: string;
  readonly execution: unknown;
}

export interface StoredComputeOptimizerRegionalLaunchCheckpoint {
  readonly checkpointId: string;
  readonly scope: ComputeOptimizerActivationPersistenceScope;
  readonly activationId: string;
  readonly region: string;
  readonly attempt: number;
  readonly launchAttemptId: string;
  readonly launchAttemptSha256: string;
  readonly executionId: string;
  readonly executionSha256: string;
  /** Secret-free proof over job IDs/export families and destination hashes. */
  readonly launchOutcomeProofSha256: string;
  readonly contentSha256: string;
  readonly createdAtIso: string;
}

export interface GetOrCreateComputeOptimizerSealedEvidenceReferenceInput {
  readonly runId: string;
  readonly evidenceContentSha256: string;
  readonly objectId: string;
}

export interface StoredComputeOptimizerSealedEvidenceReference {
  readonly sealId: string;
  readonly scope: ComputeOptimizerActivationPersistenceScope;
  readonly runId: string;
  readonly evidenceContentSha256: string;
  readonly objectId: string;
  readonly bindingSha256: string;
  readonly reference: { readonly ciphertext: string; readonly keyVersion: string };
  readonly ciphertextSha256: string;
  readonly createdAtIso: string;
  readonly sealedAtIso: string;
}

export interface TransitionComputeOptimizerActivationInput {
  readonly activationId: string;
  readonly expectedState: ComputeOptimizerActivationState;
  readonly nextState: ComputeOptimizerActivationState;
  readonly expectedAttempt: number;
  readonly nextAttempt: number;
  readonly failureCode: string | null;
}

export interface StageComputeOptimizerMaterializerInput {
  readonly activation: unknown;
  readonly checkpoint: unknown;
  readonly regionalPlans: readonly unknown[];
  readonly regionalPlanDiscoveryReferences: readonly unknown[];
  readonly regionContracts: readonly unknown[];
}

export interface StoredComputeOptimizerMaterializerOutbox {
  readonly outboxId: string;
  readonly scope: ComputeOptimizerActivationPersistenceScope;
  readonly activationId: string;
  readonly planCheckpointId: string;
  readonly planSetId: string;
  readonly discoveryLineageSha256: string;
  readonly payload: ComputeOptimizerMaterializationJobPayload;
  readonly payloadSha256: string;
  readonly state: ComputeOptimizerMaterializerOutboxState;
  readonly deliveryAttempt: number;
  readonly leaseExpiresAtIso: string | null;
  readonly dispatchedAtIso: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export class ComputeOptimizerActivationRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "CAPABILITY_NOT_ENABLED"
    | "ACTIVATION_NOT_FOUND"
    | "PLAN_LINEAGE_NOT_FOUND"
    | "IMMUTABLE_CONFLICT"
    | "CAS_MISMATCH"
    | "STORED_STATE_INVALID";

  public constructor(code: ComputeOptimizerActivationRepositoryError["code"]) {
    super("Compute Optimizer activation persistence rejected");
    this.name = "ComputeOptimizerActivationRepositoryError";
    this.code = code;
  }
}

interface CapabilityRow {
  capability_id: string; org_id: string; customer_id: string; connection_id: string;
  account_id: string; partition: Partition; permission_pack_version: string;
  regions_json: string; region_count: number | string; manifest_sha256: string;
  verified_at: number | string; state: string; content_sha256: string;
  created_at: number | string;
}
interface ActivationRow {
  activation_id: string; org_id: string; customer_id: string; connection_id: string;
  capability_id: string; account_id: string; partition: Partition; scheduled_window: string;
  sealed_at: number | string; attempt: number | string; state: ComputeOptimizerActivationState;
  activation_content_sha256: string; plan_checkpoint_id: string | null;
  plan_checkpoint_sha256: string | null; plan_set_id: string | null;
  discovery_lineage_sha256: string | null; failure_code_sha256: string | null;
  revision: number | string; created_at: number | string; updated_at: number | string;
}
interface OutboxRow {
  outbox_id: string; org_id: string; customer_id: string; connection_id: string;
  activation_id: string; plan_checkpoint_id: string; plan_set_id: string;
  discovery_lineage_sha256: string; payload_json: string; payload_sha256: string;
  state: ComputeOptimizerMaterializerOutboxState; delivery_attempt: number | string;
  lease_token_sha256: string | null; lease_expires_at: number | string | null;
  dispatched_at: number | string | null; created_at: number | string; updated_at: number | string;
}
interface LaunchCheckpointRow {
  checkpoint_id: string; org_id: string; customer_id: string; connection_id: string;
  activation_id: string; region: string; attempt: number | string;
  launch_attempt_id: string; launch_attempt_sha256: string;
  execution_id: string; execution_sha256: string; launch_outcome_proof_sha256: string;
  content_sha256: string; created_at: number | string;
}
interface DiscoverySealRow {
  seal_id: string; org_id: string; customer_id: string; connection_id: string;
  run_id: string; evidence_content_sha256: string; object_id: string; binding_sha256: string;
  state: "RESERVING" | "SEALED"; claim_token_sha256: string;
  lease_expires_at: number | string; ciphertext: string | null; key_version: string | null;
  ciphertext_sha256: string | null; created_at: number | string; updated_at: number | string;
}

function reject(code: ComputeOptimizerActivationRepositoryError["code"]): never {
  throw new ComputeOptimizerActivationRepositoryError(code);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function integer(value: unknown, minimum: number, maximum: number, stored = false): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)
    || parsed < minimum || parsed > maximum) reject(stored ? "STORED_STATE_INVALID" : "INVALID_INPUT");
  return parsed;
}
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
function assertScope(scope: ComputeOptimizerActivationPersistenceScope): void {
  if (!isRecord(scope) || !exactKeys(scope, ["organizationId", "customerId", "connectionId"])
    || typeof scope.organizationId !== "string" || !IDENTIFIER.test(scope.organizationId)
    || typeof scope.customerId !== "string" || !IDENTIFIER.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION_ID.test(scope.connectionId)) reject("INVALID_INPUT");
}
function validRegionForPartition(region: string, partition: Partition): boolean {
  if (!REGION.test(region)) return false;
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}
function canonicalRegions(value: unknown, partition: Partition, stored = false): readonly string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return reject("STORED_STATE_INVALID"); }
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 50
    || parsed.some((region) => typeof region !== "string" || !validRegionForPartition(region, partition))
    || new Set(parsed).size !== parsed.length
    || parsed.some((region, index) => index > 0 && parsed[index - 1] >= region)
    || (typeof value === "string" && JSON.stringify(parsed) !== value)) {
    reject(stored ? "STORED_STATE_INVALID" : "INVALID_INPUT");
  }
  return deepFreeze([...(parsed as string[])]);
}
function asDate(value: unknown, stored = false): number {
  return integer(value, 0, MAX_DATE_MS, stored);
}
function dailyWindow(value: unknown): number {
  if (typeof value !== "string" || !DAILY_WINDOW.test(value)) reject("INVALID_INPUT");
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) reject("INVALID_INPUT");
  return parsed;
}

async function capabilityFrom(row: CapabilityRow): Promise<StoredComputeOptimizerCapability> {
  const regions = canonicalRegions(row.regions_json, row.partition, true);
  const verifiedAt = asDate(row.verified_at, true);
  const createdAt = asDate(row.created_at, true);
  const regionCount = integer(row.region_count, 1, 50, true);
  if (!CAPABILITY_ID.test(row.capability_id) || !ACCOUNT_ID.test(row.account_id)
    || !SHA256.test(row.manifest_sha256) || !SHA256.test(row.content_sha256)
    || row.capability_id !== `cocp_${row.content_sha256}` || row.permission_pack_version !== PERMISSION_PACK
    || regions.length !== regionCount || (row.state !== "ENABLED" && row.state !== "DISABLED")) {
    reject("STORED_STATE_INVALID");
  }
  const body = {
    schemaVersion: "sutra.compute-optimizer-capability.v1", scope: {
      organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id,
    }, accountId: row.account_id, partition: row.partition, permissionPackVersion: PERMISSION_PACK,
    regions, manifestSha256: row.manifest_sha256, verifiedAtMs: verifiedAt,
    enabled: row.state === "ENABLED",
  };
  if (await sha256(canonicalJson(body)) !== row.content_sha256) reject("STORED_STATE_INVALID");
  return deepFreeze({
    capabilityId: row.capability_id, scope: body.scope, accountId: row.account_id,
    partition: row.partition, permissionPackVersion: PERMISSION_PACK, regions,
    manifestSha256: row.manifest_sha256, verifiedAtIso: new Date(verifiedAt).toISOString(),
    enabled: row.state === "ENABLED", contentSha256: row.content_sha256,
    createdAtIso: new Date(createdAt).toISOString(),
  });
}

function activationFrom(row: ActivationRow): StoredComputeOptimizerActivation {
  const sealedAt = asDate(row.sealed_at, true);
  const createdAt = asDate(row.created_at, true);
  const updatedAt = asDate(row.updated_at, true);
  const attempt = integer(row.attempt, 1, 25, true);
  const revision = integer(row.revision, 0, 1000, true);
  if (!ACTIVATION_ID.test(row.activation_id) || !CAPABILITY_ID.test(row.capability_id)
    || !ACCOUNT_ID.test(row.account_id) || !DAILY_WINDOW.test(row.scheduled_window)
    || !SHA256.test(row.activation_content_sha256)
    || row.activation_id !== `comra_${row.activation_content_sha256}`
    || (row.plan_checkpoint_id !== null && !CHECKPOINT_ID.test(row.plan_checkpoint_id))
    || (row.plan_checkpoint_sha256 !== null && !SHA256.test(row.plan_checkpoint_sha256))
    || (row.plan_checkpoint_sha256 !== null
      && row.plan_checkpoint_id !== `comrp_${row.plan_checkpoint_sha256}`)
    || (row.plan_set_id !== null && !PLAN_SET_ID.test(row.plan_set_id))
    || (row.discovery_lineage_sha256 !== null && !SHA256.test(row.discovery_lineage_sha256))
    || (row.failure_code_sha256 !== null && !SHA256.test(row.failure_code_sha256))) {
    reject("STORED_STATE_INVALID");
  }
  return deepFreeze({
    activationId: row.activation_id,
    scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    capabilityId: row.capability_id, accountId: row.account_id, partition: row.partition,
    scheduledWindow: row.scheduled_window, sealedAtIso: new Date(sealedAt).toISOString(),
    attempt, state: row.state, activationContentSha256: row.activation_content_sha256,
    planCheckpointId: row.plan_checkpoint_id, planCheckpointSha256: row.plan_checkpoint_sha256,
    planSetId: row.plan_set_id, discoveryLineageSha256: row.discovery_lineage_sha256,
    failureCodeSha256: row.failure_code_sha256, revision,
    createdAtIso: new Date(createdAt).toISOString(), updatedAtIso: new Date(updatedAt).toISOString(),
  });
}

async function launchCheckpointFrom(
  row: LaunchCheckpointRow,
): Promise<StoredComputeOptimizerRegionalLaunchCheckpoint> {
  const attempt = integer(row.attempt, 1, 25, true);
  const createdAt = asDate(row.created_at, true);
  if (!/^coalc_[a-f0-9]{64}$/u.test(row.checkpoint_id)
    || !ACTIVATION_ID.test(row.activation_id) || !REGION.test(row.region)
    || !/^coela_[a-f0-9]{64}$/u.test(row.launch_attempt_id)
    || !SHA256.test(row.launch_attempt_sha256)
    || row.launch_attempt_id !== `coela_${row.launch_attempt_sha256}`
    || !/^coele_[a-f0-9]{64}$/u.test(row.execution_id)
    || !SHA256.test(row.execution_sha256)
    || row.execution_id !== `coele_${row.execution_sha256}`
    || !SHA256.test(row.launch_outcome_proof_sha256)
    || !SHA256.test(row.content_sha256)
    || row.checkpoint_id !== `coalc_${row.content_sha256}`) {
    reject("STORED_STATE_INVALID");
  }
  const body = {
    schemaVersion: "sutra.compute-optimizer-regional-launch-checkpoint.v1",
    scope: { organizationId: row.org_id, customerId: row.customer_id,
      connectionId: row.connection_id },
    activationId: row.activation_id, region: row.region, attempt,
    launchAttemptId: row.launch_attempt_id, launchAttemptSha256: row.launch_attempt_sha256,
    executionId: row.execution_id, executionSha256: row.execution_sha256,
    launchOutcomeProofSha256: row.launch_outcome_proof_sha256,
  };
  if (await sha256(canonicalJson(body)) !== row.content_sha256) reject("STORED_STATE_INVALID");
  return deepFreeze({
    checkpointId: row.checkpoint_id, ...body, contentSha256: row.content_sha256,
    createdAtIso: new Date(createdAt).toISOString(),
  });
}

async function sealedEvidenceFrom(
  row: DiscoverySealRow,
): Promise<StoredComputeOptimizerSealedEvidenceReference> {
  const createdAt = asDate(row.created_at, true);
  const updatedAt = asDate(row.updated_at, true);
  if (row.state !== "SEALED" || !/^cose_[a-f0-9]{64}$/u.test(row.seal_id)
    || !DISCOVERY_RUN_ID.test(row.run_id) || !SHA256.test(row.evidence_content_sha256)
    || !OBJECT_ID.test(row.object_id) || !SHA256.test(row.binding_sha256)
    || row.seal_id !== `cose_${row.binding_sha256}`
    || row.ciphertext === null || !SEALED_REFERENCE.test(row.ciphertext)
    || row.key_version === null || !KEY_VERSION.test(row.key_version)
    || row.ciphertext_sha256 === null || !SHA256.test(row.ciphertext_sha256)
    || await sha256(row.ciphertext) !== row.ciphertext_sha256) reject("STORED_STATE_INVALID");
  const scope = { organizationId: row.org_id, customerId: row.customer_id,
    connectionId: row.connection_id };
  const binding = { schemaVersion: "sutra.compute-optimizer-discovery-evidence-seal-binding.v1",
    scope, runId: row.run_id, evidenceContentSha256: row.evidence_content_sha256,
    objectId: row.object_id };
  if (await sha256(canonicalJson(binding)) !== row.binding_sha256) reject("STORED_STATE_INVALID");
  return deepFreeze({
    sealId: row.seal_id, scope, runId: row.run_id,
    evidenceContentSha256: row.evidence_content_sha256, objectId: row.object_id,
    bindingSha256: row.binding_sha256,
    reference: { ciphertext: row.ciphertext, keyVersion: row.key_version },
    ciphertextSha256: row.ciphertext_sha256,
    createdAtIso: new Date(createdAt).toISOString(), sealedAtIso: new Date(updatedAt).toISOString(),
  });
}

async function outboxFrom(row: OutboxRow): Promise<StoredComputeOptimizerMaterializerOutbox> {
  const deliveryAttempt = integer(row.delivery_attempt, 0, 25, true);
  const createdAt = asDate(row.created_at, true);
  const updatedAt = asDate(row.updated_at, true);
  let unsafePayload: unknown;
  try { unsafePayload = JSON.parse(row.payload_json); } catch { return reject("STORED_STATE_INVALID"); }
  let payload: ComputeOptimizerMaterializationJobPayload;
  try { payload = await parseComputeOptimizerMaterializationJobPayload(unsafePayload); }
  catch { return reject("STORED_STATE_INVALID"); }
  if (!OUTBOX_ID.test(row.outbox_id) || !ACTIVATION_ID.test(row.activation_id)
    || !CHECKPOINT_ID.test(row.plan_checkpoint_id) || !PLAN_SET_ID.test(row.plan_set_id)
    || !SHA256.test(row.discovery_lineage_sha256) || !SHA256.test(row.payload_sha256)
    || canonicalJson(payload) !== row.payload_json || await sha256(row.payload_json) !== row.payload_sha256
    || payload.activationId !== row.activation_id || payload.planCheckpointId !== row.plan_checkpoint_id
    || payload.planSetId !== row.plan_set_id || payload.scope.organizationId !== row.org_id
    || payload.scope.customerId !== row.customer_id || payload.scope.connectionId !== row.connection_id) {
    reject("STORED_STATE_INVALID");
  }
  const leaseExpiresAt = row.lease_expires_at === null ? null : asDate(row.lease_expires_at, true);
  const dispatchedAt = row.dispatched_at === null ? null : asDate(row.dispatched_at, true);
  return deepFreeze({
    outboxId: row.outbox_id,
    scope: { organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id },
    activationId: row.activation_id, planCheckpointId: row.plan_checkpoint_id,
    planSetId: row.plan_set_id, discoveryLineageSha256: row.discovery_lineage_sha256,
    payload, payloadSha256: row.payload_sha256, state: row.state, deliveryAttempt,
    leaseExpiresAtIso: leaseExpiresAt === null ? null : new Date(leaseExpiresAt).toISOString(),
    dispatchedAtIso: dispatchedAt === null ? null : new Date(dispatchedAt).toISOString(),
    createdAtIso: new Date(createdAt).toISOString(), updatedAtIso: new Date(updatedAt).toISOString(),
  });
}

function sameCapability(left: StoredComputeOptimizerCapability, right: {
  accountId: string; partition: Partition; regions: readonly string[]; manifestSha256: string;
  verifiedAtMs: number; enabled: boolean;
}): boolean {
  return left.accountId === right.accountId && left.partition === right.partition
    && canonicalJson(left.regions) === canonicalJson(right.regions)
    && left.manifestSha256 === right.manifestSha256
    && Date.parse(left.verifiedAtIso) === right.verifiedAtMs && left.enabled === right.enabled;
}

export class ComputeOptimizerActivationRepository {
  private readonly database: D1Database;
  private readonly clock: () => number;

  public constructor(database: D1Database = getRawDb(), clock: () => number = Date.now) {
    this.database = database;
    this.clock = clock;
  }

  private async ready(): Promise<void> { await ensureRuntimeSchema(this.database); }
  private async liveScope(scope: ComputeOptimizerActivationPersistenceScope): Promise<void> {
    assertScope(scope);
    await this.ready();
    const row = await this.database.prepare(
      `SELECT c.id FROM aws_connections c
       JOIN organizations o ON o.id=c.org_id AND o.status='active'
       JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
       WHERE c.org_id=? AND c.customer_id=? AND c.id=?
         AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
  }
  private async capabilityById(scope: ComputeOptimizerActivationPersistenceScope, id: string) {
    const row = await this.database.prepare(
      `SELECT * FROM finops_co_materialization_capabilities
       WHERE org_id=? AND customer_id=? AND connection_id=? AND capability_id=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, id).first<CapabilityRow>();
    return row === null ? null : capabilityFrom(row);
  }
  private async currentCapability(scope: ComputeOptimizerActivationPersistenceScope) {
    const row = await this.database.prepare(
      `SELECT c.* FROM finops_co_materialization_capability_heads h
       JOIN finops_co_materialization_capabilities c ON c.capability_id=h.active_capability_id
       WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<CapabilityRow>();
    return row === null ? null : capabilityFrom(row);
  }
  private async activationById(scope: ComputeOptimizerActivationPersistenceScope, id: string) {
    const row = await this.database.prepare(
      `SELECT * FROM finops_co_activation_runs
       WHERE org_id=? AND customer_id=? AND connection_id=? AND activation_id=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, id).first<ActivationRow>();
    return row === null ? null : activationFrom(row);
  }
  private async launchCheckpointByRegion(
    scope: ComputeOptimizerActivationPersistenceScope,
    activationId: string,
    region: string,
  ) {
    const row = await this.database.prepare(
      `SELECT * FROM finops_co_activation_launch_checkpoints
       WHERE org_id=? AND customer_id=? AND connection_id=?
         AND activation_id=? AND region=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId,
      activationId, region).first<LaunchCheckpointRow>();
    return row === null ? null : launchCheckpointFrom(row);
  }
  private async outboxById(scope: ComputeOptimizerActivationPersistenceScope, id: string) {
    const row = await this.database.prepare(
      `SELECT * FROM finops_co_materializer_outbox
       WHERE org_id=? AND customer_id=? AND connection_id=? AND outbox_id=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, id).first<OutboxRow>();
    return row === null ? null : outboxFrom(row);
  }
  private async discoverySealByRun(
    scope: ComputeOptimizerActivationPersistenceScope,
    runId: string,
  ): Promise<DiscoverySealRow | null> {
    return this.database.prepare(
      `SELECT * FROM finops_co_discovery_evidence_seals
       WHERE org_id=? AND customer_id=? AND connection_id=? AND run_id=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, runId)
      .first<DiscoverySealRow>();
  }

  public async recordCapability(
    scope: ComputeOptimizerActivationPersistenceScope,
    unsafeInput: RecordComputeOptimizerCapabilityInput,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerCapability> {
    assertScope(scope);
    if (!isRecord(unsafeInput) || !exactKeys(unsafeInput, [
      "accountId", "partition", "regions", "manifestSha256", "verifiedAtMs", "enabled",
    ]) || !ACCOUNT_ID.test(unsafeInput.accountId)
      || (unsafeInput.partition !== "aws" && unsafeInput.partition !== "aws-us-gov"
        && unsafeInput.partition !== "aws-cn")
      || !SHA256.test(unsafeInput.manifestSha256) || typeof unsafeInput.enabled !== "boolean") {
      reject("INVALID_INPUT");
    }
    const createdAt = asDate(nowMs);
    const verifiedAt = asDate(unsafeInput.verifiedAtMs);
    if (verifiedAt > createdAt) reject("INVALID_INPUT");
    const regions = canonicalRegions(unsafeInput.regions, unsafeInput.partition);
    await this.liveScope(scope);
    const body = {
      schemaVersion: "sutra.compute-optimizer-capability.v1", scope, accountId: unsafeInput.accountId,
      partition: unsafeInput.partition, permissionPackVersion: PERMISSION_PACK, regions,
      manifestSha256: unsafeInput.manifestSha256, verifiedAtMs: verifiedAt, enabled: unsafeInput.enabled,
    };
    const contentSha256 = await sha256(canonicalJson(body));
    const capabilityId = `cocp_${contentSha256}`;
    const prior = await this.capabilityById(scope, capabilityId);
    if (prior !== null && !sameCapability(prior, { ...unsafeInput, regions })) reject("IMMUTABLE_CONFLICT");
    try {
      await this.database.batch([
        this.database.prepare(
          `INSERT INTO finops_co_materialization_capabilities (
            capability_id,org_id,customer_id,connection_id,account_id,partition,
            permission_pack_version,regions_json,region_count,manifest_sha256,
            verified_at,state,content_sha256,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
        ).bind(capabilityId, scope.organizationId, scope.customerId, scope.connectionId,
          unsafeInput.accountId, unsafeInput.partition, PERMISSION_PACK, JSON.stringify(regions),
          regions.length, unsafeInput.manifestSha256, verifiedAt,
          unsafeInput.enabled ? "ENABLED" : "DISABLED", contentSha256, createdAt),
        this.database.prepare(
          `INSERT INTO finops_co_materialization_capability_heads
            (org_id,customer_id,connection_id,active_capability_id,updated_at)
           VALUES (?,?,?,?,?) ON CONFLICT (org_id,customer_id,connection_id) DO UPDATE SET
             active_capability_id=excluded.active_capability_id,updated_at=excluded.updated_at`,
        ).bind(scope.organizationId, scope.customerId, scope.connectionId, capabilityId, createdAt),
      ]);
    } catch {
      const raced = await this.capabilityById(scope, capabilityId);
      if (raced !== null && sameCapability(raced, { ...unsafeInput, regions })) {
        const current = await this.currentCapability(scope);
        if (current?.capabilityId === capabilityId) return current;
      }
      reject("IMMUTABLE_CONFLICT");
    }
    const stored = await this.currentCapability(scope);
    if (stored === null || stored.capabilityId !== capabilityId) reject("IMMUTABLE_CONFLICT");
    return stored;
  }

  public async getCurrentCapability(scope: ComputeOptimizerActivationPersistenceScope) {
    await this.liveScope(scope);
    return this.currentCapability(scope);
  }

  public async listEnabledCapabilities(
    organizationId: string | null,
    limit = 100,
  ): Promise<readonly StoredComputeOptimizerCapability[]> {
    if (organizationId !== null && !IDENTIFIER.test(organizationId)) reject("INVALID_INPUT");
    const bounded = integer(limit, 1, 500);
    await this.ready();
    const rows = await this.database.prepare(
      `SELECT c.* FROM finops_co_materialization_capability_heads h
       JOIN finops_co_materialization_capabilities c ON c.capability_id=h.active_capability_id
       JOIN aws_connections a ON a.id=c.connection_id AND a.org_id=c.org_id
         AND a.customer_id=c.customer_id AND a.source_kind='aws_trust_role' AND a.status='active'
       JOIN organizations o ON o.id=c.org_id AND o.status='active'
       JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
       WHERE c.state='ENABLED' AND (? IS NULL OR c.org_id=?)
       ORDER BY c.org_id,c.customer_id,c.connection_id LIMIT ?`,
    ).bind(organizationId, organizationId, bounded).all<CapabilityRow>();
    return Promise.all((rows.results ?? []).map(capabilityFrom));
  }

  public async createDailyActivation(
    scope: ComputeOptimizerActivationPersistenceScope,
    unsafeInput: CreateComputeOptimizerActivationInput,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerActivation> {
    assertScope(scope);
    if (!isRecord(unsafeInput) || !exactKeys(unsafeInput,
      ["capabilityId", "activation", "sealedAtMs", "attempt"])
      || !CAPABILITY_ID.test(unsafeInput.capabilityId)) reject("INVALID_INPUT");
    const createdAt = asDate(nowMs);
    const sealedAt = asDate(unsafeInput.sealedAtMs);
    const attempt = integer(unsafeInput.attempt, 1, 25);
    let activation: ComputeOptimizerMaterializationActivation;
    try { activation = await verifyComputeOptimizerMaterializationActivation(unsafeInput.activation); }
    catch { return reject("INVALID_INPUT"); }
    const windowMs = dailyWindow(activation.scheduledWindow);
    if (sealedAt < windowMs || sealedAt >= windowMs + DAY_MS
      || activation.launchAttempts.some((entry) => Date.parse(entry.sealedAtIso) !== sealedAt
        || entry.attemptNumber !== attempt)) reject("INVALID_INPUT");
    if (activation.scope.orgId !== scope.organizationId
      || activation.scope.customerId !== scope.customerId
      || activation.scope.connectionId !== scope.connectionId) reject("INVALID_INPUT");
    await this.liveScope(scope);
    const capability = await this.currentCapability(scope);
    if (capability === null || !capability.enabled
      || capability.capabilityId !== unsafeInput.capabilityId
      || capability.accountId !== activation.requesterAccountId
      || capability.partition !== activation.partition
      || canonicalJson(capability.regions) !== canonicalJson(activation.regions)) {
      reject("CAPABILITY_NOT_ENABLED");
    }
    const existing = await this.activationById(scope, activation.activationId);
    if (existing !== null) return existing;
    try {
      await this.database.prepare(
        `INSERT INTO finops_co_activation_runs (
          activation_id,org_id,customer_id,connection_id,capability_id,account_id,partition,
          scheduled_window,sealed_at,attempt,state,activation_content_sha256,revision,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,'SEALED',?,0,?,?)`,
      ).bind(activation.activationId, scope.organizationId, scope.customerId, scope.connectionId,
        capability.capabilityId, activation.requesterAccountId, activation.partition,
        activation.scheduledWindow, sealedAt, attempt, activation.contentSha256, createdAt, createdAt).run();
    } catch {
      const raced = await this.activationById(scope, activation.activationId);
      if (raced !== null && raced.capabilityId === capability.capabilityId
        && raced.activationContentSha256 === activation.contentSha256
        && raced.scheduledWindow === activation.scheduledWindow && raced.sealedAtIso === new Date(sealedAt).toISOString()) {
        return raced;
      }
      reject("IMMUTABLE_CONFLICT");
    }
    return await this.activationById(scope, activation.activationId)
      ?? reject("IMMUTABLE_CONFLICT");
  }

  public async getActivation(scope: ComputeOptimizerActivationPersistenceScope, activationId: string) {
    if (!ACTIVATION_ID.test(activationId)) reject("INVALID_INPUT");
    await this.liveScope(scope);
    return this.activationById(scope, activationId);
  }

  public async getLatestActivation(
    scope: ComputeOptimizerActivationPersistenceScope,
  ): Promise<StoredComputeOptimizerActivation | null> {
    await this.liveScope(scope);
    const row = await this.database.prepare(
      `SELECT * FROM finops_co_activation_runs
       WHERE org_id=? AND customer_id=? AND connection_id=?
       ORDER BY scheduled_window DESC,activation_id DESC LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<ActivationRow>();
    return row === null ? null : activationFrom(row);
  }

  public async recordRegionalLaunchCheckpoint(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: RecordComputeOptimizerRegionalLaunchCheckpointInput,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerRegionalLaunchCheckpoint> {
    assertScope(scope);
    if (!isRecord(input) || !exactKeys(input, ["activation", "region", "execution"])
      || typeof input.region !== "string" || !REGION.test(input.region)) reject("INVALID_INPUT");
    const createdAt = asDate(nowMs);
    let activation: ComputeOptimizerMaterializationActivation;
    try { activation = await verifyComputeOptimizerMaterializationActivation(input.activation); }
    catch { return reject("INVALID_INPUT"); }
    if (activation.scope.orgId !== scope.organizationId
      || activation.scope.customerId !== scope.customerId
      || activation.scope.connectionId !== scope.connectionId) reject("INVALID_INPUT");
    const launchAttempt = activation.launchAttempts.find(({ region }) => region === input.region);
    if (launchAttempt === undefined) reject("INVALID_INPUT");
    let execution: ComputeOptimizerExportLaunchExecution;
    try { execution = await verifyComputeOptimizerExportLaunchExecution(launchAttempt, input.execution); }
    catch { return reject("INVALID_INPUT"); }
    if (execution.status !== "COMPLETE"
      || execution.outcomes.some(({ status }) => status !== "SUCCEEDED")) reject("INVALID_INPUT");
    const launchOutcomeProof = await Promise.all(execution.outcomes.map(async (outcome) => {
      if (outcome.status !== "SUCCEEDED") return reject("INVALID_INPUT");
      return {
        exportFamily: outcome.exportFamily,
        jobId: outcome.jobId,
        bucketSha256: await sha256(outcome.bucket),
        objectKeySha256: await sha256(outcome.objectKey),
        metadataKeySha256: await sha256(outcome.metadataKey),
      };
    }));
    const launchOutcomeProofSha256 = await sha256(canonicalJson({
      schemaVersion: "sutra.compute-optimizer-launch-outcome-proof.v1",
      activationId: activation.activationId, region: input.region,
      outcomes: launchOutcomeProof,
    }));
    const body = {
      schemaVersion: "sutra.compute-optimizer-regional-launch-checkpoint.v1",
      scope, activationId: activation.activationId, region: input.region,
      attempt: launchAttempt.attemptNumber, launchAttemptId: launchAttempt.launchAttemptId,
      launchAttemptSha256: launchAttempt.contentSha256, executionId: execution.executionId,
      executionSha256: execution.contentSha256, launchOutcomeProofSha256,
    };
    const contentSha256 = await sha256(canonicalJson(body));
    const checkpointId = `coalc_${contentSha256}`;
    await this.liveScope(scope);
    const storedActivation = await this.activationById(scope, activation.activationId);
    if (storedActivation === null) reject("ACTIVATION_NOT_FOUND");
    if (storedActivation.state !== "SEALED" || storedActivation.attempt !== launchAttempt.attemptNumber
      || storedActivation.activationContentSha256 !== activation.contentSha256) reject("CAS_MISMATCH");
    const prior = await this.launchCheckpointByRegion(scope, activation.activationId, input.region);
    if (prior !== null) {
      if (prior.checkpointId !== checkpointId) reject("IMMUTABLE_CONFLICT");
      return prior;
    }
    try {
      await this.database.prepare(
        `INSERT INTO finops_co_activation_launch_checkpoints (
          checkpoint_id,org_id,customer_id,connection_id,activation_id,region,attempt,
          launch_attempt_id,launch_attempt_sha256,execution_id,execution_sha256,
          launch_outcome_proof_sha256,content_sha256,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(checkpointId, scope.organizationId, scope.customerId, scope.connectionId,
        activation.activationId, input.region, launchAttempt.attemptNumber,
        launchAttempt.launchAttemptId, launchAttempt.contentSha256, execution.executionId,
        execution.contentSha256, launchOutcomeProofSha256, contentSha256, createdAt).run();
    } catch {
      const raced = await this.launchCheckpointByRegion(scope, activation.activationId, input.region);
      if (raced !== null && raced.checkpointId === checkpointId) return raced;
      reject("IMMUTABLE_CONFLICT");
    }
    return await this.launchCheckpointByRegion(scope, activation.activationId, input.region)
      ?? reject("IMMUTABLE_CONFLICT");
  }

  public async listRegionalLaunchCheckpoints(
    scope: ComputeOptimizerActivationPersistenceScope,
    activationId: string,
  ): Promise<readonly StoredComputeOptimizerRegionalLaunchCheckpoint[]> {
    if (!ACTIVATION_ID.test(activationId)) reject("INVALID_INPUT");
    await this.liveScope(scope);
    const rows = await this.database.prepare(
      `SELECT * FROM finops_co_activation_launch_checkpoints
       WHERE org_id=? AND customer_id=? AND connection_id=? AND activation_id=?
       ORDER BY region ASC`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId,
      activationId).all<LaunchCheckpointRow>();
    return Promise.all((rows.results ?? []).map(launchCheckpointFrom));
  }

  public async getOrCreateSealedEvidenceReference(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: GetOrCreateComputeOptimizerSealedEvidenceReferenceInput,
    createCiphertext: (binding: Readonly<{
      scope: ComputeOptimizerActivationPersistenceScope;
      runId: string;
      evidenceContentSha256: string;
      objectId: string;
    }>) => Promise<{ readonly ciphertext: string; readonly keyVersion: string }>,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerSealedEvidenceReference> {
    assertScope(scope);
    if (!isRecord(input) || !exactKeys(input,
      ["runId", "evidenceContentSha256", "objectId"])
      || !DISCOVERY_RUN_ID.test(input.runId) || !SHA256.test(input.evidenceContentSha256)
      || !OBJECT_ID.test(input.objectId) || typeof createCiphertext !== "function") {
      reject("INVALID_INPUT");
    }
    const startedAt = asDate(nowMs);
    const leaseExpiresAt = startedAt + DISCOVERY_SEAL_LEASE_MS;
    if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt > MAX_DATE_MS) reject("INVALID_INPUT");
    await this.liveScope(scope);
    const bindingBody = {
      schemaVersion: "sutra.compute-optimizer-discovery-evidence-seal-binding.v1",
      scope, runId: input.runId, evidenceContentSha256: input.evidenceContentSha256,
      objectId: input.objectId,
    };
    const bindingSha256 = await sha256(canonicalJson(bindingBody));
    const sealId = `cose_${bindingSha256}`;
    const exactBinding = (row: DiscoverySealRow): boolean => row.seal_id === sealId
      && row.evidence_content_sha256 === input.evidenceContentSha256
      && row.object_id === input.objectId && row.binding_sha256 === bindingSha256;
    const existing = await this.discoverySealByRun(scope, input.runId);
    if (existing !== null) {
      if (!exactBinding(existing)) reject("IMMUTABLE_CONFLICT");
      if (existing.state === "SEALED") return sealedEvidenceFrom(existing);
      if (asDate(existing.lease_expires_at, true) > startedAt) reject("CAS_MISMATCH");
    }
    const liveBinding = await this.database.prepare(
      `SELECT r.run_id FROM finops_co_discovery_runs r
       JOIN evidence_objects e ON e.id=? AND e.org_id=r.org_id
         AND e.customer_id=r.customer_id AND e.connection_id=r.connection_id
         AND e.run_id=r.run_id AND e.content_sha256=? AND e.status='available'
       WHERE r.org_id=? AND r.customer_id=? AND r.connection_id=?
         AND r.run_id=? AND r.status='running' LIMIT 1`,
    ).bind(input.objectId, input.evidenceContentSha256, scope.organizationId,
      scope.customerId, scope.connectionId, input.runId).first<{ run_id: string }>();
    if (liveBinding === null) reject("PLAN_LINEAGE_NOT_FOUND");
    const claimTokenSha256 = await sha256(crypto.randomUUID());
    try {
      if (existing === null) {
        await this.database.prepare(
          `INSERT INTO finops_co_discovery_evidence_seals (
            seal_id,org_id,customer_id,connection_id,run_id,evidence_content_sha256,
            object_id,binding_sha256,state,claim_token_sha256,lease_expires_at,
            created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,'RESERVING',?,?,?,?)`,
        ).bind(sealId, scope.organizationId, scope.customerId, scope.connectionId,
          input.runId, input.evidenceContentSha256, input.objectId, bindingSha256,
          claimTokenSha256, leaseExpiresAt, startedAt, startedAt).run();
      } else {
        const outcome = await this.database.prepare(
          `UPDATE finops_co_discovery_evidence_seals SET claim_token_sha256=?,
             lease_expires_at=?,updated_at=?
           WHERE org_id=? AND customer_id=? AND connection_id=? AND run_id=?
             AND state='RESERVING' AND claim_token_sha256=? AND lease_expires_at<=?`,
        ).bind(claimTokenSha256, leaseExpiresAt, startedAt, scope.organizationId,
          scope.customerId, scope.connectionId, input.runId, existing.claim_token_sha256,
          startedAt).run();
        if ((outcome.meta?.changes ?? 0) === 0) reject("CAS_MISMATCH");
      }
    } catch (error) {
      if (error instanceof ComputeOptimizerActivationRepositoryError) throw error;
      const raced = await this.discoverySealByRun(scope, input.runId);
      if (raced !== null && exactBinding(raced) && raced.state === "SEALED") {
        return sealedEvidenceFrom(raced);
      }
      reject("CAS_MISMATCH");
    }
    let unsafeReference: unknown;
    try { unsafeReference = await createCiphertext(deepFreeze({ scope: { ...scope }, ...input })); }
    catch { return reject("CAS_MISMATCH"); }
    if (!isRecord(unsafeReference) || !exactKeys(unsafeReference, ["ciphertext", "keyVersion"])
      || typeof unsafeReference.ciphertext !== "string"
      || !SEALED_REFERENCE.test(unsafeReference.ciphertext)
      || typeof unsafeReference.keyVersion !== "string"
      || !KEY_VERSION.test(unsafeReference.keyVersion)) reject("INVALID_INPUT");
    const completedAt = asDate(this.clock());
    if (completedAt < startedAt || completedAt > leaseExpiresAt) reject("CAS_MISMATCH");
    const ciphertextSha256 = await sha256(unsafeReference.ciphertext);
    const finalized = await this.database.prepare(
      `UPDATE finops_co_discovery_evidence_seals SET state='SEALED',ciphertext=?,
         key_version=?,ciphertext_sha256=?,updated_at=?
       WHERE org_id=? AND customer_id=? AND connection_id=? AND run_id=?
         AND state='RESERVING' AND claim_token_sha256=? AND lease_expires_at>=?`,
    ).bind(unsafeReference.ciphertext, unsafeReference.keyVersion, ciphertextSha256,
      completedAt, scope.organizationId, scope.customerId, scope.connectionId,
      input.runId, claimTokenSha256, completedAt).run();
    const stored = await this.discoverySealByRun(scope, input.runId);
    if (stored === null || !exactBinding(stored)) reject("IMMUTABLE_CONFLICT");
    if ((finalized.meta?.changes ?? 0) === 0 && stored.state !== "SEALED") reject("CAS_MISMATCH");
    return sealedEvidenceFrom(stored);
  }

  public async finalizeLaunchCheckpoints(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: { readonly activationId: string; readonly expectedAttempt: number },
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerActivation> {
    if (!isRecord(input) || !exactKeys(input, ["activationId", "expectedAttempt"])
      || !ACTIVATION_ID.test(input.activationId)) reject("INVALID_INPUT");
    const attempt = integer(input.expectedAttempt, 1, 25);
    const updatedAt = asDate(nowMs);
    await this.liveScope(scope);
    const coverage = await this.database.prepare(
      `SELECT c.region_count AS expected_count,COUNT(k.checkpoint_id) AS actual_count
       FROM finops_co_activation_runs a
       JOIN finops_co_materialization_capabilities c ON c.capability_id=a.capability_id
       LEFT JOIN finops_co_activation_launch_checkpoints k
         ON k.activation_id=a.activation_id AND k.attempt=a.attempt
       WHERE a.org_id=? AND a.customer_id=? AND a.connection_id=?
         AND a.activation_id=? AND a.state='SEALED' AND a.attempt=?
       GROUP BY c.region_count`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId,
      input.activationId, attempt).first<{ expected_count: number | string; actual_count: number | string }>();
    if (coverage === null || integer(coverage.expected_count, 1, 50, true)
      !== integer(coverage.actual_count, 0, 50, true)) reject("CAS_MISMATCH");
    const result = await this.database.prepare(
      `UPDATE finops_co_activation_runs SET state='DISCOVERY_PENDING',revision=revision+1,updated_at=?
       WHERE org_id=? AND customer_id=? AND connection_id=? AND activation_id=?
         AND state='SEALED' AND attempt=?`,
    ).bind(updatedAt, scope.organizationId, scope.customerId, scope.connectionId,
      input.activationId, attempt).run();
    const stored = await this.activationById(scope, input.activationId);
    if (stored === null) reject("ACTIVATION_NOT_FOUND");
    if ((result.meta?.changes ?? 0) === 0 && stored.state !== "DISCOVERY_PENDING") reject("CAS_MISMATCH");
    return stored;
  }

  public async listRecoverableActivations(
    organizationId: string | null,
    limit = 100,
  ): Promise<readonly StoredComputeOptimizerActivation[]> {
    if (organizationId !== null && !IDENTIFIER.test(organizationId)) reject("INVALID_INPUT");
    const bounded = integer(limit, 1, 500);
    await this.ready();
    const rows = await this.database.prepare(
      `SELECT a.* FROM finops_co_activation_runs a
       JOIN finops_co_materialization_capability_heads h ON h.org_id=a.org_id
         AND h.customer_id=a.customer_id AND h.connection_id=a.connection_id
         AND h.active_capability_id=a.capability_id
       JOIN finops_co_materialization_capabilities c ON c.capability_id=h.active_capability_id
         AND c.state='ENABLED'
       JOIN aws_connections w ON w.id=a.connection_id AND w.org_id=a.org_id
         AND w.customer_id=a.customer_id AND w.source_kind='aws_trust_role' AND w.status='active'
       WHERE a.state IN ('SEALED','DISCOVERY_PENDING','RECONCILING')
         AND (? IS NULL OR a.org_id=?)
       ORDER BY a.scheduled_window,a.activation_id LIMIT ?`,
    ).bind(organizationId, organizationId, bounded).all<ActivationRow>();
    return (rows.results ?? []).map(activationFrom);
  }

  public async transitionActivation(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: TransitionComputeOptimizerActivationInput,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerActivation> {
    assertScope(scope);
    const states = new Set<ComputeOptimizerActivationState>([
      "SEALED", "RECONCILING", "DISCOVERY_PENDING", "MATERIALIZATION_PENDING", "COMPLETE", "FAILED",
    ]);
    if (!isRecord(input) || !exactKeys(input, [
      "activationId", "expectedState", "nextState", "expectedAttempt", "nextAttempt", "failureCode",
    ]) || !ACTIVATION_ID.test(input.activationId) || !states.has(input.expectedState)
      || !states.has(input.nextState) || (input.failureCode !== null
        && (typeof input.failureCode !== "string" || !FAILURE_CODE.test(input.failureCode)))) {
      reject("INVALID_INPUT");
    }
    const expectedAttempt = integer(input.expectedAttempt, 1, 25);
    const nextAttempt = integer(input.nextAttempt, 1, 25);
    const updatedAt = asDate(nowMs);
    if ((input.nextState === "FAILED") !== (input.failureCode !== null)) reject("INVALID_INPUT");
    const failureHash = input.failureCode === null ? null : await sha256(input.failureCode);
    await this.liveScope(scope);
    const result = await this.database.prepare(
      `UPDATE finops_co_activation_runs SET state=?,attempt=?,failure_code_sha256=?,
         revision=revision+1,updated_at=?
       WHERE org_id=? AND customer_id=? AND connection_id=? AND activation_id=?
         AND state=? AND attempt=?`,
    ).bind(input.nextState, nextAttempt, failureHash, updatedAt, scope.organizationId,
      scope.customerId, scope.connectionId, input.activationId, input.expectedState, expectedAttempt).run();
    const stored = await this.activationById(scope, input.activationId);
    if (stored === null) reject("ACTIVATION_NOT_FOUND");
    if ((result.meta?.changes ?? 0) === 0) {
      if (stored.state === input.nextState && stored.attempt === nextAttempt
        && stored.failureCodeSha256 === failureHash) return stored;
      reject("CAS_MISMATCH");
    }
    return stored;
  }

  public async stageReadyAndOutbox(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: StageComputeOptimizerMaterializerInput,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerMaterializerOutbox> {
    assertScope(scope);
    if (!isRecord(input) || !exactKeys(input, [
      "activation", "checkpoint", "regionalPlans", "regionalPlanDiscoveryReferences", "regionContracts",
    ]) || !Array.isArray(input.regionalPlans) || !Array.isArray(input.regionalPlanDiscoveryReferences)
      || !Array.isArray(input.regionContracts)) reject("INVALID_INPUT");
    const updatedAt = asDate(nowMs);
    let activation: ComputeOptimizerMaterializationActivation;
    let checkpoint: ComputeOptimizerMaterializationPlanCheckpoint;
    try {
      activation = await verifyComputeOptimizerMaterializationActivation(input.activation);
      checkpoint = await verifyComputeOptimizerMaterializationPlanCheckpoint(activation, input.checkpoint);
    } catch { return reject("INVALID_INPUT"); }
    if (checkpoint.status !== "PLAN_SET_READY" || checkpoint.planSet === null
      || canonicalJson(input.regionalPlans) !== canonicalJson(checkpoint.planSet.plans)) reject("INVALID_INPUT");
    if (activation.scope.orgId !== scope.organizationId
      || activation.scope.customerId !== scope.customerId
      || activation.scope.connectionId !== scope.connectionId) reject("INVALID_INPUT");
    const references = input.regionalPlanDiscoveryReferences.map((value, index) => {
      if (!isRecord(value) || !exactKeys(value, ["region", "planId", "discoveryRunId"])
        || value.region !== activation.regions[index] || value.planId !== checkpoint.planSet!.planIds[index]
        || typeof value.discoveryRunId !== "string" || !DISCOVERY_RUN_ID.test(value.discoveryRunId)) {
        return reject("INVALID_INPUT");
      }
      return deepFreeze({ region: value.region as string, planId: value.planId as string,
        discoveryRunId: value.discoveryRunId });
    });
    if (references.length !== activation.regions.length
      || new Set(references.map(({ discoveryRunId }) => discoveryRunId)).size !== references.length) {
      reject("INVALID_INPUT");
    }
    let payload: ComputeOptimizerMaterializationJobPayload;
    try {
      payload = await parseComputeOptimizerMaterializationJobPayload({
        schemaVersion: "sutra.compute-optimizer-materialization-job.v1",
        activationId: activation.activationId, planCheckpointId: checkpoint.checkpointId,
        scheduledWindow: activation.scheduledWindow,
        scope: { organizationId: scope.organizationId, customerId: scope.customerId,
          connectionId: scope.connectionId },
        requesterAccountId: activation.requesterAccountId, partition: activation.partition,
        planSetId: checkpoint.planSet.planSetId,
        planSetContentSha256: checkpoint.planSet.contentSha256,
        regionContracts: input.regionContracts,
      });
    } catch { return reject("INVALID_INPUT"); }
    const payloadJson = canonicalJson(payload);
    const payloadSha256 = await sha256(payloadJson);
    const discoveryLineageSha256 = await sha256(canonicalJson({
      schemaVersion: "sutra.compute-optimizer-discovery-lineage.v1", activationId: activation.activationId,
      planCheckpointId: checkpoint.checkpointId, references,
    }));
    const outboxSha = await sha256(canonicalJson({
      schemaVersion: "sutra.compute-optimizer-materializer-outbox.v1",
      activationId: activation.activationId, planCheckpointId: checkpoint.checkpointId,
      planSetId: checkpoint.planSet.planSetId, discoveryLineageSha256, payloadSha256,
    }));
    const outboxId = `coob_${outboxSha}`;
    await this.liveScope(scope);
    const current = await this.currentCapability(scope);
    const storedActivation = await this.activationById(scope, activation.activationId);
    if (current === null || !current.enabled || storedActivation === null
      || storedActivation.capabilityId !== current.capabilityId
      || storedActivation.activationContentSha256 !== activation.contentSha256) {
      reject(storedActivation === null ? "ACTIVATION_NOT_FOUND" : "CAPABILITY_NOT_ENABLED");
    }
    const planSet = await this.database.prepare(
      `SELECT plan_set_id FROM finops_co_export_plan_sets
       WHERE org_id=? AND customer_id=? AND connection_id=? AND plan_set_id=?
         AND content_sha256=? AND finalized=1 LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId,
      checkpoint.planSet.planSetId, checkpoint.planSet.contentSha256).first<{ plan_set_id: string }>();
    if (planSet === null) reject("PLAN_LINEAGE_NOT_FOUND");
    for (const reference of references) {
      const found = await this.database.prepare(
        `SELECT p.plan_id FROM finops_co_export_plans p
         JOIN finops_co_discovery_runs d ON d.run_id=p.discovery_run_id
           AND d.org_id=p.org_id AND d.customer_id=p.customer_id AND d.connection_id=p.connection_id
           AND d.status IN ('complete','partial') AND d.finalized_at IS NOT NULL
         WHERE p.org_id=? AND p.customer_id=? AND p.connection_id=?
           AND p.plan_id=? AND p.discovery_run_id=? AND p.region=? LIMIT 1`,
      ).bind(scope.organizationId, scope.customerId, scope.connectionId,
        reference.planId, reference.discoveryRunId, reference.region).first<{ plan_id: string }>();
      if (found === null) reject("PLAN_LINEAGE_NOT_FOUND");
    }
    const replay = await this.outboxById(scope, outboxId);
    if (replay !== null) return replay;
    if (storedActivation.state !== "RECONCILING") reject("CAS_MISMATCH");
    try {
      await this.database.batch([
        this.database.prepare(
          `UPDATE finops_co_activation_runs SET state='MATERIALIZATION_PENDING',
             plan_checkpoint_id=?,plan_checkpoint_sha256=?,plan_set_id=?,
             discovery_lineage_sha256=?,revision=revision+1,updated_at=?
           WHERE org_id=? AND customer_id=? AND connection_id=? AND activation_id=?
             AND state='RECONCILING' AND plan_checkpoint_id IS NULL`,
        ).bind(checkpoint.checkpointId, checkpoint.contentSha256, checkpoint.planSet.planSetId,
          discoveryLineageSha256, updatedAt, scope.organizationId, scope.customerId,
          scope.connectionId, activation.activationId),
        this.database.prepare(
          `INSERT INTO finops_co_materializer_outbox (
            outbox_id,org_id,customer_id,connection_id,activation_id,plan_checkpoint_id,
            plan_set_id,discovery_lineage_sha256,payload_json,payload_sha256,state,
            delivery_attempt,created_at,updated_at
          ) SELECT ?,?,?,?,?,?,?,?,?,?,'PENDING',0,?,?
            WHERE EXISTS (SELECT 1 FROM finops_co_activation_runs a
              WHERE a.activation_id=? AND a.org_id=? AND a.customer_id=? AND a.connection_id=?
                AND a.state='MATERIALIZATION_PENDING' AND a.plan_checkpoint_id=?)`,
        ).bind(outboxId, scope.organizationId, scope.customerId, scope.connectionId,
          activation.activationId, checkpoint.checkpointId, checkpoint.planSet.planSetId,
          discoveryLineageSha256, payloadJson, payloadSha256, updatedAt, updatedAt,
          activation.activationId, scope.organizationId, scope.customerId, scope.connectionId,
          checkpoint.checkpointId),
      ]);
    } catch {
      const raced = await this.outboxById(scope, outboxId);
      if (raced !== null) return raced;
      reject("IMMUTABLE_CONFLICT");
    }
    return await this.outboxById(scope, outboxId) ?? reject("IMMUTABLE_CONFLICT");
  }

  public async listDispatchable(
    scope: ComputeOptimizerActivationPersistenceScope,
    limit = 25,
  ): Promise<readonly StoredComputeOptimizerMaterializerOutbox[]> {
    const bounded = integer(limit, 1, 100);
    await this.liveScope(scope);
    const rows = await this.database.prepare(
      `SELECT * FROM finops_co_materializer_outbox
       WHERE org_id=? AND customer_id=? AND connection_id=? AND state='PENDING'
       ORDER BY created_at ASC,outbox_id ASC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, bounded).all<OutboxRow>();
    return Promise.all((rows.results ?? []).map(outboxFrom));
  }

  public async listOutboxWork(
    organizationId: string | null,
    nowMs: number,
    limit = 100,
  ): Promise<readonly StoredComputeOptimizerMaterializerOutbox[]> {
    if (organizationId !== null && !IDENTIFIER.test(organizationId)) reject("INVALID_INPUT");
    const now = asDate(nowMs);
    const bounded = integer(limit, 1, 500);
    await this.ready();
    const rows = await this.database.prepare(
      `SELECT o.* FROM finops_co_materializer_outbox o
       JOIN finops_co_activation_runs a ON a.activation_id=o.activation_id
         AND a.org_id=o.org_id AND a.customer_id=o.customer_id AND a.connection_id=o.connection_id
       JOIN finops_co_materialization_capability_heads h ON h.org_id=a.org_id
         AND h.customer_id=a.customer_id AND h.connection_id=a.connection_id
         AND h.active_capability_id=a.capability_id
       JOIN finops_co_materialization_capabilities c ON c.capability_id=h.active_capability_id
         AND c.state='ENABLED'
       WHERE (o.state IN ('PENDING','RECOVERABLE')
         OR (o.state='LEASED' AND o.lease_expires_at<=?))
         AND (? IS NULL OR o.org_id=?)
       ORDER BY o.created_at,o.outbox_id LIMIT ?`,
    ).bind(now, organizationId, organizationId, bounded).all<OutboxRow>();
    return Promise.all((rows.results ?? []).map(outboxFrom));
  }

  public async leaseOutbox(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: { readonly outboxId: string; readonly leaseToken: string;
      readonly nowMs: number; readonly leaseDurationMs: number },
  ): Promise<StoredComputeOptimizerMaterializerOutbox> {
    if (!isRecord(input) || !exactKeys(input,
      ["outboxId", "leaseToken", "nowMs", "leaseDurationMs"])
      || !OUTBOX_ID.test(input.outboxId) || !LEASE_TOKEN.test(input.leaseToken)) reject("INVALID_INPUT");
    const now = asDate(input.nowMs);
    const duration = integer(input.leaseDurationMs, 1_000, MAX_LEASE_MS);
    const expires = now + duration;
    if (!Number.isSafeInteger(expires) || expires > MAX_DATE_MS) reject("INVALID_INPUT");
    const tokenHash = await sha256(input.leaseToken);
    await this.liveScope(scope);
    const result = await this.database.prepare(
      `UPDATE finops_co_materializer_outbox SET state='LEASED',delivery_attempt=delivery_attempt+1,
         lease_token_sha256=?,lease_expires_at=?,updated_at=?
       WHERE org_id=? AND customer_id=? AND connection_id=? AND outbox_id=?
         AND state='PENDING' AND delivery_attempt<25`,
    ).bind(tokenHash, expires, now, scope.organizationId, scope.customerId,
      scope.connectionId, input.outboxId).run();
    const stored = await this.outboxById(scope, input.outboxId);
    if (stored === null) reject("CAS_MISMATCH");
    if ((result.meta?.changes ?? 0) === 0) {
      const row = await this.database.prepare(
        "SELECT lease_token_sha256 FROM finops_co_materializer_outbox WHERE outbox_id=? LIMIT 1",
      ).bind(input.outboxId).first<{ lease_token_sha256: string | null }>();
      if (stored.state === "LEASED" && row?.lease_token_sha256 === tokenHash) return stored;
      reject("CAS_MISMATCH");
    }
    return stored;
  }

  public async markOutboxDispatched(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: { readonly outboxId: string; readonly leaseToken: string; readonly nowMs: number },
  ): Promise<StoredComputeOptimizerMaterializerOutbox> {
    if (!isRecord(input) || !exactKeys(input, ["outboxId", "leaseToken", "nowMs"])
      || !OUTBOX_ID.test(input.outboxId) || !LEASE_TOKEN.test(input.leaseToken)) reject("INVALID_INPUT");
    const now = asDate(input.nowMs);
    const tokenHash = await sha256(input.leaseToken);
    await this.liveScope(scope);
    const result = await this.database.prepare(
      `UPDATE finops_co_materializer_outbox SET state='DISPATCHED',dispatched_at=?,updated_at=?
       WHERE org_id=? AND customer_id=? AND connection_id=? AND outbox_id=?
         AND state='LEASED' AND lease_token_sha256=?`,
    ).bind(now, now, scope.organizationId, scope.customerId, scope.connectionId,
      input.outboxId, tokenHash).run();
    const stored = await this.outboxById(scope, input.outboxId);
    if (stored === null) reject("CAS_MISMATCH");
    if ((result.meta?.changes ?? 0) === 0 && stored.state !== "DISPATCHED") reject("CAS_MISMATCH");
    return stored;
  }

  public async markExpiredLeaseRecoverable(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: { readonly outboxId: string; readonly nowMs: number },
  ): Promise<StoredComputeOptimizerMaterializerOutbox> {
    if (!isRecord(input) || !exactKeys(input, ["outboxId", "nowMs"])
      || !OUTBOX_ID.test(input.outboxId)) reject("INVALID_INPUT");
    const now = asDate(input.nowMs);
    await this.liveScope(scope);
    const result = await this.database.prepare(
      `UPDATE finops_co_materializer_outbox SET state='RECOVERABLE',lease_token_sha256=NULL,
         lease_expires_at=NULL,updated_at=?
       WHERE org_id=? AND customer_id=? AND connection_id=? AND outbox_id=?
         AND state='LEASED' AND lease_expires_at<=?`,
    ).bind(now, scope.organizationId, scope.customerId, scope.connectionId,
      input.outboxId, now).run();
    const stored = await this.outboxById(scope, input.outboxId);
    if (stored === null) reject("CAS_MISMATCH");
    if ((result.meta?.changes ?? 0) === 0 && stored.state !== "RECOVERABLE") reject("CAS_MISMATCH");
    return stored;
  }

  public async requeueRecoverable(
    scope: ComputeOptimizerActivationPersistenceScope,
    input: { readonly outboxId: string; readonly nowMs: number },
  ): Promise<StoredComputeOptimizerMaterializerOutbox> {
    if (!isRecord(input) || !exactKeys(input, ["outboxId", "nowMs"])
      || !OUTBOX_ID.test(input.outboxId)) reject("INVALID_INPUT");
    const now = asDate(input.nowMs);
    await this.liveScope(scope);
    const result = await this.database.prepare(
      `UPDATE finops_co_materializer_outbox SET state='PENDING',updated_at=?
       WHERE org_id=? AND customer_id=? AND connection_id=? AND outbox_id=?
         AND state='RECOVERABLE' AND delivery_attempt<25`,
    ).bind(now, scope.organizationId, scope.customerId, scope.connectionId, input.outboxId).run();
    const stored = await this.outboxById(scope, input.outboxId);
    if (stored === null) reject("CAS_MISMATCH");
    if ((result.meta?.changes ?? 0) === 0 && stored.state !== "PENDING") reject("CAS_MISMATCH");
    return stored;
  }
}
