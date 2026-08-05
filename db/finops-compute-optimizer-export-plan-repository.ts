/**
 * Immutable persistence for sealed, single-Region Compute Optimizer organization
 * export plans. Multi-Region activation uses one content-addressed plan per
 * Region so every plan has a matching regional discovery proof and bucket.
 *
 * The repository never accepts or stores plaintext plan JSON, bucket names,
 * prefixes, or object keys. Callers must seal the already-validated plan and
 * provide only its content identity and bounded, non-sensitive counts.
 */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type {
  SealedComputeOptimizerExportPlan,
} from "../lib/finops-compute-optimizer-export-plan-envelope";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const DISCOVERY_RUN_ID = /^cor_[a-f0-9]{64}$/u;
const PLAN_ID = /^cope_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const PARTITIONS = new Set(["aws", "aws-us-gov", "aws-cn"]);
const MAX_DATE_MS = 8_640_000_000_000_000;
// One immutable plan is regional because AWS creates independent export jobs,
// requires a Region-local bucket, and discovery evidence is itself regional.
// A multi-Region activation is represented by a server-owned set of regional
// plans rather than one plan weakly bound to a single discovery run.
const MAX_REGIONS = 1;
const MAX_EXPORT_FAMILIES = 8;
const MAX_TARGETS = 8;
const COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT =
  "sutra.compute-optimizer-export-plan-envelope.v1" as const;
// Kept equal to the application envelope's exported maximumCiphertextBytes.
const MAX_ENVELOPE_BYTES = 16 * 1_024 * 1_024 + 12 + 16;
const MIN_ENVELOPE_CHARACTERS = 40;
const MAX_ENVELOPE_CHARACTERS = Math.ceil(
  MAX_ENVELOPE_BYTES * 4 / 3,
);

export interface ComputeOptimizerExportPlanPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface RecordComputeOptimizerExportPlanInput {
  readonly discoveryRunId: string;
  readonly planId: string;
  readonly contentSha256: string;
  readonly requesterAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly region: string;
  readonly regionCount: number;
  readonly exportFamilyCount: number;
  readonly targetCount: number;
  readonly sealedEnvelope: SealedComputeOptimizerExportPlan;
}

export interface StoredComputeOptimizerExportPlan {
  readonly scope: ComputeOptimizerExportPlanPersistenceScope;
  readonly discoveryRunId: string;
  readonly planId: string;
  readonly contentSha256: string;
  readonly requesterAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly region: string;
  readonly regionCount: number;
  readonly exportFamilyCount: number;
  readonly targetCount: number;
  readonly sealedEnvelope: SealedComputeOptimizerExportPlan;
  readonly sealedEnvelopeSha256: string;
  readonly bindingSha256: string;
  readonly createdAtIso: string;
}

export class ComputeOptimizerExportPlanRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "DISCOVERY_RUN_NOT_FOUND"
    | "IMMUTABLE_CONFLICT"
    | "STORED_STATE_INVALID";

  public constructor(code: ComputeOptimizerExportPlanRepositoryError["code"]) {
    super("Compute Optimizer export plan persistence rejected");
    this.name = "ComputeOptimizerExportPlanRepositoryError";
    this.code = code;
  }
}

interface PlanRow {
  plan_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  discovery_run_id: string;
  content_sha256: string;
  requester_account_id: string;
  partition: StoredComputeOptimizerExportPlan["partition"];
  region: string;
  region_count: number | string;
  export_family_count: number | string;
  target_count: number | string;
  sealed_envelope_format: string;
  sealed_envelope_ciphertext: string;
  sealed_envelope_key_version: string;
  sealed_envelope_sha256: string;
  binding_sha256: string;
  created_at: number | string;
}

interface LiveScopeRow {
  aws_account_id: string;
  partition: string;
}

