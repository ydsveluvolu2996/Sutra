/**
 * Immutable organization-wide activation sets over sealed regional Compute
 * Optimizer export plans. Only non-sensitive identities are stored; regional
 * plans retain their encrypted object addresses in the plan repository.
 */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  verifyComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportFamily,
  type ComputeOptimizerExportPlanSet,
} from "../lib/finops-compute-optimizer-export-plan";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const PLAN_SET_ID = /^copes_[a-f0-9]{64}$/u;
const PLAN_ID = /^cope_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const MAX_DATE_MS = 8_640_000_000_000_000;
const PARTITIONS = new Set(["aws", "aws-us-gov", "aws-cn"]);
const FAMILIES = new Set<ComputeOptimizerExportFamily>([
  "EC2_INSTANCE",
  "AUTO_SCALING_GROUP",
  "EBS_VOLUME",
  "LAMBDA_FUNCTION",
  "ECS_SERVICE",
  "LICENSE",
  "RDS_DATABASE",
  "IDLE_RESOURCE",
]);

export interface ComputeOptimizerExportPlanSetPersistenceScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredComputeOptimizerExportPlanSet {
  readonly scope: ComputeOptimizerExportPlanSetPersistenceScope;
  readonly planSetId: string;
  readonly contentSha256: string;
  readonly requesterAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly regions: readonly string[];
  readonly exportFamilies: readonly ComputeOptimizerExportFamily[];
  readonly planIds: readonly string[];
  readonly bindingSha256: string;
  readonly createdAtIso: string;
}

export class ComputeOptimizerExportPlanSetRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "REGIONAL_PLAN_NOT_FOUND"
    | "IMMUTABLE_CONFLICT"
    | "STORED_STATE_INVALID";

  public constructor(
    code:
      | "INVALID_INPUT"
      | "SCOPE_NOT_FOUND"
      | "REGIONAL_PLAN_NOT_FOUND"
      | "IMMUTABLE_CONFLICT"
      | "STORED_STATE_INVALID",
  ) {
    super("Compute Optimizer export plan-set persistence rejected");
    this.name = "ComputeOptimizerExportPlanSetRepositoryError";
    this.code = code;
  }
}

interface SetRow {
  plan_set_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  content_sha256: string;
  requester_account_id: string;
  partition: StoredComputeOptimizerExportPlanSet["partition"];
  regions_json: string;
  export_families_json: string;
  plan_ids_json: string;
  region_count: number | string;
  export_family_count: number | string;
  plan_count: number | string;
  binding_sha256: string;
  finalized: boolean | number | string;
  created_at: number | string;
}

interface MemberRow {
  position: number | string;
  region: string;
  plan_id: string;
}

function reject(
  code: ComputeOptimizerExportPlanSetRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new ComputeOptimizerExportPlanSetRepositoryError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number"
    || !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) reject("STORED_STATE_INVALID");
  return parsed;
}

function boolean(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  reject("STORED_STATE_INVALID");
}

