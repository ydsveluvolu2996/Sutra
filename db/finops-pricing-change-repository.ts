/**
 * Immutable metadata for Pricing Change Analysis materializations.
 *
 * Actual CUR usage and public-catalog terms remain in a managed evidence
 * object. This table stores only bounded lineage/count metadata and a sealed
 * evidence pointer. READY/NO_USAGE materializations alone advance the active
 * head; partial, stale, and configuration-required captures remain history.
 */
import type { PricingChangeSnapshot } from "../lib/finops-pricing-change-analysis.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SNAPSHOT_ID = /^pca_[a-f0-9]{64}$/u;
const EVIDENCE_GENERATION_ID = /^fss_[a-f0-9]{64}$/u;
const CUR_GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEALED_REFERENCE = /^fsev1\.[A-Za-z0-9_-]{26,8186}$/u;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

export interface PricingChangeMaterializationScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export type StoredPricingChangeState =
  | "ready"
  | "partial"
  | "configuration_required"
  | "stale"
  | "no_usage";

export interface RecordPricingChangeMaterializationInput {
  readonly snapshot: PricingChangeSnapshot;
  readonly evidenceGenerationId: string;
  readonly contentSha256: string;
  readonly evidenceReference: {
    readonly ciphertext: string;
    readonly keyVersion: string;
  };
}

export interface StoredPricingChangeMaterialization {
  readonly scope: PricingChangeMaterializationScope;
  readonly snapshotId: string;
  readonly evidenceGenerationId: string;
  readonly state: StoredPricingChangeState;
  readonly contentSha256: string;
  readonly evidenceReference: {
    readonly ciphertext: string;
    readonly keyVersion: string;
  };
  readonly capturedAt: string;
  readonly usagePeriodStartAt: string;
  readonly usagePeriodEndAt: string;
  readonly baselineEffectiveAt: string;
  readonly comparisonEffectiveAt: string;
  readonly activeCur2GenerationId: string;
  readonly inputLineCount: number;
  readonly modeledLineCount: number;
  readonly excludedLineCount: number;
  readonly catalogSnapshotCount: number;
  readonly catalogTermCount: number;
  readonly createdAtIso: string;
}

export class PricingChangeRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "IMMUTABLE_CONFLICT"
    | "STORED_STATE_INVALID";

  public constructor(code: PricingChangeRepositoryError["code"]) {
    super("Pricing Change materialization operation rejected");
    this.name = "PricingChangeRepositoryError";
    this.code = code;
  }
}

interface MaterializationRow {
  snapshot_id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  evidence_generation_id: string;
  state: StoredPricingChangeState;
  content_sha256: string;
  evidence_reference_ciphertext: string;
  evidence_reference_key_version: string;
  captured_at: string;
  usage_period_start_at: string;
  usage_period_end_at: string;
  baseline_effective_at: string;
  comparison_effective_at: string;
  active_cur2_generation_id: string;
  input_line_count: number | string;
  modeled_line_count: number | string;
  excluded_line_count: number | string;
  catalog_snapshot_count: number | string;
  catalog_term_count: number | string;
  created_at: number | string;
}

function reject(
  code: PricingChangeRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new PricingChangeRepositoryError(code);
}

function assertScope(scope: PricingChangeMaterializationScope): void {
  if (
    !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
  ) reject();
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? value
    : null;
}

function safeInteger(
  value: unknown,
  maximum: number,
  stored = false,
): number {
  const candidate = typeof value === "string" ? Number(value) : value;
  if (
    typeof candidate !== "number"
    || !Number.isSafeInteger(candidate)
    || candidate < 0
    || candidate > maximum
  ) reject(stored ? "STORED_STATE_INVALID" : "INVALID_INPUT");
  return candidate;
}

function storedState(state: PricingChangeSnapshot["state"]): StoredPricingChangeState {
  switch (state) {
    case "READY": return "ready";
    case "PARTIAL": return "partial";
    case "CONFIGURATION_REQUIRED": return "configuration_required";
    case "STALE": return "stale";
    case "NO_USAGE": return "no_usage";
  }
}

