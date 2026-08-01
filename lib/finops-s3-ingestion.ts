/**
 * Bounded orchestration for canonical AWS Data Exports ingestion.
 *
 * This boundary performs no AWS calls itself. Callers inject an object reader
 * and gzip decompressor; the orchestrator only requests the immutable objects
 * already enumerated by a ValidatedFinopsManifest. There is deliberately no
 * fixture, alternate-key, or network fallback.
 */
import type {
  BeginFinopsBillingGenerationResult,
  CommitFinopsBillingGenerationResult,
  FinopsBillingGeneration,
  FinopsBillingReconciliation,
  FinopsBillingScope,
} from "../db/finops-billing-engine-repository.ts";
import {
  CUR_MAX_ROWS,
  parseCsv,
  parseCurCsv,
  type CanonicalCurLine,
} from "./finops-cur.ts";
import type {
  FinopsManifestObject,
  ValidatedFinopsManifest,
} from "./finops-data-export.ts";
import {
  reconcileCanonicalBillingGeneration,
  type FinopsReconciliationEvidence,
  type FinopsReconciliationFailure,
  type FinopsReconciliationResult,
  type ScopedCanonicalBillingRow,
} from "./finops-reconciliation.ts";

const MAX_SAFE_LIMIT = 2_147_483_647;
const MAX_REPOSITORY_STAGE_CHUNK = 250;
const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

export const DEFAULT_FINOPS_S3_INGESTION_LIMITS = {
  maxObjectCompressedBytes: 32 * 1_024 * 1_024,
  maxTotalCompressedBytes: 256 * 1_024 * 1_024,
  maxObjectUncompressedBytes: 256 * 1_024 * 1_024,
  maxTotalUncompressedBytes: 512 * 1_024 * 1_024,
  maxRowsPerObject: CUR_MAX_ROWS,
  maxTotalRows: 250_000,
  stageChunkRows: 200,
} as const;

export interface FinopsS3IngestionLimits {
  readonly maxObjectCompressedBytes: number;
  readonly maxTotalCompressedBytes: number;
  readonly maxObjectUncompressedBytes: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxRowsPerObject: number;
  readonly maxTotalRows: number;
  readonly stageChunkRows: number;
}

export interface FinopsS3ObjectReadRequest {
  readonly scope: Readonly<FinopsBillingScope>;
  readonly bucket: string;
  readonly key: string;
  /**
   * Exact ceiling for this object after applying both the per-object limit and
   * the remaining manifest-wide compressed-byte budget. Readers must abort
   * their source stream before buffering a byte beyond this value.
   */
  readonly maximumCompressedBytes: number;
}

export type FinopsS3ObjectReader = (
  request: FinopsS3ObjectReadRequest,
) => Promise<Uint8Array>;

export interface FinopsGzipDecompressionRequest {
  readonly scope: Readonly<FinopsBillingScope>;
  readonly object: Readonly<FinopsManifestObject>;
  readonly compressed: Uint8Array;
  /**
   * The decompressor must abort when this many output bytes would be exceeded.
   * The orchestrator independently verifies the returned byte length.
   */
  readonly maximumOutputBytes: number;
}

export type FinopsGzipDecompressor = (
  request: FinopsGzipDecompressionRequest,
) => Promise<Uint8Array>;

/**
 * Structural repository contract keeps the orchestrator dependency-injected
 * and testable without a database or network.
 */
export interface FinopsS3IngestionRepository {
  beginValidatedManifest(
    manifest: ValidatedFinopsManifest,
  ): Promise<BeginFinopsBillingGenerationResult>;
  stageCanonicalLines(
    scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    lines: readonly CanonicalCurLine[],
  ): Promise<unknown>;
  commitGeneration(
    scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    reconciliation: FinopsBillingReconciliation,
  ): Promise<CommitFinopsBillingGenerationResult>;
  failGeneration(
    scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    errorCode: string,
  ): Promise<void>;
}

export interface FinopsS3IngestionDependencies {
  readonly repository: FinopsS3IngestionRepository;
  readonly readObject: FinopsS3ObjectReader;
  readonly decompressGzip: FinopsGzipDecompressor;
}

export interface FinopsS3IngestionRequest {
  readonly manifest: ValidatedFinopsManifest;
  /**
   * Authoritative expected totals. This cannot be inferred from parsed rows:
   * doing so would make reconciliation circular.
   */
  readonly evidence: FinopsReconciliationEvidence;
  readonly limits?: Readonly<Partial<FinopsS3IngestionLimits>>;
}

