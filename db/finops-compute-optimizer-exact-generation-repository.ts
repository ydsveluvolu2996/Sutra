/**
 * Immutable exact Compute Optimizer generation persistence.
 *
 * Canonical evidence is split into content-addressed 960 KiB chunks. An
 * artifact is invisible until its immutable manifest is inserted; for an
 * accepted generation, that manifest and the monotonic head change share the
 * final database batch. No monetary value is projected into a numeric column.
 */
import { canonicalJson } from "../lib/canonical-json.ts";
import {
  createComputeOptimizerExportGenerationAttempt,
  verifyComputeOptimizerExportGeneration,
  type ComputeOptimizerExportGeneration,
  type ComputeOptimizerExportGenerationAttempt,
} from "../lib/finops-compute-optimizer-export-generation.ts";
import {
  verifyComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlanSet,
} from "../lib/finops-compute-optimizer-export-plan.ts";
import { getRawDb } from "./index.ts";
import { isPostgresDatabase } from "./postgres-d1-adapter.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ATTEMPT_ID = /^coa_[a-f0-9]{64}$/u;
const GENERATION_ID = /^cog_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_DATE_MS = 8_640_000_000_000_000;
const ZERO_SHA256 = "0".repeat(64);

export const COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS = Object.freeze({
  chunkBytes: 960 * 1_024,
  chunkBatchSize: 16,
  /** D1/Worker path; larger generations must be routed to hosted PostgreSQL. */
  maximumD1EvidenceBytes: 8 * 1_024 * 1_024,
  /**
   * Current non-streaming Node/PostgreSQL path. Larger verified generations
   * require the future streaming writer; they are not claimed as supported.
   */
  maximumPostgresEvidenceBytes: 32 * 1_024 * 1_024,
  maximumChunks: 274,
  maximumBase64urlCharactersPerRow: 1_310_720,
  maximumBoundParametersPerStatement: 28,
} as const);

export interface ComputeOptimizerExactGenerationScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredComputeOptimizerExactArtifact {
  readonly artifactId: string;
  readonly recordKind: "ATTEMPT" | "GENERATION";
  readonly schemaVersion:
    | "sutra.compute-optimizer-export-generation-attempt.v1"
    | "sutra.compute-optimizer-export-generation.v1";
  readonly state: "PARTIAL" | "ALL_REGION_COMPLETE" | "ALL_REGION_ACCEPTED";
  readonly scope: ComputeOptimizerExactGenerationScope;
  readonly planSetId: string;
  readonly contentSha256: string;
  readonly evidenceSha256: string;
  readonly dataThroughAtIso: string;
  readonly observedAtIso: string;
  readonly totalBytes: number;
  readonly chunkCount: number;
  readonly createdAtIso: string;
  readonly committedAtIso: string;
}

export interface RecordComputeOptimizerExactGenerationResult {
  readonly artifact: StoredComputeOptimizerExactArtifact;
  readonly becameHead: boolean;
  readonly activeGenerationId: string | null;
}

export interface ComputeOptimizerAcceptedHeadReference {
  readonly generationId: string;
  readonly planSetId: string;
  readonly planSetContentSha256: string;
}

export interface ComputeOptimizerExactPersistenceFaultEvent {
  readonly phase: "AFTER_ARTIFACT" | "AFTER_CHUNK_BATCH" | "BEFORE_COMMIT";
  readonly artifactId: string;
  readonly completedChunks: number;
  readonly totalChunks: number;
}

export type ComputeOptimizerExactPersistenceFaultInjector = (
  event: ComputeOptimizerExactPersistenceFaultEvent,
) => void | Promise<void>;

export class ComputeOptimizerExactGenerationRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "LIMIT_EXCEEDED"
    | "SCOPE_NOT_FOUND"
    | "PLAN_SET_NOT_COMMITTED"
    | "IMMUTABLE_CONFLICT"
    | "INCOMPLETE_WRITE"
    | "STORED_EVIDENCE_INVALID";

  public constructor(code: ComputeOptimizerExactGenerationRepositoryError["code"]) {
    super("Exact Compute Optimizer generation persistence rejected");
    this.name = "ComputeOptimizerExactGenerationRepositoryError";
    this.code = code;
  }
}

