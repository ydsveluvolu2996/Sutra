import { canonicalJson } from "../lib/canonical-json.ts";
import {
  assessDspmAsset,
  dspmEvidenceSha256,
  type DspmAssetInput,
  type DspmCoverage,
  type DspmPublishRequest,
  type DspmRiskSeverity,
  type DspmSource,
} from "../lib/dspm-posture.ts";
import { getRawDb } from "./index";
import { commitAuditedStatements } from "./pilot-repository";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RUN_ID = /^dsr_[a-f0-9]{32}$/u;

export interface DspmScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface DspmPublishContext {
  readonly actorId: string;
}

export interface StoredDspmRun {
  readonly id: string;
  readonly connectionId: string;
  readonly source: DspmSource;
  readonly status: DspmCoverage["status"];
  readonly coverage: DspmCoverage;
  readonly evidenceSha256: string;
  readonly assetCount: number;
  readonly findingCount: number;
  readonly collectedAt: string;
  readonly importedBy: string;
  readonly idempotencyKey: string;
}

export interface StoredDspmAsset extends DspmAssetInput {
  readonly id: string;
  readonly scanRunId: string;
  readonly risk: {
    readonly score: number;
    readonly severity: DspmRiskSeverity;
    readonly title: string | null;
    readonly factors: readonly string[];
    readonly recommendations: readonly string[];
  };
}

export interface DspmWorkspace {
  readonly state: "NEVER_SCANNED" | "AVAILABLE";
  readonly currentRun: StoredDspmRun | null;
  readonly runs: readonly StoredDspmRun[];
  readonly assets: readonly StoredDspmAsset[];
  readonly findings: readonly StoredDspmAsset[];
  readonly summary: {
    readonly assets: number;
    readonly findings: number;
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly unclassified: number;
    readonly ownerUnassigned: number;
    readonly publicAccess: number;
  };
}

interface RunRow {
  id: string;
  connection_id: string;
  source: DspmSource;
  status: DspmCoverage["status"];
  coverage_json: string;
  evidence_sha256: string;
  asset_count: number;
  finding_count: number;
  collected_at: number;
  imported_by: string;
  idempotency_key: string;
}

interface AssetRow {
  id: string;
  scan_run_id: string;
  resource_key: string;
  resource_type: DspmAssetInput["resourceType"];
  region_key: string;
  classification: DspmAssetInput["classification"];
  categories_json: string;
  owner_ref: string | null;
  encrypted: number | null;
  public_access: number | null;
  cross_account_access: number | null;
  external_sharing: number | null;
  credentials_detected: number | null;
  data_size_bytes: number | null;
  risk_score: number;
  risk_severity: DspmRiskSeverity;
  risk_title: string | null;
  risk_factors_json: string;
  recommendations_json: string;
}

export class DspmRepositoryError extends Error {
  public readonly status: number;
  public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "PERSISTENCE_FAILED";

  public constructor(code: DspmRepositoryError["code"], message?: string) {
    super(message ?? "The DSPM operation was rejected");
    this.name = "DspmRepositoryError";
    this.code = code;
    this.status = code === "INVALID_INPUT" ? 400 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 500;
  }
}

function invalid(): never {
  throw new DspmRepositoryError("INVALID_INPUT");
}

function assertScope(scope: DspmScope, connectionId: string): void {
  if (
    !IDENTIFIER.test(scope.orgId) ||
    !IDENTIFIER.test(scope.customerId) ||
    !CONNECTION_ID.test(connectionId)
  ) invalid();
}

function booleanOrNull(value: number | null): boolean | null {
  return value === null ? null : Number(value) !== 0;
}

function jsonStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed;
  } catch {
    // Persisted DSPM rows can only be written through the strict normalizer.
  }
  throw new DspmRepositoryError("PERSISTENCE_FAILED");
}