export interface FinopsRejectedSourceRowEvidence {
  readonly bucket: string;
  readonly key: string;
  /** One-based data-row number within this exact source object. */
  readonly rowNumber: number;
  readonly reason: string;
}

export interface FinopsIngestedObjectSummary {
  readonly bucket: string;
  readonly key: string;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly sourceRows: number;
  readonly acceptedRows: number;
  readonly rejectedRows: number;
}

export type FinopsS3IngestionResult =
  | {
      readonly action: "skipped";
      readonly reason: "duplicate_manifest";
      readonly generation: FinopsBillingGeneration;
      readonly objects: readonly [];
      readonly rejectedRows: readonly [];
      readonly reconciliation: null;
    }
  | {
      readonly action: "committed";
      readonly generation: FinopsBillingGeneration;
      readonly objects: readonly FinopsIngestedObjectSummary[];
      readonly compressedBytes: number;
      readonly uncompressedBytes: number;
      readonly sourceRows: number;
      readonly acceptedRows: number;
      readonly rejectedRowCount: number;
      readonly rejectedRows: readonly FinopsRejectedSourceRowEvidence[];
      readonly reconciliation: Extract<FinopsReconciliationResult, { readonly ok: true }>;
      readonly committed: CommitFinopsBillingGenerationResult;
    };

export class FinopsS3IngestionError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "UNSUPPORTED_OBJECT"
    | "OBJECT_READ_FAILED"
    | "INVALID_COMPRESSED_OBJECT"
    | "OBJECT_COMPRESSED_LIMIT_EXCEEDED"
    | "TOTAL_COMPRESSED_LIMIT_EXCEEDED"
    | "DECOMPRESSION_FAILED"
    | "OBJECT_UNCOMPRESSED_LIMIT_EXCEEDED"
    | "TOTAL_UNCOMPRESSED_LIMIT_EXCEEDED"
    | "INVALID_UTF8"
    | "SCHEMA_DRIFT"
    | "PARSE_FAILED"
    | "OBJECT_ROW_LIMIT_EXCEEDED"
    | "TOTAL_ROW_LIMIT_EXCEEDED"
    | "DUPLICATE_LINE_ITEM"
    | "RECONCILIATION_FAILED"
    | "REPOSITORY_REJECTED";
  public readonly object: Readonly<FinopsManifestObject> | null;
  public readonly rejectedRows: readonly FinopsRejectedSourceRowEvidence[];
  public readonly reconciliationFailures: readonly FinopsReconciliationFailure[];

  public constructor(
    code: FinopsS3IngestionError["code"],
    details: {
      readonly object?: Readonly<FinopsManifestObject> | null;
      readonly rejectedRows?: readonly FinopsRejectedSourceRowEvidence[];
      readonly reconciliationFailures?: readonly FinopsReconciliationFailure[];
    } = {},
  ) {
    super("FinOps S3 ingestion rejected");
    this.name = "FinopsS3IngestionError";
    this.code = code;
    this.object = details.object ?? null;
    this.rejectedRows = details.rejectedRows ?? [];
    this.reconciliationFailures = details.reconciliationFailures ?? [];
  }
}

function ingestionError(
  code: FinopsS3IngestionError["code"],
  details: ConstructorParameters<typeof FinopsS3IngestionError>[1] = {},
): never {
  throw new FinopsS3IngestionError(code, details);
}

function positiveSafeLimit(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SAFE_LIMIT;
}

function normalizedLimits(
  supplied: Readonly<Partial<FinopsS3IngestionLimits>> | undefined,
): FinopsS3IngestionLimits {
  if (supplied !== undefined && (
    supplied === null
    || typeof supplied !== "object"
    || Array.isArray(supplied)
  )) ingestionError("INVALID_INPUT");
  const limits: FinopsS3IngestionLimits = {
    ...DEFAULT_FINOPS_S3_INGESTION_LIMITS,
    ...supplied,
  };
  if (
    !positiveSafeLimit(limits.maxObjectCompressedBytes)
    || !positiveSafeLimit(limits.maxTotalCompressedBytes)
    || !positiveSafeLimit(limits.maxObjectUncompressedBytes)
    || !positiveSafeLimit(limits.maxTotalUncompressedBytes)
    || !positiveSafeLimit(limits.maxRowsPerObject)
    || limits.maxRowsPerObject > CUR_MAX_ROWS
    || !positiveSafeLimit(limits.maxTotalRows)
    || !positiveSafeLimit(limits.stageChunkRows)
    || limits.stageChunkRows > MAX_REPOSITORY_STAGE_CHUNK
  ) ingestionError("INVALID_INPUT");
  return limits;
}