interface ArtifactRow {
  artifact_id: string;
  record_kind: string;
  schema_version: string;
  state: string;
  accepted_head_eligible: boolean | number | string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  plan_set_id: string;
  plan_set_content_sha256: string;
  requester_account_id: string;
  partition: string;
  content_sha256: string;
  evidence_sha256: string;
  scheduled_window: string;
  materialized_at: string;
  data_through_at: string;
  observed_at: string;
  expected_target_count: number | string;
  mapped_target_count: number | string;
  recommendation_count: number | string;
  rejected_row_count: number | string;
  source_bytes: number | string;
  total_bytes: number | string;
  chunk_count: number | string;
  created_at: number | string;
}

interface ManifestRow {
  evidence_sha256: string;
  final_chain_sha256: string;
  total_bytes: number | string;
  chunk_count: number | string;
  committed_at: number | string;
}

interface ChunkRow {
  chunk_index: number | string;
  byte_count: number | string;
  chunk_sha256: string;
  previous_chain_sha256: string;
  chain_sha256: string;
  payload_base64url: string;
}

interface HeadRow {
  generation_id: string;
  data_through_at: string;
  observed_at: string;
}

interface VerifiedArtifact {
  readonly value: ComputeOptimizerExportGenerationAttempt | ComputeOptimizerExportGeneration;
  readonly recordKind: "ATTEMPT" | "GENERATION";
  readonly artifactId: string;
  readonly canonical: string;
  readonly bytes: Uint8Array;
  readonly evidenceSha256: string;
  readonly chunks: readonly EncodedChunk[];
}

interface EncodedChunk {
  readonly index: number;
  readonly bytes: Uint8Array;
  readonly payloadBase64url: string;
  readonly chunkSha256: string;
  readonly previousChainSha256: string;
  readonly chainSha256: string;
}

function reject(code: ComputeOptimizerExactGenerationRepositoryError["code"]): never {
  throw new ComputeOptimizerExactGenerationRepositoryError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertScope(scope: ComputeOptimizerExactGenerationScope): void {
  if (!isRecord(scope)
    || Object.keys(scope).length !== 3
    || typeof scope.organizationId !== "string"
    || typeof scope.customerId !== "string"
    || typeof scope.connectionId !== "string"
    || !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)) reject("INVALID_INPUT");
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)
    || parsed < minimum || parsed > maximum) reject("STORED_EVIDENCE_INVALID");
  return parsed;
}

function booleanValue(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  reject("STORED_EVIDENCE_INVALID");
}

function normalizedIso(value: unknown): string {
  if (typeof value !== "string") reject("STORED_EVIDENCE_INVALID");
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) {
    reject("STORED_EVIDENCE_INVALID");
  }
  return value;
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64urlDecode(value: string, expectedBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) reject("STORED_EVIDENCE_INVALID");
  const padding = "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    reject("STORED_EVIDENCE_INVALID");
  }
  if (binary.length !== expectedBytes) reject("STORED_EVIDENCE_INVALID");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (base64urlEncode(bytes) !== value) reject("STORED_EVIDENCE_INVALID");
  return bytes;
}

async function encodeChunks(bytes: Uint8Array): Promise<readonly EncodedChunk[]> {
  const chunks: EncodedChunk[] = [];
  let previous = ZERO_SHA256;
  for (let offset = 0, index = 0; offset < bytes.length;
    offset += COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.chunkBytes, index += 1) {
    const chunkBytes = bytes.slice(
      offset,
      Math.min(offset + COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.chunkBytes, bytes.length),
    );
    const chunkSha256 = await sha256(chunkBytes);
    const chainSha256 = await sha256(`${previous}:${index}:${chunkSha256}`);
    chunks.push({
      index,
      bytes: chunkBytes,
      payloadBase64url: base64urlEncode(chunkBytes),
      chunkSha256,
      previousChainSha256: previous,
      chainSha256,
    });
    previous = chainSha256;
  }
  if (chunks.length < 1
    || chunks.length > COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumChunks) {
    reject("INVALID_INPUT");
  }
  return chunks;
}

function verificationOptions(value: ComputeOptimizerExportGenerationAttempt | ComputeOptimizerExportGeneration) {
  const materializedAtMs = Date.parse(value.materializedAtIso);
  if (!Number.isSafeInteger(materializedAtMs)
    || new Date(materializedAtMs).toISOString() !== value.materializedAtIso) reject("INVALID_INPUT");
  return { scheduledWindow: value.scheduledWindow, materializedAtMs };
}