function assertScope(scope: ComputeOptimizerExportPlanSetPersistenceScope): void {
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

function validRegionForPartition(
  region: string,
  partition: StoredComputeOptimizerExportPlanSet["partition"],
): boolean {
  if (!REGION.test(region)) return false;
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function parseArray<T extends string>(
  source: unknown,
  minimum: number,
  maximum: number,
  validator: (value: string) => value is T,
  requireSorted = true,
): readonly T[] {
  if (typeof source !== "string") reject("STORED_STATE_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    reject("STORED_STATE_INVALID");
  }
  if (
    !Array.isArray(parsed)
    || parsed.length < minimum
    || parsed.length > maximum
    || parsed.some((value) => typeof value !== "string" || !validator(value))
    || new Set(parsed).size !== parsed.length
    || (requireSorted && parsed.some((value, index) => index > 0 && parsed[index - 1] >= value))
    || JSON.stringify(parsed) !== source
  ) reject("STORED_STATE_INVALID");
  return parsed as T[];
}

function canonicalIdentity(
  scope: ComputeOptimizerExportPlanSetPersistenceScope,
  value: Pick<StoredComputeOptimizerExportPlanSet,
    "requesterAccountId" | "partition" | "regions" | "exportFamilies" | "planIds">,
): string {
  return JSON.stringify({
    schemaVersion: "sutra.compute-optimizer-export-plan-set.v1",
    scope: {
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
    },
    requesterAccountId: value.requesterAccountId,
    partition: value.partition,
    regions: value.regions,
    exportFamilies: value.exportFamilies,
    planIds: value.planIds,
  });
}

function canonicalBinding(
  scope: ComputeOptimizerExportPlanSetPersistenceScope,
  planSetId: string,
  contentSha256: string,
  planIds: readonly string[],
): string {
  return JSON.stringify({ scope, planSetId, contentSha256, planIds });
}

async function materialize(
  row: SetRow,
  members: readonly MemberRow[],
): Promise<StoredComputeOptimizerExportPlanSet> {
  if (
    !PLAN_SET_ID.test(row.plan_set_id)
    || !SHA256.test(row.content_sha256)
    || row.plan_set_id !== `copes_${row.content_sha256}`
    || !ACCOUNT_ID.test(row.requester_account_id)
    || !PARTITIONS.has(row.partition)
    || !SHA256.test(row.binding_sha256)
    || !boolean(row.finalized)
  ) reject("STORED_STATE_INVALID");
  const scope = {
    organizationId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
  };
  try {
    assertScope(scope);
  } catch {
    reject("STORED_STATE_INVALID");
  }
  const regions = parseArray(
    row.regions_json,
    1,
    50,
    (value): value is string => validRegionForPartition(value, row.partition),
  );
  const exportFamilies = parseArray(
    row.export_families_json,
    1,
    8,
    (value): value is ComputeOptimizerExportFamily => FAMILIES.has(value as ComputeOptimizerExportFamily),
  );
  const planIds = parseArray(
    row.plan_ids_json,
    1,
    50,
    (value): value is string => PLAN_ID.test(value),
    false,
  );
  if (
    integer(row.region_count, 1, 50) !== regions.length
    || integer(row.export_family_count, 1, 8) !== exportFamilies.length
    || integer(row.plan_count, 1, 50) !== planIds.length
    || regions.length !== planIds.length
    || members.length !== planIds.length
  ) reject("STORED_STATE_INVALID");
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index]!;
    if (
      integer(member.position, 0, 49) !== index
      || member.region !== regions[index]
      || member.plan_id !== planIds[index]
    ) reject("STORED_STATE_INVALID");
  }
  const identitySha256 = await sha256(canonicalIdentity(scope, {
    requesterAccountId: row.requester_account_id,
    partition: row.partition,
    regions,
    exportFamilies,
    planIds,
  }));
  if (
    identitySha256 !== row.content_sha256
    || await sha256(canonicalBinding(scope, row.plan_set_id, row.content_sha256, planIds))
      !== row.binding_sha256
  ) reject("STORED_STATE_INVALID");
  const createdAt = integer(row.created_at, 0, MAX_DATE_MS);
  return deepFreeze({
    scope,
    planSetId: row.plan_set_id,
    contentSha256: row.content_sha256,
    requesterAccountId: row.requester_account_id,
    partition: row.partition,
    regions,
    exportFamilies,
    planIds,
    bindingSha256: row.binding_sha256,
    createdAtIso: new Date(createdAt).toISOString(),
  });
}

function sameSet(
  stored: StoredComputeOptimizerExportPlanSet,
  planSet: ComputeOptimizerExportPlanSet,
): boolean {
  return stored.planSetId === planSet.planSetId
    && stored.contentSha256 === planSet.contentSha256
    && stored.requesterAccountId === planSet.requesterAccountId
    && stored.partition === planSet.partition
    && JSON.stringify(stored.regions) === JSON.stringify(planSet.regions)
    && JSON.stringify(stored.exportFamilies) === JSON.stringify(planSet.exportFamilies)
    && JSON.stringify(stored.planIds) === JSON.stringify(planSet.planIds);
}

export class ComputeOptimizerExportPlanSetRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async liveScope(
    scope: ComputeOptimizerExportPlanSetPersistenceScope,
    accountId?: string,
    partition?: string,
  ): Promise<void> {
    assertScope(scope);
    await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(
      `SELECT c.aws_account_id, c.partition FROM aws_connections c
       JOIN organizations o ON o.id=c.org_id AND o.status='active'
       JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status='active'
       WHERE c.org_id=? AND c.customer_id=? AND c.id=?
         AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<{ aws_account_id: string; partition: string }>();
    if (row === null || (accountId !== undefined && row.aws_account_id !== accountId)
      || (partition !== undefined && row.partition !== partition)) reject("SCOPE_NOT_FOUND");
  }

  private async byId(
    scope: ComputeOptimizerExportPlanSetPersistenceScope,
    planSetId: string,
  ): Promise<StoredComputeOptimizerExportPlanSet | null> {
    const row = await this.database.prepare(
      `SELECT * FROM finops_co_export_plan_sets
       WHERE org_id=? AND customer_id=? AND connection_id=? AND plan_set_id=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, planSetId)
      .first<SetRow>();
    if (row === null) return null;
    const result = await this.database.prepare(
      `SELECT position,region,plan_id FROM finops_co_export_plan_set_members
       WHERE plan_set_id=? ORDER BY position ASC`,
    ).bind(planSetId).all<MemberRow>();
    return materialize(row, result.results ?? []);
  }

  public async recordPlanSet(
    scope: ComputeOptimizerExportPlanSetPersistenceScope,
    unsafePlanSet: ComputeOptimizerExportPlanSet,
    nowMs = Date.now(),
  ): Promise<StoredComputeOptimizerExportPlanSet> {
    assertScope(scope);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_DATE_MS) reject();
    let planSet: ComputeOptimizerExportPlanSet;
    try {
      planSet = await verifyComputeOptimizerExportPlanSet(unsafePlanSet);
    } catch {
      reject();
    }
    if (
      planSet.scope.orgId !== scope.organizationId
      || planSet.scope.customerId !== scope.customerId
      || planSet.scope.connectionId !== scope.connectionId
    ) reject();
    await this.liveScope(scope, planSet.requesterAccountId, planSet.partition);
    const existing = await this.byId(scope, planSet.planSetId);
    if (existing !== null) {
      if (!sameSet(existing, planSet)) reject("IMMUTABLE_CONFLICT");
      return existing;
    }
    const regionsJson = JSON.stringify(planSet.regions);
    const familiesJson = JSON.stringify(planSet.exportFamilies);
    const planIdsJson = JSON.stringify(planSet.planIds);
    const bindingSha256 = await sha256(canonicalBinding(
      scope,
      planSet.planSetId,
      planSet.contentSha256,
      planSet.planIds,
    ));
    const statements = [this.database.prepare(
      `INSERT INTO finops_co_export_plan_sets (
        plan_set_id,org_id,customer_id,connection_id,content_sha256,
        requester_account_id,partition,regions_json,export_families_json,
        plan_ids_json,region_count,export_family_count,plan_count,binding_sha256,
        finalized,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    ).bind(
      planSet.planSetId,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      planSet.contentSha256,
      planSet.requesterAccountId,
      planSet.partition,
      regionsJson,
      familiesJson,
      planIdsJson,
      planSet.regions.length,
      planSet.exportFamilies.length,
      planSet.planIds.length,
      bindingSha256,
      nowMs,
    )];
    for (let index = 0; index < planSet.planIds.length; index += 1) {
      statements.push(this.database.prepare(
        `INSERT INTO finops_co_export_plan_set_members
          (plan_set_id,position,region,plan_id) VALUES (?,?,?,?)`,
      ).bind(planSet.planSetId, index, planSet.regions[index], planSet.planIds[index]));
    }
    statements.push(this.database.prepare(
      "UPDATE finops_co_export_plan_sets SET finalized=1 WHERE plan_set_id=? AND finalized=0",
    ).bind(planSet.planSetId));
    try {
      await this.database.batch(statements);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/MEMBER_REJECTED|FOREIGN KEY/iu.test(message)) reject("REGIONAL_PLAN_NOT_FOUND");
      if (/UNIQUE|PRIMARY KEY|CONSTRAINT/iu.test(message)) {
        const replay = await this.byId(scope, planSet.planSetId);
        if (replay !== null && sameSet(replay, planSet)) return replay;
        reject("IMMUTABLE_CONFLICT");
      }
      throw cause;
    }
    const stored = await this.byId(scope, planSet.planSetId);
    if (stored === null || !sameSet(stored, planSet)) reject("STORED_STATE_INVALID");
    return stored;
  }

  public async getPlanSet(
    scope: ComputeOptimizerExportPlanSetPersistenceScope,
    planSetId: string,
  ): Promise<StoredComputeOptimizerExportPlanSet | null> {
    if (!PLAN_SET_ID.test(planSetId)) reject();
    await this.liveScope(scope);
    return this.byId(scope, planSetId);
  }

  public async listPlanSets(
    scope: ComputeOptimizerExportPlanSetPersistenceScope,
    limit = 50,
  ): Promise<readonly StoredComputeOptimizerExportPlanSet[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject();
    await this.liveScope(scope);
    const rows = await this.database.prepare(
      `SELECT * FROM finops_co_export_plan_sets
       WHERE org_id=? AND customer_id=? AND connection_id=? AND finalized=1
       ORDER BY created_at DESC,plan_set_id DESC LIMIT ?`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId, limit).all<SetRow>();
    return Promise.all((rows.results ?? []).map(async (row) => {
      const members = await this.database.prepare(
        `SELECT position,region,plan_id FROM finops_co_export_plan_set_members
         WHERE plan_set_id=? ORDER BY position ASC`,
      ).bind(row.plan_set_id).all<MemberRow>();
      return materialize(row, members.results ?? []);
    }));
  }
}