function mapRun(row: RunRow): StoredDspmRun {
  let coverage: DspmCoverage;
  try {
    coverage = JSON.parse(row.coverage_json) as DspmCoverage;
  } catch {
    throw new DspmRepositoryError("PERSISTENCE_FAILED");
  }
  return {
    id: row.id,
    connectionId: row.connection_id,
    source: row.source,
    status: row.status,
    coverage,
    evidenceSha256: row.evidence_sha256,
    assetCount: Number(row.asset_count),
    findingCount: Number(row.finding_count),
    collectedAt: new Date(Number(row.collected_at)).toISOString(),
    importedBy: row.imported_by,
    idempotencyKey: row.idempotency_key,
  };
}

function mapAsset(row: AssetRow): StoredDspmAsset {
  return {
    id: row.id,
    scanRunId: row.scan_run_id,
    resourceKey: row.resource_key,
    resourceType: row.resource_type,
    region: row.region_key,
    classification: row.classification,
    categories: jsonStringArray(row.categories_json) as DspmAssetInput["categories"],
    ownerRef: row.owner_ref,
    encrypted: booleanOrNull(row.encrypted),
    publicAccess: booleanOrNull(row.public_access),
    crossAccountAccess: booleanOrNull(row.cross_account_access),
    externalSharing: booleanOrNull(row.external_sharing),
    credentialsDetected: booleanOrNull(row.credentials_detected),
    dataSizeBytes: row.data_size_bytes === null ? null : Number(row.data_size_bytes),
    risk: {
      score: Number(row.risk_score),
      severity: row.risk_severity,
      title: row.risk_title,
      factors: jsonStringArray(row.risk_factors_json),
      recommendations: jsonStringArray(row.recommendations_json),
    },
  };
}

const RUN_COLUMNS =
  "id, connection_id, source, status, coverage_json, evidence_sha256, asset_count, " +
  "finding_count, collected_at, imported_by, idempotency_key";
const JOINED_RUN_COLUMNS =
  "r.id, r.connection_id, r.source, r.status, r.coverage_json, r.evidence_sha256, r.asset_count, " +
  "r.finding_count, r.collected_at, r.imported_by, r.idempotency_key";
const ASSET_COLUMNS =
  "id, scan_run_id, resource_key, resource_type, region_key, classification, categories_json, " +
  "owner_ref, encrypted, public_access, cross_account_access, external_sharing, credentials_detected, " +
  "data_size_bytes, risk_score, risk_severity, risk_title, risk_factors_json, recommendations_json";