async function verifyArtifact(
  planSet: ComputeOptimizerExportPlanSet,
  unsafeValue: unknown,
  expectedKind?: "ATTEMPT" | "GENERATION",
  maximumEvidenceBytes = COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumD1EvidenceBytes,
): Promise<VerifiedArtifact> {
  let verifiedPlanSet: ComputeOptimizerExportPlanSet;
  try {
    verifiedPlanSet = await verifyComputeOptimizerExportPlanSet(structuredClone(planSet));
  } catch {
    reject("INVALID_INPUT");
  }
  if (!isRecord(unsafeValue) || typeof unsafeValue.schemaVersion !== "string") reject("INVALID_INPUT");
  let value: ComputeOptimizerExportGenerationAttempt | ComputeOptimizerExportGeneration;
  let recordKind: "ATTEMPT" | "GENERATION";
  try {
    if (unsafeValue.schemaVersion === "sutra.compute-optimizer-export-generation.v1") {
      value = await verifyComputeOptimizerExportGeneration(
        verifiedPlanSet,
        structuredClone(unsafeValue),
        verificationOptions(unsafeValue as unknown as ComputeOptimizerExportGeneration),
      );
      recordKind = "GENERATION";
    } else if (unsafeValue.schemaVersion
      === "sutra.compute-optimizer-export-generation-attempt.v1") {
      const candidate = unsafeValue as unknown as ComputeOptimizerExportGenerationAttempt;
      const regenerated = await createComputeOptimizerExportGenerationAttempt(
        verifiedPlanSet,
        candidate.targets,
        candidate.freshBindings,
        verificationOptions(candidate),
      );
      if (canonicalJson(candidate) !== canonicalJson(regenerated)) reject("INVALID_INPUT");
      value = regenerated;
      recordKind = "ATTEMPT";
    } else reject("INVALID_INPUT");
  } catch (error) {
    if (error instanceof ComputeOptimizerExactGenerationRepositoryError) throw error;
    reject("INVALID_INPUT");
  }
  if (expectedKind !== undefined && recordKind !== expectedKind) reject("INVALID_INPUT");
  const canonical = canonicalJson(value);
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.length < 1
    || bytes.length > maximumEvidenceBytes) {
    reject("LIMIT_EXCEEDED");
  }
  return {
    value,
    recordKind,
    artifactId: recordKind === "GENERATION"
      ? (value as ComputeOptimizerExportGeneration).generationId
      : (value as ComputeOptimizerExportGenerationAttempt).attemptId,
    canonical,
    bytes,
    evidenceSha256: await sha256(bytes),
    chunks: await encodeChunks(bytes),
  };
}

function artifactMatches(row: ArtifactRow, verified: VerifiedArtifact): boolean {
  const value = verified.value;
  const scope = value.scope;
  return row.artifact_id === verified.artifactId
    && row.record_kind === verified.recordKind
    && row.schema_version === value.schemaVersion
    && row.state === value.state
    && booleanValue(row.accepted_head_eligible) === value.acceptedHeadEligible
    && row.org_id === scope.orgId
    && row.customer_id === scope.customerId
    && row.connection_id === scope.connectionId
    && row.plan_set_id === value.planSetId
    && row.plan_set_content_sha256 === value.planSetContentSha256
    && row.requester_account_id === value.requesterAccountId
    && row.partition === value.partition
    && row.content_sha256 === value.contentSha256
    && row.evidence_sha256 === verified.evidenceSha256
    && row.scheduled_window === value.scheduledWindow
    && row.materialized_at === value.materializedAtIso
    && row.data_through_at === value.dataThroughAtIso
    && row.observed_at === value.observedAtIso
    && integer(row.expected_target_count, 1, 400) === value.coverage.expectedTargetCount
    && integer(row.mapped_target_count, 0, 400) === value.coverage.mappedTargetCount
    && integer(row.recommendation_count, 0, 40_000_000) === value.coverage.recommendationCount
    && integer(row.rejected_row_count, 0, 40_000_000) === value.coverage.rejectedRowCount
    && integer(row.source_bytes, 0, 107_793_612_800) === value.coverage.sourceBytes
    && integer(row.total_bytes, 1, 268_435_456) === verified.bytes.length
    && integer(row.chunk_count, 1, 274) === verified.chunks.length;
}