function billingScope(manifest: ValidatedFinopsManifest): FinopsBillingScope {
  return {
    orgId: manifest.scope.organizationId,
    customerId: manifest.scope.customerId,
    connectionId: manifest.scope.connectionId,
  };
}

function exactHeader(text: string): readonly string[] | null {
  let inQuotes = false;
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && (character === "\n" || character === "\r")) {
      end = index;
      break;
    }
  }
  if (inQuotes) return null;
  const rows = parseCsv(text.slice(0, end), 1);
  const header = rows[0];
  return header === undefined ? null : header.map((column) => column.trim());
}

function sameColumns(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && actual.every((column, index) => column === expected[index]);
}

async function focusLineIdentity(
  objectKey: string,
  sourceLineId: string,
  acceptedOrdinal: number,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${objectKey}\0${acceptedOrdinal}\0${sourceLineId}`,
    ),
  );
  return `focus_${[...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

function expectedSource(manifest: ValidatedFinopsManifest): {
  readonly format: CanonicalCurLine["sourceFormat"];
  readonly version: CanonicalCurLine["sourceVersion"];
} | null {
  switch (manifest.table) {
    case "cur-2.0":
      return { format: "aws-cur", version: "2.0" };
    case "focus-1.0-aws":
      return { format: "focus", version: "1.0" };
    case "focus-1.2-aws":
      return { format: "focus", version: "1.2" };
    default:
      return null;
  }
}

function repositoryFailure(error: unknown): FinopsS3IngestionError {
  return error instanceof FinopsS3IngestionError
    ? error
    : new FinopsS3IngestionError("REPOSITORY_REJECTED");
}

function compressedLimitFailure(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "COMPRESSED_LIMIT_EXCEEDED";
}

async function failQuietly(
  repository: FinopsS3IngestionRepository,
  scope: FinopsBillingScope,
  generation: FinopsBillingGeneration,
  code: FinopsS3IngestionError["code"],
): Promise<void> {
  try {
    await repository.failGeneration(scope, generation, code);
  } catch {
    // Preserve the original ingestion failure. The repository may already have
    // marked a reconciliation/commit failure or rejected a no-longer-live scope.
  }
}

/**
 * Read, parse, stage, reconcile, and atomically promote one validated manifest.
 */
export async function ingestFinopsS3DataExport(
  request: FinopsS3IngestionRequest,
  dependencies: FinopsS3IngestionDependencies,
): Promise<FinopsS3IngestionResult> {
  if (
    request === null
    || typeof request !== "object"
    || request.manifest === null
    || typeof request.manifest !== "object"
    || request.evidence === null
    || typeof request.evidence !== "object"
    || dependencies === null
    || typeof dependencies !== "object"
    || dependencies.repository === null
    || typeof dependencies.repository !== "object"
    || typeof dependencies.readObject !== "function"
    || typeof dependencies.decompressGzip !== "function"
  ) ingestionError("INVALID_INPUT");
  const limits = normalizedLimits(request.limits);
  const manifest = request.manifest;
  const scope = billingScope(manifest);

  let began: BeginFinopsBillingGenerationResult;
  try {
    began = await dependencies.repository.beginValidatedManifest(manifest);
  } catch (error) {
    throw repositoryFailure(error);
  }
  if (began.action === "skip") {
    return {
      action: "skipped",
      reason: "duplicate_manifest",
      generation: began.generation,
      objects: [],
      rejectedRows: [],
      reconciliation: null,
    };
  }

  const generation = began.generation;
  const rejectedRows: FinopsRejectedSourceRowEvidence[] = [];
  try {
    const source = expectedSource(manifest);
    if (source === null || request.evidence.manifestSha256 !== manifest.manifestSha256) {
      ingestionError("RECONCILIATION_FAILED", {
        reconciliationFailures: [{
          code: "INVALID_SOURCE_EVIDENCE",
          field: "evidence.manifestSha256",
        }],
      });
    }
    if (
      manifest.dataFiles.some((object) => (
        object.bucket !== manifest.manifest.bucket
        || !object.key.endsWith(".csv.gz")
      ))
    ) ingestionError("UNSUPPORTED_OBJECT");

    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;
    let totalSourceRows = 0;
    const scopedRows: ScopedCanonicalBillingRow[] = [];
    const seenLineItems = new Set<string>();
    const objects: FinopsIngestedObjectSummary[] = [];

    for (const listedObject of manifest.dataFiles) {
      // Copy the address before crossing the injected boundary. The only
      // possible reader requests originate from this validated manifest list.
      const object = { bucket: listedObject.bucket, key: listedObject.key };
      const remainingTotalCompressedBytes =
        limits.maxTotalCompressedBytes - totalCompressedBytes;
      if (remainingTotalCompressedBytes <= 0) {
        ingestionError("TOTAL_COMPRESSED_LIMIT_EXCEEDED", {
          object,
          rejectedRows,
        });
      }
      const maximumCompressedBytes = Math.min(
        limits.maxObjectCompressedBytes,
        remainingTotalCompressedBytes,
      );
      let compressed: Uint8Array;
      try {
        compressed = await dependencies.readObject({
          scope: { ...scope },
          bucket: object.bucket,
          key: object.key,
          maximumCompressedBytes,
        });
      } catch (error) {
        if (compressedLimitFailure(error)) {
          ingestionError(
            remainingTotalCompressedBytes < limits.maxObjectCompressedBytes
              ? "TOTAL_COMPRESSED_LIMIT_EXCEEDED"
              : "OBJECT_COMPRESSED_LIMIT_EXCEEDED",
            { object, rejectedRows },
          );
        }
        ingestionError("OBJECT_READ_FAILED", { object, rejectedRows });
      }
      if (!(compressed instanceof Uint8Array)) {
        ingestionError("OBJECT_READ_FAILED", { object, rejectedRows });
      }
      if (
        compressed.byteLength < 2
        || compressed[0] !== GZIP_MAGIC_FIRST
        || compressed[1] !== GZIP_MAGIC_SECOND
      ) ingestionError("INVALID_COMPRESSED_OBJECT", { object, rejectedRows });
      if (compressed.byteLength > limits.maxObjectCompressedBytes) {
        ingestionError("OBJECT_COMPRESSED_LIMIT_EXCEEDED", { object, rejectedRows });
      }
      totalCompressedBytes += compressed.byteLength;
      if (totalCompressedBytes > limits.maxTotalCompressedBytes) {
        ingestionError("TOTAL_COMPRESSED_LIMIT_EXCEEDED", { object, rejectedRows });
      }

      const remainingUncompressed = limits.maxTotalUncompressedBytes
        - totalUncompressedBytes;
      const maximumOutputBytes = Math.min(
        limits.maxObjectUncompressedBytes,
        remainingUncompressed,
      );
      if (maximumOutputBytes <= 0) {
        ingestionError("TOTAL_UNCOMPRESSED_LIMIT_EXCEEDED", { object, rejectedRows });
      }
      let uncompressed: Uint8Array;
      try {
        uncompressed = await dependencies.decompressGzip({
          scope: { ...scope },
          object,
          compressed,
          maximumOutputBytes,
        });
      } catch {
        ingestionError("DECOMPRESSION_FAILED", { object, rejectedRows });
      }
      if (!(uncompressed instanceof Uint8Array)) {
        ingestionError("DECOMPRESSION_FAILED", { object, rejectedRows });
      }
      if (uncompressed.byteLength > limits.maxObjectUncompressedBytes) {
        ingestionError("OBJECT_UNCOMPRESSED_LIMIT_EXCEEDED", { object, rejectedRows });
      }
      totalUncompressedBytes += uncompressed.byteLength;
      if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        ingestionError("TOTAL_UNCOMPRESSED_LIMIT_EXCEEDED", { object, rejectedRows });
      }

      let csv: string;
      try {
        csv = new TextDecoder("utf-8", { fatal: true }).decode(uncompressed);
      } catch {
        ingestionError("INVALID_UTF8", { object, rejectedRows });
      }
      const header = exactHeader(csv);
      if (header === null || !sameColumns(header, manifest.columns)) {
        ingestionError("SCHEMA_DRIFT", { object, rejectedRows });
      }
      const parsed = parseCurCsv(csv);
      if ("error" in parsed) {
        ingestionError(
          parsed.error.includes("exceeds the maximum")
            ? "OBJECT_ROW_LIMIT_EXCEEDED"
            : "PARSE_FAILED",
          { object, rejectedRows },
        );
      }
      if (
        parsed.sourceFormat !== source.format
        || parsed.sourceVersion !== source.version
      ) ingestionError("SCHEMA_DRIFT", { object, rejectedRows });
      if (parsed.totalRows > limits.maxRowsPerObject) {
        ingestionError("OBJECT_ROW_LIMIT_EXCEEDED", { object, rejectedRows });
      }
      totalSourceRows += parsed.totalRows;
      if (totalSourceRows > limits.maxTotalRows) {
        ingestionError("TOTAL_ROW_LIMIT_EXCEEDED", { object, rejectedRows });
      }
      for (const rejected of parsed.rejected) {
        rejectedRows.push({
          bucket: object.bucket,
          key: object.key,
          rowNumber: rejected.rowNumber,
          reason: rejected.reason,
        });
      }
      // FOCUS has no guaranteed line-item identifier. ChargeDescription and
      // ResourceId are descriptive and can repeat, while row ordinals restart
      // in every object. Bind a deterministic surrogate to the manifest-owned
      // object key plus accepted-row ordinal before enforcing generation-wide
      // uniqueness. The source fields remain available on the canonical row.
      const canonicalLines = source.format === "focus"
        ? await Promise.all(parsed.lines.map(async (line, index) => ({
            ...line,
            lineItemId: await focusLineIdentity(object.key, line.lineItemId, index),
          })))
        : parsed.lines;
      for (const line of canonicalLines) {
        if (seenLineItems.has(line.lineItemId)) {
          ingestionError("DUPLICATE_LINE_ITEM", { object, rejectedRows });
        }
        seenLineItems.add(line.lineItemId);
        scopedRows.push({
          organizationId: manifest.scope.organizationId,
          customerId: manifest.scope.customerId,
          connectionId: manifest.scope.connectionId,
          exportName: generation.exportName,
          billingPeriod: generation.billingPeriod,
          generationId: generation.generationId,
          line,
        });
      }
      for (let offset = 0; offset < canonicalLines.length; offset += limits.stageChunkRows) {
        await dependencies.repository.stageCanonicalLines(
          scope,
          generation,
          canonicalLines.slice(offset, offset + limits.stageChunkRows),
        );
      }
      objects.push({
        bucket: object.bucket,
        key: object.key,
        compressedBytes: compressed.byteLength,
        uncompressedBytes: uncompressed.byteLength,
        sourceRows: parsed.totalRows,
        acceptedRows: canonicalLines.length,
        rejectedRows: parsed.rejected.length,
      });
    }

    const reconciliation = reconcileCanonicalBillingGeneration({
      scope: {
        organizationId: manifest.scope.organizationId,
        customerId: manifest.scope.customerId,
        connectionId: manifest.scope.connectionId,
        exportName: generation.exportName,
        billingPeriod: generation.billingPeriod,
        generationId: generation.generationId,
      },
      evidence: request.evidence,
      rows: scopedRows,
    });
    if (!reconciliation.ok) {
      ingestionError("RECONCILIATION_FAILED", {
        rejectedRows,
        reconciliationFailures: reconciliation.failures,
      });
    }
    const currencyTotals: Record<string, string> = {};
    for (const currency of reconciliation.actual.currencies) {
      currencyTotals[currency.currency] = currency.totalMicros;
    }
    const committed = await dependencies.repository.commitGeneration(
      scope,
      generation,
      {
        acceptedRows: reconciliation.actual.rowCount,
        rejectedRows: rejectedRows.length,
        currencyTotals,
      },
    );
    return {
      action: "committed",
      generation,
      objects,
      compressedBytes: totalCompressedBytes,
      uncompressedBytes: totalUncompressedBytes,
      sourceRows: totalSourceRows,
      acceptedRows: reconciliation.actual.rowCount,
      rejectedRowCount: rejectedRows.length,
      rejectedRows,
      reconciliation,
      committed,
    };
  } catch (error) {
    const normalized = repositoryFailure(error);
    await failQuietly(
      dependencies.repository,
      scope,
      generation,
      normalized.code,
    );
    throw normalized;
  }
}