function id(prefix: "dsr" | "dsa"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function assetInsert(
  db: D1Database,
  scope: DspmScope,
  runId: string,
  request: DspmPublishRequest,
): D1PreparedStatement | null {
  if (request.assets.length === 0) return null;
  const rowPlaceholders = `(${Array.from({ length: 22 }, () => "?").join(", ")})`;
  const placeholders = request.assets.map(() => rowPlaceholders).join(", ");
  const values: unknown[] = [];
  for (const asset of request.assets) {
    const risk = assessDspmAsset(asset);
    values.push(
      id("dsa"),
      scope.orgId,
      scope.customerId,
      request.connectionId,
      runId,
      asset.resourceKey,
      asset.resourceType,
      asset.region,
      asset.classification,
      canonicalJson(asset.categories),
      asset.ownerRef,
      asset.encrypted === null ? null : asset.encrypted ? 1 : 0,
      asset.publicAccess === null ? null : asset.publicAccess ? 1 : 0,
      asset.crossAccountAccess === null ? null : asset.crossAccountAccess ? 1 : 0,
      asset.externalSharing === null ? null : asset.externalSharing ? 1 : 0,
      asset.credentialsDetected === null ? null : asset.credentialsDetected ? 1 : 0,
      asset.dataSizeBytes,
      risk.score,
      risk.severity,
      risk.title,
      canonicalJson(risk.factors),
      canonicalJson(risk.recommendations),
    );
  }
  return db.prepare(
    `INSERT INTO dspm_asset_evidence
      (id, org_id, customer_id, connection_id, scan_run_id, resource_key, resource_type,
       region_key, classification, categories_json, owner_ref, encrypted, public_access,
       cross_account_access, external_sharing, credentials_detected, data_size_bytes,
       risk_score, risk_severity, risk_title, risk_factors_json, recommendations_json)
     VALUES ${placeholders}`,
  ).bind(...values);
}

export class DspmRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async existingByIdempotency(
    scope: DspmScope,
    connectionId: string,
    idempotencyKey: string,
  ): Promise<StoredDspmRun | null> {
    const row = await this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM dspm_scan_runs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND idempotency_key = ?
        LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, connectionId, idempotencyKey).first<RunRow>();
    return row === null ? null : mapRun(row);
  }

  /**
   * Publish immutable normalized DSPM evidence and atomically advance the
   * connection head. The caller-supplied key is replay-safe and content-bound:
   * an exact retry returns the original run, while key reuse with different
   * evidence fails closed.
   */
  public async publish(
    scope: DspmScope,
    request: DspmPublishRequest,
    context: DspmPublishContext,
  ): Promise<{ readonly run: StoredDspmRun; readonly replayed: boolean }> {
    assertScope(scope, request.connectionId);
    if (!IDENTIFIER.test(context.actorId)) invalid();
    const db = await this.ready();
    const connection = await db.prepare(
      `SELECT id FROM aws_connections WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(request.connectionId, scope.orgId, scope.customerId).first<{ id: string }>();
    if (connection === null) throw new DspmRepositoryError("NOT_FOUND", "Cloud connection not found");

    const evidenceSha256 = await dspmEvidenceSha256(request);
    const existing = await this.existingByIdempotency(
      scope,
      request.connectionId,
      request.idempotencyKey,
    );
    if (existing !== null) {
      if (existing.evidenceSha256 !== evidenceSha256) {
        throw new DspmRepositoryError("CONFLICT", "The idempotency key is already bound to different evidence");
      }
      return { run: existing, replayed: true };
    }

    const assessments = request.assets.map(assessDspmAsset);
    const findingCount = assessments.filter((assessment) => assessment.severity !== "none").length;
    const runId = id("dsr");
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO dspm_scan_runs
          (id, org_id, customer_id, connection_id, source, status, coverage_json,
           evidence_sha256, asset_count, finding_count, collected_at, imported_by, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        runId,
        scope.orgId,
        scope.customerId,
        request.connectionId,
        request.source,
        request.coverage.status,
        canonicalJson(request.coverage),
        evidenceSha256,
        request.assets.length,
        findingCount,
        request.collectedAtMs,
        context.actorId,
        request.idempotencyKey,
      ),
    ];
    const assets = assetInsert(db, scope, runId, request);
    if (assets !== null) statements.push(assets);
    statements.push(db.prepare(
      `INSERT INTO dspm_scan_heads
        (connection_id, org_id, customer_id, scan_run_id, collected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         org_id = excluded.org_id,
         customer_id = excluded.customer_id,
         scan_run_id = excluded.scan_run_id,
         collected_at = excluded.collected_at,
         updated_at = excluded.updated_at
       WHERE excluded.org_id = dspm_scan_heads.org_id
         AND excluded.customer_id = dspm_scan_heads.customer_id
         AND excluded.collected_at >= dspm_scan_heads.collected_at`,
    ).bind(
      request.connectionId,
      scope.orgId,
      scope.customerId,
      runId,
      request.collectedAtMs,
      Date.now(),
    ));

    try {
      await commitAuditedStatements({
        db,
        statements,
        audit: {
          orgId: scope.orgId,
          actorId: context.actorId,
          action: "dspm.evidence.published",
          targetType: "dspm_scan_run",
          targetId: runId,
          customerId: scope.customerId,
          outcome: "allowed",
          requestId: `dspm.${request.connectionId}.${request.idempotencyKey}`,
          metadata: {
            connectionId: request.connectionId,
            source: request.source,
            status: request.coverage.status,
            assetCount: String(request.assets.length),
            findingCount: String(findingCount),
            evidenceSha256,
          },
        },
        mutationGuard: {
          sql: "SELECT 1 FROM dspm_scan_runs WHERE id = ? AND org_id = ? AND customer_id = ? AND evidence_sha256 = ?",
          values: [runId, scope.orgId, scope.customerId, evidenceSha256],
        },
        persistenceMessage: "DSPM evidence and its audit event could not be committed",
      });
    } catch (error) {
      // Resolve a same-content concurrent retry as idempotent. Any conflicting
      // content or unrelated persistence error still fails closed.
      const raced = await this.existingByIdempotency(
        scope,
        request.connectionId,
        request.idempotencyKey,
      );
      if (raced !== null && raced.evidenceSha256 === evidenceSha256) {
        return { run: raced, replayed: true };
      }
      if (raced !== null) throw new DspmRepositoryError("CONFLICT", "The idempotency key is already bound to different evidence");
      throw error;
    }

    const saved = await this.getRun(scope, request.connectionId, runId);
    if (saved === null) throw new DspmRepositoryError("PERSISTENCE_FAILED");
    return { run: saved, replayed: false };
  }

  public async getRun(
    scope: DspmScope,
    connectionId: string,
    runId: string,
  ): Promise<StoredDspmRun | null> {
    assertScope(scope, connectionId);
    if (!RUN_ID.test(runId)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT ${RUN_COLUMNS} FROM dspm_scan_runs
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
        LIMIT 1`,
    ).bind(runId, scope.orgId, scope.customerId, connectionId).first<RunRow>();
    return row === null ? null : mapRun(row);
  }

  public async workspace(
    scope: DspmScope,
    connectionId: string,
    requestedRunId?: string,
  ): Promise<DspmWorkspace> {
    assertScope(scope, connectionId);
    if (requestedRunId !== undefined && !RUN_ID.test(requestedRunId)) invalid();
    const db = await this.ready();
    const runsResult = await db.prepare(
      `SELECT ${RUN_COLUMNS} FROM dspm_scan_runs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        ORDER BY collected_at DESC, id DESC LIMIT 25`,
    ).bind(scope.orgId, scope.customerId, connectionId).all<RunRow>();
    const runs = (runsResult.results ?? []).map(mapRun);
    const currentRun = requestedRunId === undefined
      ? await db.prepare(
        `SELECT ${JOINED_RUN_COLUMNS} FROM dspm_scan_heads h
          JOIN dspm_scan_runs r ON r.id = h.scan_run_id
         WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ? LIMIT 1`,
      ).bind(scope.orgId, scope.customerId, connectionId).first<RunRow>()
      : await db.prepare(
        `SELECT ${RUN_COLUMNS} FROM dspm_scan_runs
          WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ? LIMIT 1`,
      ).bind(requestedRunId, scope.orgId, scope.customerId, connectionId).first<RunRow>();
    if (currentRun === null) {
      return {
        state: "NEVER_SCANNED",
        currentRun: null,
        runs,
        assets: [],
        findings: [],
        summary: {
          assets: 0, findings: 0, critical: 0, high: 0, medium: 0, low: 0,
          unclassified: 0, ownerUnassigned: 0, publicAccess: 0,
        },
      };
    }
    const assetRows = await db.prepare(
      `SELECT ${ASSET_COLUMNS} FROM dspm_asset_evidence
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND scan_run_id = ?
        ORDER BY risk_score DESC, resource_key ASC`,
    ).bind(scope.orgId, scope.customerId, connectionId, currentRun.id).all<AssetRow>();
    const assets = (assetRows.results ?? []).map(mapAsset);
    const findings = assets.filter((asset) => asset.risk.severity !== "none");
    return {
      state: "AVAILABLE",
      currentRun: mapRun(currentRun),
      runs,
      assets,
      findings,
      summary: {
        assets: assets.length,
        findings: findings.length,
        critical: findings.filter((asset) => asset.risk.severity === "critical").length,
        high: findings.filter((asset) => asset.risk.severity === "high").length,
        medium: findings.filter((asset) => asset.risk.severity === "medium").length,
        low: findings.filter((asset) => asset.risk.severity === "low").length,
        unclassified: assets.filter((asset) => asset.classification === "unknown").length,
        ownerUnassigned: assets.filter((asset) => asset.ownerRef === null).length,
        publicAccess: assets.filter((asset) => asset.publicAccess === true).length,
      },
    };
  }
}