function normalize(
  scope: PricingChangeMaterializationScope,
  input: RecordPricingChangeMaterializationInput,
): StoredPricingChangeMaterialization {
  assertScope(scope);
  const snapshot = input.snapshot;
  const state = storedState(snapshot.state);
  const capturedAt = iso(snapshot.generatedAt);
  const usagePeriodStartAt = iso(snapshot.usagePeriodStartAt);
  const usagePeriodEndAt = iso(snapshot.usagePeriodEndAt);
  const baselineEffectiveAt = iso(snapshot.baselineEffectiveAt);
  const comparisonEffectiveAt = iso(snapshot.comparisonEffectiveAt);
  if (
    snapshot.schemaVersion !== "sutra.pricing-change.snapshot.v1"
    || snapshot.scope.orgId !== scope.organizationId
    || snapshot.scope.customerId !== scope.customerId
    || snapshot.scope.connectionId !== scope.connectionId
    || !SNAPSHOT_ID.test(snapshot.collectionId)
    || !EVIDENCE_GENERATION_ID.test(input.evidenceGenerationId)
    || !SHA256.test(input.contentSha256)
    || !SEALED_REFERENCE.test(input.evidenceReference.ciphertext)
    || !KEY_VERSION.test(input.evidenceReference.keyVersion)
    || !CUR_GENERATION_ID.test(snapshot.activeCur2GenerationId)
    || capturedAt === null
    || usagePeriodStartAt === null
    || usagePeriodEndAt === null
    || usagePeriodEndAt <= usagePeriodStartAt
    || baselineEffectiveAt === null
    || comparisonEffectiveAt === null
    || comparisonEffectiveAt <= baselineEffectiveAt
  ) reject();
  const inputLineCount = safeInteger(snapshot.summary.inputLineCount, 250_000);
  const modeledLineCount = safeInteger(snapshot.summary.modeledLineCount, inputLineCount);
  const excludedLineCount = safeInteger(snapshot.summary.excludedLineCount, inputLineCount);
  const catalogSnapshotCount = safeInteger(snapshot.summary.catalogSnapshotCount, 20_000);
  const catalogTermCount = safeInteger(snapshot.summary.catalogTermCount, 500_000);
  if (
    modeledLineCount + excludedLineCount !== inputLineCount
    || (state === "ready" && (
      inputLineCount === 0
      || modeledLineCount !== inputLineCount
      || excludedLineCount !== 0
    ))
    || (state === "no_usage" && inputLineCount !== 0)
    || snapshot.catalogEvidence.length !== catalogSnapshotCount
  ) reject();
  return {
    scope,
    snapshotId: snapshot.collectionId,
    evidenceGenerationId: input.evidenceGenerationId,
    state,
    contentSha256: input.contentSha256,
    evidenceReference: input.evidenceReference,
    capturedAt,
    usagePeriodStartAt,
    usagePeriodEndAt,
    baselineEffectiveAt,
    comparisonEffectiveAt,
    activeCur2GenerationId: snapshot.activeCur2GenerationId,
    inputLineCount,
    modeledLineCount,
    excludedLineCount,
    catalogSnapshotCount,
    catalogTermCount,
    createdAtIso: capturedAt,
  };
}

function fromRow(row: MaterializationRow): StoredPricingChangeMaterialization {
  const capturedAt = iso(row.captured_at);
  const usagePeriodStartAt = iso(row.usage_period_start_at);
  const usagePeriodEndAt = iso(row.usage_period_end_at);
  const baselineEffectiveAt = iso(row.baseline_effective_at);
  const comparisonEffectiveAt = iso(row.comparison_effective_at);
  const createdAt = safeInteger(row.created_at, Number.MAX_SAFE_INTEGER, true);
  if (
    !SNAPSHOT_ID.test(row.snapshot_id)
    || !IDENTIFIER.test(row.org_id)
    || !IDENTIFIER.test(row.customer_id)
    || !CONNECTION_ID.test(row.connection_id)
    || !EVIDENCE_GENERATION_ID.test(row.evidence_generation_id)
    || !new Set<StoredPricingChangeState>([
      "ready", "partial", "configuration_required", "stale", "no_usage",
    ]).has(row.state)
    || !SHA256.test(row.content_sha256)
    || !SEALED_REFERENCE.test(row.evidence_reference_ciphertext)
    || !KEY_VERSION.test(row.evidence_reference_key_version)
    || capturedAt === null
    || usagePeriodStartAt === null
    || usagePeriodEndAt === null
    || baselineEffectiveAt === null
    || comparisonEffectiveAt === null
    || !CUR_GENERATION_ID.test(row.active_cur2_generation_id)
  ) reject("STORED_STATE_INVALID");
  const inputLineCount = safeInteger(row.input_line_count, 250_000, true);
  const modeledLineCount = safeInteger(row.modeled_line_count, inputLineCount, true);
  const excludedLineCount = safeInteger(row.excluded_line_count, inputLineCount, true);
  if (modeledLineCount + excludedLineCount !== inputLineCount) {
    reject("STORED_STATE_INVALID");
  }
  return {
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
    },
    snapshotId: row.snapshot_id,
    evidenceGenerationId: row.evidence_generation_id,
    state: row.state,
    contentSha256: row.content_sha256,
    evidenceReference: {
      ciphertext: row.evidence_reference_ciphertext,
      keyVersion: row.evidence_reference_key_version,
    },
    capturedAt,
    usagePeriodStartAt,
    usagePeriodEndAt,
    baselineEffectiveAt,
    comparisonEffectiveAt,
    activeCur2GenerationId: row.active_cur2_generation_id,
    inputLineCount,
    modeledLineCount,
    excludedLineCount,
    catalogSnapshotCount: safeInteger(row.catalog_snapshot_count, 20_000, true),
    catalogTermCount: safeInteger(row.catalog_term_count, 500_000, true),
    createdAtIso: new Date(createdAt).toISOString(),
  };
}