function storedArtifact(row: ArtifactRow, manifest: ManifestRow): StoredComputeOptimizerExactArtifact {
  const recordKind = row.record_kind;
  const schemaVersion = row.schema_version;
  const state = row.state;
  if ((recordKind !== "ATTEMPT" && recordKind !== "GENERATION")
    || (schemaVersion !== "sutra.compute-optimizer-export-generation-attempt.v1"
      && schemaVersion !== "sutra.compute-optimizer-export-generation.v1")
    || (state !== "PARTIAL" && state !== "ALL_REGION_COMPLETE"
      && state !== "ALL_REGION_ACCEPTED")
    || !SHA256.test(row.content_sha256) || !SHA256.test(row.evidence_sha256)
    || manifest.evidence_sha256 !== row.evidence_sha256
    || !SHA256.test(manifest.final_chain_sha256)) reject("STORED_EVIDENCE_INVALID");
  const createdAt = integer(row.created_at, 0, MAX_DATE_MS);
  const committedAt = integer(manifest.committed_at, 0, MAX_DATE_MS);
  const totalBytes = integer(row.total_bytes, 1, 268_435_456);
  const chunkCount = integer(row.chunk_count, 1, 274);
  if (integer(manifest.total_bytes, 1, 268_435_456) !== totalBytes
    || integer(manifest.chunk_count, 1, 274) !== chunkCount) reject("STORED_EVIDENCE_INVALID");
  return {
    artifactId: row.artifact_id,
    recordKind,
    schemaVersion,
    state,
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
    },
    planSetId: row.plan_set_id,
    contentSha256: row.content_sha256,
    evidenceSha256: row.evidence_sha256,
    dataThroughAtIso: normalizedIso(row.data_through_at),
    observedAtIso: normalizedIso(row.observed_at),
    totalBytes,
    chunkCount,
    createdAtIso: new Date(createdAt).toISOString(),
    committedAtIso: new Date(committedAt).toISOString(),
  };
}

function manifestMatches(manifest: ManifestRow, verified: VerifiedArtifact): boolean {
  return manifest.evidence_sha256 === verified.evidenceSha256
    && manifest.final_chain_sha256 === verified.chunks.at(-1)?.chainSha256
    && integer(manifest.total_bytes, 1, 268_435_456) === verified.bytes.length
    && integer(manifest.chunk_count, 1, 274) === verified.chunks.length;
}

export class ComputeOptimizerExactGenerationRepository {
  private readonly database: D1Database;
  private readonly faultInjector?: ComputeOptimizerExactPersistenceFaultInjector;

  public constructor(
    database: D1Database = getRawDb(),
    faultInjector?: ComputeOptimizerExactPersistenceFaultInjector,
  ) {
    this.database = database;
    this.faultInjector = faultInjector;
  }

  private async ready(): Promise<void> {
    await ensureRuntimeSchema(this.database);
  }