function reject(
  code: ComputeOptimizerExportPlanRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new ComputeOptimizerExportPlanRepositoryError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  stored = false,
): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number"
    || !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) reject(stored ? "STORED_STATE_INVALID" : "INVALID_INPUT");
  return parsed;
}

function assertScope(scope: ComputeOptimizerExportPlanPersistenceScope): void {
  if (
    !isRecord(scope)
    || !exactKeys(scope, ["organizationId", "customerId", "connectionId"])
    || typeof scope.organizationId !== "string"
    || typeof scope.customerId !== "string"
    || typeof scope.connectionId !== "string"
    || !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
  ) reject();
}

function canonicalCiphertext(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < MIN_ENVELOPE_CHARACTERS
    || value.length > MAX_ENVELOPE_CHARACTERS
    || !BASE64URL.test(value)
  ) return false;
  const remainder = value.length % 4;
  const finalCharacter = value.at(-1) ?? "";
  return remainder === 0
    || (remainder === 2 && /^[AQgw]$/u.test(finalCharacter))
    || (remainder === 3 && /^[AEIMQUYcgkosw048]$/u.test(finalCharacter));
}

function normalizeInput(
  unsafeInput: RecordComputeOptimizerExportPlanInput,
): RecordComputeOptimizerExportPlanInput {
  if (
    !isRecord(unsafeInput)
    || !exactKeys(unsafeInput, [
      "discoveryRunId",
      "planId",
      "contentSha256",
      "requesterAccountId",
      "partition",
      "region",
      "regionCount",
      "exportFamilyCount",
      "targetCount",
      "sealedEnvelope",
    ])
  ) reject();
  const input = unsafeInput;
  const regionCount = integer(input.regionCount, 1, MAX_REGIONS);
  const exportFamilyCount = integer(
    input.exportFamilyCount,
    1,
    MAX_EXPORT_FAMILIES,
  );
  const targetCount = integer(input.targetCount, 1, MAX_TARGETS);
  if (
    !DISCOVERY_RUN_ID.test(input.discoveryRunId)
    || !PLAN_ID.test(input.planId)
    || !SHA256.test(input.contentSha256)
    || input.planId !== `cope_${input.contentSha256}`
    || !ACCOUNT_ID.test(input.requesterAccountId)
    || !PARTITIONS.has(input.partition)
    || !REGION.test(input.region)
    || (input.partition === "aws-cn") !== input.region.startsWith("cn-")
    || (input.partition === "aws-us-gov") !== input.region.startsWith("us-gov-")
    || (input.partition === "aws"
      && (input.region.startsWith("cn-") || input.region.startsWith("us-gov-")))
    || targetCount !== regionCount * exportFamilyCount
    || typeof input.sealedEnvelope !== "object"
    || input.sealedEnvelope === null
    || !isRecord(input.sealedEnvelope)
    || !exactKeys(input.sealedEnvelope, ["format", "keyVersion", "ciphertext"])
    || input.sealedEnvelope.format
      !== COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT
    || !canonicalCiphertext(input.sealedEnvelope.ciphertext)
    || !KEY_VERSION.test(input.sealedEnvelope.keyVersion)
  ) reject();
  return {
    discoveryRunId: input.discoveryRunId,
    planId: input.planId,
    contentSha256: input.contentSha256,
    requesterAccountId: input.requesterAccountId,
    partition: input.partition,
    region: input.region,
    regionCount,
    exportFamilyCount,
    targetCount,
    sealedEnvelope: {
      format: input.sealedEnvelope.format,
      ciphertext: input.sealedEnvelope.ciphertext,
      keyVersion: input.sealedEnvelope.keyVersion,
    },
  };
}

function bindingBody(input: {
  readonly scope: ComputeOptimizerExportPlanPersistenceScope;
  readonly discoveryRunId: string;
  readonly planId: string;
  readonly contentSha256: string;
  readonly requesterAccountId: string;
  readonly partition: string;
  readonly region: string;
  readonly regionCount: number;
  readonly exportFamilyCount: number;
  readonly targetCount: number;
  readonly sealedEnvelopeSha256: string;
  readonly format: string;
  readonly keyVersion: string;
}): string {
  return JSON.stringify(input);
}