function equal(
  left: StoredPricingChangeMaterialization,
  right: StoredPricingChangeMaterialization,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class PricingChangeMaterializationRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async live(
    scope: PricingChangeMaterializationScope,
  ): Promise<D1Database> {
    assertScope(scope);
    await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(
      `SELECT c.id FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
         AND cu.status = 'active'
       WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
         AND c.source_kind = 'aws_trust_role' AND c.status = 'active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return this.database;
  }

  private async read(
    database: D1Database,
    scope: PricingChangeMaterializationScope,
    snapshotId: string,
  ): Promise<StoredPricingChangeMaterialization | null> {
    const row = await database.prepare(
      `SELECT * FROM finops_pricing_change_materializations
       WHERE org_id = ? AND customer_id = ? AND connection_id = ?
         AND snapshot_id = ? LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      snapshotId,
    ).first<MaterializationRow>();
    return row === null ? null : fromRow(row);
  }

  public async recordMaterialization(
    scope: PricingChangeMaterializationScope,
    input: RecordPricingChangeMaterializationInput,
    nowMs = Date.now(),
  ): Promise<{
    readonly materialization: StoredPricingChangeMaterialization;
    readonly becameActive: boolean;
  }> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const normalized = normalize(scope, input);
    const database = await this.live(scope);
    const priorActive = await this.getActive(scope);
    await database.prepare(
      `INSERT OR IGNORE INTO finops_pricing_change_materializations (
        snapshot_id, org_id, customer_id, connection_id,
        evidence_generation_id, state, content_sha256,
        evidence_reference_ciphertext, evidence_reference_key_version,
        captured_at, usage_period_start_at, usage_period_end_at,
        baseline_effective_at, comparison_effective_at,
        active_cur2_generation_id, input_line_count, modeled_line_count,
        excluded_line_count, catalog_snapshot_count, catalog_term_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      normalized.snapshotId,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      normalized.evidenceGenerationId,
      normalized.state,
      normalized.contentSha256,
      normalized.evidenceReference.ciphertext,
      normalized.evidenceReference.keyVersion,
      normalized.capturedAt,
      normalized.usagePeriodStartAt,
      normalized.usagePeriodEndAt,
      normalized.baselineEffectiveAt,
      normalized.comparisonEffectiveAt,
      normalized.activeCur2GenerationId,
      normalized.inputLineCount,
      normalized.modeledLineCount,
      normalized.excludedLineCount,
      normalized.catalogSnapshotCount,
      normalized.catalogTermCount,
      nowMs,
    ).run();
    const stored = await this.read(database, scope, normalized.snapshotId);
    if (stored === null) reject("STORED_STATE_INVALID");
    const expected = { ...normalized, createdAtIso: stored.createdAtIso };
    if (!equal(stored, expected)) reject("IMMUTABLE_CONFLICT");

    if (stored.state === "ready" || stored.state === "no_usage") {
      await database.prepare(
        `INSERT INTO finops_pricing_change_heads
          (org_id, customer_id, connection_id, active_snapshot_id, advanced_at)
         SELECT ?, ?, ?, s.snapshot_id, ?
           FROM finops_pricing_change_materializations s
          WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
            AND s.snapshot_id = ? AND s.state IN ('ready', 'no_usage')
         ON CONFLICT(org_id, customer_id, connection_id) DO UPDATE SET
           active_snapshot_id = excluded.active_snapshot_id,
           advanced_at = excluded.advanced_at
         WHERE EXISTS (
           SELECT 1 FROM finops_pricing_change_materializations candidate
           JOIN finops_pricing_change_materializations active
             ON active.snapshot_id = finops_pricing_change_heads.active_snapshot_id
          WHERE candidate.snapshot_id = excluded.active_snapshot_id
            AND (candidate.captured_at > active.captured_at
              OR (candidate.captured_at = active.captured_at
                AND candidate.snapshot_id > active.snapshot_id))
         )`,
      ).bind(
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        nowMs,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        stored.snapshotId,
      ).run();
    }
    const active = await this.getActive(scope);
    return {
      materialization: stored,
      becameActive: active?.snapshotId === stored.snapshotId
        && priorActive?.snapshotId !== stored.snapshotId,
    };
  }

  public async getActive(
    scope: PricingChangeMaterializationScope,
  ): Promise<StoredPricingChangeMaterialization | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT s.* FROM finops_pricing_change_heads h
       JOIN finops_pricing_change_materializations s
         ON s.snapshot_id = h.active_snapshot_id
        AND s.org_id = h.org_id AND s.customer_id = h.customer_id
        AND s.connection_id = h.connection_id
       WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
       LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<MaterializationRow>();
    return row === null ? null : fromRow(row);
  }

  public async getLatest(
    scope: PricingChangeMaterializationScope,
  ): Promise<StoredPricingChangeMaterialization | null> {
    const database = await this.live(scope);
    const row = await database.prepare(
      `SELECT * FROM finops_pricing_change_materializations
       WHERE org_id = ? AND customer_id = ? AND connection_id = ?
       ORDER BY captured_at DESC, snapshot_id DESC LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<MaterializationRow>();
    return row === null ? null : fromRow(row);
  }
}