  private async assertCommittedPlanSet(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
  ): Promise<void> {
    assertScope(scope);
    if (planSet.scope.orgId !== scope.organizationId
      || planSet.scope.customerId !== scope.customerId
      || planSet.scope.connectionId !== scope.connectionId) reject("INVALID_INPUT");
    await this.ready();
    const row = await this.database.prepare(
      `SELECT s.plan_set_id FROM finops_co_export_plan_sets s
       JOIN aws_connections c ON c.id=s.connection_id AND c.org_id=s.org_id
         AND c.customer_id=s.customer_id AND c.status='active' AND c.source_kind='aws_trust_role'
       JOIN organizations o ON o.id=s.org_id AND o.status='active'
       JOIN customers cu ON cu.id=s.customer_id AND cu.org_id=s.org_id AND cu.status='active'
       WHERE s.org_id=? AND s.customer_id=? AND s.connection_id=?
         AND s.plan_set_id=? AND s.content_sha256=? AND s.requester_account_id=?
         AND s.partition=? AND s.finalized=1
         AND c.aws_account_id=s.requester_account_id AND c.partition=s.partition
         AND (SELECT count(*) FROM finops_co_export_plan_set_members sm
           WHERE sm.plan_set_id=s.plan_set_id)=s.plan_count LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      planSet.planSetId,
      planSet.contentSha256,
      planSet.requesterAccountId,
      planSet.partition,
    ).first<{ plan_set_id: string }>();
    if (row === null) reject("PLAN_SET_NOT_COMMITTED");
  }

  private async artifactRow(artifactId: string): Promise<ArtifactRow | null> {
    return this.database.prepare(
      "SELECT * FROM finops_co_exact_artifacts WHERE artifact_id=? LIMIT 1",
    ).bind(artifactId).first<ArtifactRow>();
  }

  private async manifestRow(artifactId: string): Promise<ManifestRow | null> {
    return this.database.prepare(
      `SELECT evidence_sha256,final_chain_sha256,total_bytes,chunk_count,committed_at
       FROM finops_co_exact_artifact_manifests WHERE artifact_id=? LIMIT 1`,
    ).bind(artifactId).first<ManifestRow>();
  }

  private async inject(event: ComputeOptimizerExactPersistenceFaultEvent): Promise<void> {
    await this.faultInjector?.(event);
  }

  private async validateStoredChunks(
    artifactId: string,
    expected: VerifiedArtifact,
  ): Promise<void> {
    let next = 0;
    while (next < expected.chunks.length) {
      const result = await this.database.prepare(
        `SELECT chunk_index,byte_count,chunk_sha256,previous_chain_sha256,
           chain_sha256,payload_base64url
         FROM finops_co_exact_artifact_chunks
         WHERE artifact_id=? AND chunk_index>=? ORDER BY chunk_index ASC LIMIT 16`,
      ).bind(artifactId, next).all<ChunkRow>();
      const rows = result.results ?? [];
      if (rows.length === 0) reject("INCOMPLETE_WRITE");
      for (const row of rows) {
        const index = integer(row.chunk_index, 0, 273);
        const wanted = expected.chunks[index];
        if (index !== next || wanted === undefined
          || integer(row.byte_count, 1, 983_040) !== wanted.bytes.length
          || row.chunk_sha256 !== wanted.chunkSha256
          || row.previous_chain_sha256 !== wanted.previousChainSha256
          || row.chain_sha256 !== wanted.chainSha256
          || row.payload_base64url !== wanted.payloadBase64url) {
          reject("IMMUTABLE_CONFLICT");
        }
        next += 1;
      }
    }
  }

  private async record(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
    unsafeValue: unknown,
    kind: "ATTEMPT" | "GENERATION",
    nowMs: number,
  ): Promise<RecordComputeOptimizerExactGenerationResult> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_DATE_MS) reject("INVALID_INPUT");
    const verified = await verifyArtifact(
      planSet,
      unsafeValue,
      kind,
      isPostgresDatabase(this.database)
        ? COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumPostgresEvidenceBytes
        : COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumD1EvidenceBytes,
    );
    await this.assertCommittedPlanSet(scope, planSet);
    const alreadyCommitted = await this.manifestRow(verified.artifactId);
    if (alreadyCommitted !== null) {
      const row = await this.artifactRow(verified.artifactId);
      if (row === null || !artifactMatches(row, verified)
        || !manifestMatches(alreadyCommitted, verified)) reject("IMMUTABLE_CONFLICT");
      await this.validateStoredChunks(verified.artifactId, verified);
      const head = await this.headRow(scope);
      return {
        artifact: storedArtifact(row, alreadyCommitted),
        becameHead: false,
        activeGenerationId: head?.generation_id ?? null,
      };
    }
    const value = verified.value;
    await this.database.prepare(
      `INSERT INTO finops_co_exact_artifacts (
        artifact_id,record_kind,schema_version,state,accepted_head_eligible,
        org_id,customer_id,connection_id,plan_set_id,plan_set_content_sha256,
        requester_account_id,partition,content_sha256,evidence_sha256,
        scheduled_window,materialized_at,data_through_at,observed_at,
        expected_target_count,mapped_target_count,recommendation_count,
        rejected_row_count,source_bytes,total_bytes,chunk_count,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(artifact_id) DO NOTHING`,
    ).bind(
      verified.artifactId,
      verified.recordKind,
      value.schemaVersion,
      value.state,
      value.acceptedHeadEligible,
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      value.planSetId,
      value.planSetContentSha256,
      value.requesterAccountId,
      value.partition,
      value.contentSha256,
      verified.evidenceSha256,
      value.scheduledWindow,
      value.materializedAtIso,
      value.dataThroughAtIso,
      value.observedAtIso,
      value.coverage.expectedTargetCount,
      value.coverage.mappedTargetCount,
      value.coverage.recommendationCount,
      value.coverage.rejectedRowCount,
      value.coverage.sourceBytes,
      verified.bytes.length,
      verified.chunks.length,
      nowMs,
    ).run();
    const row = await this.artifactRow(verified.artifactId);
    if (row === null || !artifactMatches(row, verified)) reject("IMMUTABLE_CONFLICT");
    await this.inject({
      phase: "AFTER_ARTIFACT",
      artifactId: verified.artifactId,
      completedChunks: 0,
      totalChunks: verified.chunks.length,
    });
    for (let offset = 0; offset < verified.chunks.length;
      offset += COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.chunkBatchSize) {
      const slice = verified.chunks.slice(
        offset,
        offset + COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.chunkBatchSize,
      );
      try {
        await this.database.batch(slice.map((chunk) => this.database.prepare(
          `INSERT INTO finops_co_exact_artifact_chunks (
            artifact_id,chunk_index,byte_count,chunk_sha256,previous_chain_sha256,
            chain_sha256,payload_base64url
          ) VALUES (?,?,?,?,?,?,?) ON CONFLICT(artifact_id,chunk_index) DO NOTHING`,
        ).bind(
          verified.artifactId,
          chunk.index,
          chunk.bytes.length,
          chunk.chunkSha256,
          chunk.previousChainSha256,
          chunk.chainSha256,
          chunk.payloadBase64url,
        )));
      } catch (error) {
        const committed = await this.manifestRow(verified.artifactId);
        if (committed === null) throw error;
      }
      await this.inject({
        phase: "AFTER_CHUNK_BATCH",
        artifactId: verified.artifactId,
        completedChunks: Math.min(offset + slice.length, verified.chunks.length),
        totalChunks: verified.chunks.length,
      });
    }
    await this.validateStoredChunks(verified.artifactId, verified);
    await this.inject({
      phase: "BEFORE_COMMIT",
      artifactId: verified.artifactId,
      completedChunks: verified.chunks.length,
      totalChunks: verified.chunks.length,
    });
    const finalChain = verified.chunks.at(-1)?.chainSha256;
    if (finalChain === undefined) reject("INVALID_INPUT");
    const statements = [this.database.prepare(
      `INSERT INTO finops_co_exact_artifact_manifests (
        artifact_id,evidence_sha256,final_chain_sha256,total_bytes,chunk_count,committed_at
      ) VALUES (?,?,?,?,?,?) ON CONFLICT(artifact_id) DO NOTHING`,
    ).bind(
      verified.artifactId,
      verified.evidenceSha256,
      finalChain,
      verified.bytes.length,
      verified.chunks.length,
      nowMs,
    )];
    const beforeHead = await this.headRow(scope);
    if (kind === "GENERATION") {
      statements.push(this.database.prepare(
        `INSERT INTO finops_co_exact_generation_heads (
          org_id,customer_id,connection_id,generation_id,data_through_at,observed_at,advanced_at
        ) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(org_id,customer_id,connection_id) DO UPDATE SET
          generation_id=excluded.generation_id,
          data_through_at=excluded.data_through_at,
          observed_at=excluded.observed_at,
          advanced_at=excluded.advanced_at
        WHERE excluded.data_through_at > finops_co_exact_generation_heads.data_through_at
          OR (excluded.data_through_at = finops_co_exact_generation_heads.data_through_at
            AND excluded.observed_at > finops_co_exact_generation_heads.observed_at)`,
      ).bind(
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        verified.artifactId,
        value.dataThroughAtIso,
        value.observedAtIso,
        nowMs,
      ));
    }
    await this.database.batch(statements);
    const manifest = await this.manifestRow(verified.artifactId);
    if (manifest === null) reject("INCOMPLETE_WRITE");
    if (!manifestMatches(manifest, verified)) reject("STORED_EVIDENCE_INVALID");
    const head = await this.headRow(scope);
    const becameHead = kind === "GENERATION"
      && head?.generation_id === verified.artifactId
      && beforeHead?.generation_id !== verified.artifactId;
    return {
      artifact: storedArtifact(row, manifest),
      becameHead,
      activeGenerationId: head?.generation_id ?? null,
    };
  }

  private async headRow(scope: ComputeOptimizerExactGenerationScope): Promise<HeadRow | null> {
    return this.database.prepare(
      `SELECT h.generation_id,h.data_through_at,h.observed_at
       FROM finops_co_exact_generation_heads h
       JOIN finops_co_exact_artifacts a ON a.artifact_id=h.generation_id
       JOIN finops_co_exact_artifact_manifests m ON m.artifact_id=a.artifact_id
       WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=? LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<HeadRow>();
  }

  private async readCommitted(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
    artifactId: string,
    expectedKind: "ATTEMPT" | "GENERATION",
  ): Promise<ComputeOptimizerExportGenerationAttempt | ComputeOptimizerExportGeneration | null> {
    await this.assertCommittedPlanSet(scope, planSet);
    const row = await this.database.prepare(
      `SELECT a.* FROM finops_co_exact_artifacts a
       JOIN finops_co_exact_artifact_manifests m ON m.artifact_id=a.artifact_id
       WHERE a.org_id=? AND a.customer_id=? AND a.connection_id=?
         AND a.artifact_id=? AND a.record_kind=? LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      artifactId,
      expectedKind,
    ).first<ArtifactRow>();
    if (row === null) return null;
    const manifest = await this.manifestRow(artifactId);
    if (manifest === null) return null;
    const totalBytes = integer(row.total_bytes, 1, 268_435_456);
    const chunkCount = integer(row.chunk_count, 1, 274);
    const combined = new Uint8Array(totalBytes);
    let position = 0;
    let expectedIndex = 0;
    let previous = ZERO_SHA256;
    while (expectedIndex < chunkCount) {
      const result = await this.database.prepare(
        `SELECT chunk_index,byte_count,chunk_sha256,previous_chain_sha256,
           chain_sha256,payload_base64url
         FROM finops_co_exact_artifact_chunks
         WHERE artifact_id=? AND chunk_index>=? ORDER BY chunk_index ASC LIMIT 16`,
      ).bind(artifactId, expectedIndex).all<ChunkRow>();
      const rows = result.results ?? [];
      if (rows.length === 0) reject("STORED_EVIDENCE_INVALID");
      for (const chunk of rows) {
        const index = integer(chunk.chunk_index, 0, 273);
        const byteCount = integer(chunk.byte_count, 1, 983_040);
        if (index !== expectedIndex || chunk.previous_chain_sha256 !== previous
          || !SHA256.test(chunk.chunk_sha256) || !SHA256.test(chunk.chain_sha256)) {
          reject("STORED_EVIDENCE_INVALID");
        }
        const bytes = base64urlDecode(chunk.payload_base64url, byteCount);
        const chunkSha = await sha256(bytes);
        const chainSha = await sha256(`${previous}:${index}:${chunkSha}`);
        if (chunkSha !== chunk.chunk_sha256 || chainSha !== chunk.chain_sha256
          || position + bytes.length > combined.length) reject("STORED_EVIDENCE_INVALID");
        combined.set(bytes, position);
        position += bytes.length;
        previous = chainSha;
        expectedIndex += 1;
      }
    }
    if (position !== totalBytes || previous !== manifest.final_chain_sha256
      || integer(manifest.total_bytes, 1, 268_435_456) !== totalBytes
      || integer(manifest.chunk_count, 1, 274) !== chunkCount
      || await sha256(combined) !== row.evidence_sha256
      || manifest.evidence_sha256 !== row.evidence_sha256) reject("STORED_EVIDENCE_INVALID");
    let canonical: string;
    let parsed: unknown;
    try {
      canonical = new TextDecoder("utf-8", { fatal: true }).decode(combined);
      parsed = JSON.parse(canonical);
    } catch {
      reject("STORED_EVIDENCE_INVALID");
    }
    if (canonicalJson(parsed) !== canonical) reject("STORED_EVIDENCE_INVALID");
    let verified: VerifiedArtifact;
    try {
      verified = await verifyArtifact(
        planSet,
        parsed,
        expectedKind,
        isPostgresDatabase(this.database)
          ? COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumPostgresEvidenceBytes
          : COMPUTE_OPTIMIZER_EXACT_PERSISTENCE_BOUNDS.maximumD1EvidenceBytes,
      );
    } catch {
      reject("STORED_EVIDENCE_INVALID");
    }
    if (!artifactMatches(row, verified)) reject("STORED_EVIDENCE_INVALID");
    storedArtifact(row, manifest);
    return verified.value;
  }

  public recordAttempt(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
    attempt: ComputeOptimizerExportGenerationAttempt,
    nowMs = Date.now(),
  ): Promise<RecordComputeOptimizerExactGenerationResult> {
    return this.record(scope, planSet, attempt, "ATTEMPT", nowMs);
  }

  public recordAcceptedGeneration(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
    generation: ComputeOptimizerExportGeneration,
    nowMs = Date.now(),
  ): Promise<RecordComputeOptimizerExactGenerationResult> {
    return this.record(scope, planSet, generation, "GENERATION", nowMs);
  }

  public async getAttempt(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
    attemptId: string,
  ): Promise<ComputeOptimizerExportGenerationAttempt | null> {
    if (!ATTEMPT_ID.test(attemptId)) reject("INVALID_INPUT");
    const value = await this.readCommitted(scope, planSet, attemptId, "ATTEMPT");
    return value as ComputeOptimizerExportGenerationAttempt | null;
  }

  public async getAcceptedHeadForPlanSet(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
  ): Promise<ComputeOptimizerExportGeneration | null> {
    assertScope(scope);
    await this.ready();
    const head = await this.headRow(scope);
    if (head === null) return null;
    if (!GENERATION_ID.test(head.generation_id)) reject("STORED_EVIDENCE_INVALID");
    const artifact = await this.database.prepare(
      `SELECT a.* FROM finops_co_exact_artifacts a
       JOIN finops_co_exact_artifact_manifests m ON m.artifact_id=a.artifact_id
       WHERE a.artifact_id=? LIMIT 1`,
    ).bind(head.generation_id).first<ArtifactRow>();
    if (artifact === null) reject("STORED_EVIDENCE_INVALID");
    if (artifact.plan_set_id !== planSet.planSetId
      || artifact.plan_set_content_sha256 !== planSet.contentSha256) return null;
    const value = await this.readCommitted(scope, planSet, head.generation_id, "GENERATION");
    return value as ComputeOptimizerExportGeneration | null;
  }

  /** Read one immutable accepted generation by a previously resolved head ID. */
  public async getAcceptedGeneration(
    scope: ComputeOptimizerExactGenerationScope,
    planSet: ComputeOptimizerExportPlanSet,
    generationId: string,
  ): Promise<ComputeOptimizerExportGeneration | null> {
    if (!GENERATION_ID.test(generationId)) reject("INVALID_INPUT");
    const value = await this.readCommitted(scope, planSet, generationId, "GENERATION");
    return value as ComputeOptimizerExportGeneration | null;
  }

  /** Resolve only the authenticated identity needed to rehydrate the plan set. */
  public async getAcceptedHeadReference(
    scope: ComputeOptimizerExactGenerationScope,
  ): Promise<ComputeOptimizerAcceptedHeadReference | null> {
    assertScope(scope);
    await this.ready();
    const row = await this.database.prepare(
      `SELECT h.generation_id,a.plan_set_id,a.plan_set_content_sha256
       FROM finops_co_exact_generation_heads h
       JOIN finops_co_exact_artifacts a ON a.artifact_id=h.generation_id
        AND a.org_id=h.org_id AND a.customer_id=h.customer_id
        AND a.connection_id=h.connection_id
       JOIN finops_co_exact_artifact_manifests m ON m.artifact_id=a.artifact_id
       WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=?
        AND a.record_kind='GENERATION' AND a.state='ALL_REGION_ACCEPTED'
        AND a.accepted_head_eligible=1 LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{
      generation_id: string;
      plan_set_id: string;
      plan_set_content_sha256: string;
    }>();
    if (row === null) return null;
    if (!GENERATION_ID.test(row.generation_id)
      || !/^copes_[a-f0-9]{64}$/u.test(row.plan_set_id)
      || !SHA256.test(row.plan_set_content_sha256)
      || row.plan_set_id !== `copes_${row.plan_set_content_sha256}`) {
      reject("STORED_EVIDENCE_INVALID");
    }
    return Object.freeze({
      generationId: row.generation_id,
      planSetId: row.plan_set_id,
      planSetContentSha256: row.plan_set_content_sha256,
    });
  }
}