async function storedPlan(row: PlanRow): Promise<StoredComputeOptimizerExportPlan> {
  const scope = {
    organizationId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
  };
  assertScope(scope);
  const regionCount = integer(row.region_count, 1, MAX_REGIONS, true);
  const exportFamilyCount = integer(
    row.export_family_count,
    1,
    MAX_EXPORT_FAMILIES,
    true,
  );
  const targetCount = integer(row.target_count, 1, MAX_TARGETS, true);
  const createdAt = integer(row.created_at, 0, MAX_DATE_MS, true);
  if (
    !DISCOVERY_RUN_ID.test(row.discovery_run_id)
    || !PLAN_ID.test(row.plan_id)
    || !SHA256.test(row.content_sha256)
    || row.plan_id !== `cope_${row.content_sha256}`
    || !ACCOUNT_ID.test(row.requester_account_id)
    || !PARTITIONS.has(row.partition)
    || !REGION.test(row.region)
    || (row.partition === "aws-cn") !== row.region.startsWith("cn-")
    || (row.partition === "aws-us-gov") !== row.region.startsWith("us-gov-")
    || (row.partition === "aws"
      && (row.region.startsWith("cn-") || row.region.startsWith("us-gov-")))
    || targetCount !== regionCount * exportFamilyCount
    || row.sealed_envelope_format
      !== COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT
    || !canonicalCiphertext(row.sealed_envelope_ciphertext)
    || !KEY_VERSION.test(row.sealed_envelope_key_version)
    || !SHA256.test(row.sealed_envelope_sha256)
    || !SHA256.test(row.binding_sha256)
  ) reject("STORED_STATE_INVALID");
  const sealedEnvelopeSha256 = await sha256(row.sealed_envelope_ciphertext);
  if (sealedEnvelopeSha256 !== row.sealed_envelope_sha256) {
    reject("STORED_STATE_INVALID");
  }
  const bindingSha256 = await sha256(bindingBody({
    scope,
    discoveryRunId: row.discovery_run_id,
    planId: row.plan_id,
    contentSha256: row.content_sha256,
    requesterAccountId: row.requester_account_id,
    partition: row.partition,
    region: row.region,
    regionCount,
    exportFamilyCount,
    targetCount,
    sealedEnvelopeSha256,
    format: row.sealed_envelope_format,
    keyVersion: row.sealed_envelope_key_version,
  }));
  if (bindingSha256 !== row.binding_sha256) reject("STORED_STATE_INVALID");
  return {
    scope,
    discoveryRunId: row.discovery_run_id,
    planId: row.plan_id,
    contentSha256: row.content_sha256,
    requesterAccountId: row.requester_account_id,
    partition: row.partition,
    region: row.region,
    regionCount,
    exportFamilyCount,
    targetCount,
    sealedEnvelope: {
      format: COMPUTE_OPTIMIZER_EXPORT_PLAN_ENVELOPE_FORMAT,
      ciphertext: row.sealed_envelope_ciphertext,
      keyVersion: row.sealed_envelope_key_version,
    },
    sealedEnvelopeSha256,
    bindingSha256,
    createdAtIso: new Date(createdAt).toISOString(),
  };
}

function samePlan(
  stored: StoredComputeOptimizerExportPlan,
  input: RecordComputeOptimizerExportPlanInput,
): boolean {
  return stored.discoveryRunId === input.discoveryRunId
    && stored.planId === input.planId
    && stored.contentSha256 === input.contentSha256
    && stored.requesterAccountId === input.requesterAccountId
    && stored.partition === input.partition
    && stored.region === input.region
    && stored.regionCount === input.regionCount
    && stored.exportFamilyCount === input.exportFamilyCount
    && stored.targetCount === input.targetCount
    && stored.sealedEnvelope.format === input.sealedEnvelope.format
    && stored.sealedEnvelope.ciphertext === input.sealedEnvelope.ciphertext
    && stored.sealedEnvelope.keyVersion === input.sealedEnvelope.keyVersion;
}

export class ComputeOptimizerExportPlanRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async liveScope(
    database: D1Database,
    scope: ComputeOptimizerExportPlanPersistenceScope,
  ): Promise<LiveScopeRow> {
    assertScope(scope);
    const row = await database.prepare(
      `SELECT c.aws_account_id, c.partition FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
         AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<LiveScopeRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return row;
  }

  private async read(
    database: D1Database,
    scope: ComputeOptimizerExportPlanPersistenceScope,
    planId: string,
  ): Promise<StoredComputeOptimizerExportPlan | null> {
    const row = await database.prepare(
      `SELECT p.* FROM finops_co_export_plans p
       JOIN finops_co_discovery_runs d
        ON d.org_id = p.org_id AND d.customer_id = p.customer_id
        AND d.connection_id = p.connection_id AND d.run_id = p.discovery_run_id
        AND d.account_id = p.requester_account_id AND d.partition = p.partition
        AND d.region = p.region
        AND d.status IN ('complete','partial')
        AND d.content_sha256 IS NOT NULL AND d.finalized_at IS NOT NULL
       JOIN aws_connections c
         ON c.id = p.connection_id AND c.org_id = p.org_id
        AND c.customer_id = p.customer_id
        AND c.aws_account_id = p.requester_account_id AND c.partition = p.partition
        AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       JOIN organizations o ON o.id = p.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = p.customer_id AND cu.org_id = p.org_id
        AND cu.status = 'active'
       WHERE p.org_id = ? AND p.customer_id = ? AND p.connection_id = ?
         AND p.plan_id = ? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, planId)
      .first<PlanRow>();
    return row === null ? null : storedPlan(row);
  }

  public async recordPlan(
    scope: ComputeOptimizerExportPlanPersistenceScope,
    unsafeInput: RecordComputeOptimizerExportPlanInput,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerExportPlan> {
    assertScope(scope);
    const input = normalizeInput(unsafeInput);
    const createdAt = integer(nowMs, 0, MAX_DATE_MS);
    const database = await this.ready();
    const live = await this.liveScope(database, scope);
    if (
      live.aws_account_id !== input.requesterAccountId
      || live.partition !== input.partition
    ) reject("SCOPE_NOT_FOUND");
    const discovery = await database.prepare(
      `SELECT run_id FROM finops_co_discovery_runs
       WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND run_id = ?
         AND account_id = ? AND partition = ? AND region = ?
         AND status IN ('complete','partial')
         AND content_sha256 IS NOT NULL AND finalized_at IS NOT NULL LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      input.discoveryRunId,
      input.requesterAccountId,
      input.partition,
      input.region,
    ).first<{ run_id: string }>();
    if (discovery === null) reject("DISCOVERY_RUN_NOT_FOUND");

    const prior = await this.read(database, scope, input.planId);
    if (prior !== null) {
      if (!samePlan(prior, input)) reject("IMMUTABLE_CONFLICT");
      return prior;
    }
    const sealedEnvelopeSha256 = await sha256(input.sealedEnvelope.ciphertext);
    const bindingSha256 = await sha256(bindingBody({
      scope,
      discoveryRunId: input.discoveryRunId,
      planId: input.planId,
      contentSha256: input.contentSha256,
      requesterAccountId: input.requesterAccountId,
      partition: input.partition,
      region: input.region,
      regionCount: input.regionCount,
      exportFamilyCount: input.exportFamilyCount,
      targetCount: input.targetCount,
      sealedEnvelopeSha256,
      format: input.sealedEnvelope.format,
      keyVersion: input.sealedEnvelope.keyVersion,
    }));
    try {
      await database.prepare(
        `INSERT INTO finops_co_export_plans
         (plan_id, org_id, customer_id, connection_id, discovery_run_id,
          content_sha256, requester_account_id, partition, region, region_count,
          export_family_count, target_count, sealed_envelope_format,
          sealed_envelope_ciphertext,
          sealed_envelope_key_version, sealed_envelope_sha256, binding_sha256,
          created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM finops_co_discovery_runs d
           JOIN aws_connections c ON c.id = d.connection_id
             AND c.org_id = d.org_id AND c.customer_id = d.customer_id
           JOIN organizations o ON o.id = d.org_id AND o.status = 'active'
           JOIN customers cu ON cu.id = d.customer_id AND cu.org_id = d.org_id
             AND cu.status = 'active'
           WHERE d.org_id = ? AND d.customer_id = ? AND d.connection_id = ?
             AND d.run_id = ? AND d.account_id = ? AND d.partition = ?
             AND d.region = ?
             AND d.status IN ('complete','partial')
             AND d.content_sha256 IS NOT NULL AND d.finalized_at IS NOT NULL
             AND c.aws_account_id = d.account_id AND c.partition = d.partition
             AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
         )`,
      ).bind(
        input.planId,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        input.discoveryRunId,
        input.contentSha256,
        input.requesterAccountId,
        input.partition,
        input.region,
        input.regionCount,
        input.exportFamilyCount,
        input.targetCount,
        input.sealedEnvelope.format,
        input.sealedEnvelope.ciphertext,
        input.sealedEnvelope.keyVersion,
        sealedEnvelopeSha256,
        bindingSha256,
        createdAt,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        input.discoveryRunId,
        input.requesterAccountId,
        input.partition,
        input.region,
      ).run();
    } catch {
      const raced = await this.read(database, scope, input.planId);
      if (raced !== null && samePlan(raced, input)) return raced;
      reject("IMMUTABLE_CONFLICT");
    }
    const stored = await this.read(database, scope, input.planId);
    if (stored === null) reject("IMMUTABLE_CONFLICT");
    return stored;
  }

  public async getPlan(
    scope: ComputeOptimizerExportPlanPersistenceScope,
    planId: string,
  ): Promise<StoredComputeOptimizerExportPlan | null> {
    if (!PLAN_ID.test(planId)) reject();
    const database = await this.ready();
    await this.liveScope(database, scope);
    return this.read(database, scope, planId);
  }

  public async listPlans(
    scope: ComputeOptimizerExportPlanPersistenceScope,
    limit = 30,
  ): Promise<readonly StoredComputeOptimizerExportPlan[]> {
    const boundedLimit = integer(limit, 1, 90);
    const database = await this.ready();
    await this.liveScope(database, scope);
    const rows = await database.prepare(
      `SELECT p.* FROM finops_co_export_plans p
       JOIN finops_co_discovery_runs d
        ON d.org_id = p.org_id AND d.customer_id = p.customer_id
        AND d.connection_id = p.connection_id AND d.run_id = p.discovery_run_id
        AND d.account_id = p.requester_account_id AND d.partition = p.partition
        AND d.region = p.region
        AND d.status IN ('complete','partial')
        AND d.content_sha256 IS NOT NULL AND d.finalized_at IS NOT NULL
       JOIN aws_connections c
         ON c.id = p.connection_id AND c.org_id = p.org_id
        AND c.customer_id = p.customer_id
        AND c.aws_account_id = p.requester_account_id AND c.partition = p.partition
        AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
       JOIN organizations o ON o.id = p.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = p.customer_id AND cu.org_id = p.org_id
        AND cu.status = 'active'
       WHERE p.org_id = ? AND p.customer_id = ? AND p.connection_id = ?
       ORDER BY p.created_at DESC, p.plan_id DESC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, boundedLimit)
      .all<PlanRow>();
    return Promise.all((rows.results ?? []).map(storedPlan));
  }
}
