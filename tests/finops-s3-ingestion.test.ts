import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BeginFinopsBillingGenerationResult,
  CommitFinopsBillingGenerationResult,
  FinopsBillingGeneration,
  FinopsBillingReconciliation,
  FinopsBillingScope,
} from "../db/finops-billing-engine-repository.ts";
import type { CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  DEFAULT_FINOPS_S3_INGESTION_LIMITS,
  FinopsS3IngestionError,
  ingestFinopsS3DataExport,
  type FinopsGzipDecompressor,
  type FinopsS3IngestionDependencies,
  type FinopsS3IngestionLimits,
  type FinopsS3IngestionRepository,
  type FinopsS3ObjectReader,
} from "../lib/finops-s3-ingestion.ts";
import {
  validateFinopsDataExportManifest,
  type FinopsExportScope,
  type ValidatedFinopsManifest,
} from "../lib/finops-data-export.ts";
import type {
  FinopsExpectedCurrencyEvidence,
  FinopsReconciliationEvidence,
} from "../lib/finops-reconciliation.ts";

const HEADER = [
  "line_item_id",
  "line_item_usage_account_id",
  "product_servicecode",
  "line_item_line_item_type",
  "line_item_usage_start_date",
  "line_item_unblended_cost",
  "line_item_currency_code",
] as const;
const SCOPE_A = {
  organizationId: "org_s3_a",
  customerId: "customer_s3_a",
  connectionId: `conn_${"a".repeat(32)}`,
} as const;
const SCOPE_B = {
  organizationId: "org_s3_b",
  customerId: "customer_s3_b",
  connectionId: `conn_${"b".repeat(32)}`,
} as const;
const FILE_ONE = "exports/aws-cur/data/BILLING_PERIOD=2026-07/part-00001.csv.gz";
const FILE_TWO = "exports/aws-cur/data/BILLING_PERIOD=2026-07/part-00002.csv.gz";

function csv(rows: readonly string[]): string {
  return [HEADER.join(","), ...rows].join("\n");
}

async function manifest(
  scope: FinopsExportScope = SCOPE_A,
  keys: readonly string[] = [FILE_ONE],
): Promise<ValidatedFinopsManifest> {
  const result = await validateFinopsDataExportManifest({
    scope,
    bucket: "sutra-customer-billing",
    manifestKey: "exports/aws-cur/metadata/BILLING_PERIOD=2026-07/aws-cur-Manifest.json",
    eTag: '"s3-ingestion-etag"',
    versionId: "s3-ingestion-version",
    observedAtIso: "2026-07-31T12:00:00Z",
    body: {
      metadata: {
        exportName: "aws-cur",
        exportTableName: "COST_AND_USAGE_REPORT",
      },
      columns: HEADER,
      dataFiles: keys,
    },
  });
  if (!result.ok) throw new Error(result.rejection.message);
  return result.manifest;
}

function generationFor(value: ValidatedFinopsManifest): FinopsBillingGeneration {
  return {
    exportName: value.exportName,
    billingPeriod: value.billingPeriod,
    generationId: `fbg_${value.manifestSha256}`,
  };
}

function evidence(
  value: ValidatedFinopsManifest,
  currencies: readonly FinopsExpectedCurrencyEvidence[],
  overrides: Partial<FinopsReconciliationEvidence> = {},
): FinopsReconciliationEvidence {
  const generation = generationFor(value);
  return {
    scope: {
      organizationId: value.scope.organizationId,
      customerId: value.scope.customerId,
      connectionId: value.scope.connectionId,
      exportName: generation.exportName,
      billingPeriod: generation.billingPeriod,
      generationId: generation.generationId,
    },
    sourceEvidenceId: `s3://${value.manifest.bucket}/${value.manifest.key}`,
    manifestSha256: value.manifestSha256,
    rowCount: currencies.reduce((sum, entry) => sum + entry.rowCount, 0),
    currencies,
    ...overrides,
  };
}

class MemoryBillingRepository implements FinopsS3IngestionRepository {
  public readonly expectedScope: typeof SCOPE_A;
  public readonly stageCalls: CanonicalCurLine[][] = [];
  public readonly failCodes: string[] = [];
  public readonly commitInputs: FinopsBillingReconciliation[] = [];
  public activeLineIds: string[] = ["previous-active"];
  private staged = new Map<string, CanonicalCurLine>();
  private stagingManifestSha256: string | null = null;
  private activeManifestSha256: string | null = null;

  public constructor(expectedScope: typeof SCOPE_A = SCOPE_A) {
    this.expectedScope = expectedScope;
  }

  public async beginValidatedManifest(
    value: ValidatedFinopsManifest,
  ): Promise<BeginFinopsBillingGenerationResult> {
    if (
      value.scope.organizationId !== this.expectedScope.organizationId
      || value.scope.customerId !== this.expectedScope.customerId
      || value.scope.connectionId !== this.expectedScope.connectionId
    ) throw new Error("scope rejected");
    const generation = generationFor(value);
    if (this.activeManifestSha256 === value.manifestSha256) {
      return { action: "skip", reason: "duplicate_manifest", generation };
    }
    if (this.stagingManifestSha256 === value.manifestSha256) {
      return { action: "stage", reason: "resume_delivery", generation };
    }
    this.staged.clear();
    this.stagingManifestSha256 = value.manifestSha256;
    return {
      action: "stage",
      reason: this.activeManifestSha256 === null ? "first_delivery" : "corrected_delivery",
      generation,
    };
  }

  public async stageCanonicalLines(
    scope: FinopsBillingScope,
    _generation: FinopsBillingGeneration,
    lines: readonly CanonicalCurLine[],
  ): Promise<void> {
    if (
      scope.orgId !== this.expectedScope.organizationId
      || scope.customerId !== this.expectedScope.customerId
      || scope.connectionId !== this.expectedScope.connectionId
      || this.stagingManifestSha256 === null
    ) throw new Error("generation rejected");
    this.stageCalls.push([...lines]);
    for (const line of lines) {
      const current = this.staged.get(line.lineItemId);
      if (current !== undefined && JSON.stringify(current) !== JSON.stringify(line)) {
        throw new Error("line conflict");
      }
      this.staged.set(line.lineItemId, line);
    }
  }

  public async commitGeneration(
    _scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    reconciliation: FinopsBillingReconciliation,
  ): Promise<CommitFinopsBillingGenerationResult> {
    if (reconciliation.acceptedRows !== this.staged.size) {
      throw new Error("row count mismatch");
    }
    this.commitInputs.push(reconciliation);
    this.activeLineIds = [...this.staged.keys()].sort();
    this.activeManifestSha256 = this.stagingManifestSha256;
    this.stagingManifestSha256 = null;
    return {
      generation,
      acceptedRows: reconciliation.acceptedRows,
      rejectedRows: reconciliation.rejectedRows,
      currencyTotals: reconciliation.currencyTotals,
      alreadyCommitted: false,
      committedAtIso: "2026-07-31T12:05:00.000Z",
    };
  }

  public async failGeneration(
    _scope: FinopsBillingScope,
    _generation: FinopsBillingGeneration,
    errorCode: string,
  ): Promise<void> {
    this.failCodes.push(errorCode);
    this.staged.clear();
    this.stagingManifestSha256 = null;
  }
}

function gzipBytes(size = 3): Uint8Array {
  const bytes = new Uint8Array(Math.max(2, size));
  bytes[0] = 0x1f;
  bytes[1] = 0x8b;
  return bytes;
}

function offlineDependencies(
  repository: MemoryBillingRepository,
  contents: Readonly<Record<string, string>>,
  options: {
    readonly failReadKey?: string;
    readonly compressedSize?: number;
    readonly decompressedOverride?: (key: string, maximumOutputBytes: number) => Uint8Array;
  } = {},
): {
  readonly dependencies: FinopsS3IngestionDependencies;
  readonly reads: Array<{
    readonly scope: Readonly<FinopsBillingScope>;
    readonly bucket: string;
    readonly key: string;
    readonly maximumCompressedBytes: number;
  }>;
  readonly decompressions: Array<{ readonly key: string; readonly maximumOutputBytes: number }>;
} {
  const reads: Array<{
    scope: Readonly<FinopsBillingScope>;
    bucket: string;
    key: string;
    maximumCompressedBytes: number;
  }> = [];
  const decompressions: Array<{ key: string; maximumOutputBytes: number }> = [];
  const reader: FinopsS3ObjectReader = async (request) => {
    reads.push(request);
    if (request.key === options.failReadKey) throw new Error("offline missing object");
    if (!(request.key in contents)) throw new Error("unlisted test object");
    return gzipBytes(options.compressedSize);
  };
  const decompressor: FinopsGzipDecompressor = async (request) => {
    decompressions.push({
      key: request.object.key,
      maximumOutputBytes: request.maximumOutputBytes,
    });
    return options.decompressedOverride?.(
      request.object.key,
      request.maximumOutputBytes,
    ) ?? new TextEncoder().encode(contents[request.object.key] ?? "");
  };
  return {
    dependencies: {
      repository,
      readObject: reader,
      decompressGzip: decompressor,
    },
    reads,
    decompressions,
  };
}

function isIngestionError(code: FinopsS3IngestionError["code"]) {
  return (error: unknown): boolean => (
    error instanceof FinopsS3IngestionError && error.code === code
  );
}

describe("ingestFinopsS3DataExport", () => {
  it("reads only manifest objects, stages bounded chunks, discloses rejects, and retries idempotently", async () => {
    const value = await manifest(SCOPE_A, [FILE_ONE, FILE_TWO]);
    const contents = {
      [FILE_ONE]: csv([
        "valid-usd,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
        "rejected,111122223333,AmazonEC2,Usage,2026-07-01T01:00:00Z,not-money,USD",
      ]),
      [FILE_TWO]: csv([
        "valid-eur,111122223333,AmazonS3,Usage,2026-07-01T02:00:00Z,2.00,EUR",
      ]),
    };
    const repository = new MemoryBillingRepository();
    const offline = offlineDependencies(repository, contents);
    const request = {
      manifest: value,
      evidence: evidence(value, [
        { currency: "EUR", rowCount: 1, totalMicros: "2000000" },
        { currency: "USD", rowCount: 1, totalMicros: "1000000" },
      ]),
      limits: { stageChunkRows: 1 },
    };
    const result = await ingestFinopsS3DataExport(request, offline.dependencies);
    assert.equal(result.action, "committed");
    if (result.action !== "committed") return;
    assert.deepEqual(
      offline.reads.map(({ scope, bucket, key }) => ({ scope, bucket, key })),
      value.dataFiles.map(({ bucket, key }) => ({
        scope: {
          orgId: SCOPE_A.organizationId,
          customerId: SCOPE_A.customerId,
          connectionId: SCOPE_A.connectionId,
        },
        bucket,
        key,
      })),
      "the reader receives only exact validated data-file addresses",
    );
    assert.deepEqual(
      offline.reads.map(({ maximumCompressedBytes }) =>
        maximumCompressedBytes),
      [
        DEFAULT_FINOPS_S3_INGESTION_LIMITS.maxObjectCompressedBytes,
        DEFAULT_FINOPS_S3_INGESTION_LIMITS.maxObjectCompressedBytes,
      ],
      "each read receives the exact remaining compressed-byte ceiling",
    );
    assert.equal(repository.stageCalls.length, 2);
    assert.equal(repository.stageCalls.every((chunk) => chunk.length === 1), true);
    assert.deepEqual(repository.activeLineIds, ["valid-eur", "valid-usd"]);
    assert.equal(result.sourceRows, 3);
    assert.equal(result.acceptedRows, 2);
    assert.equal(result.rejectedRowCount, 1);
    assert.deepEqual(result.rejectedRows, [{
      bucket: value.manifest.bucket,
      key: FILE_ONE,
      rowNumber: 2,
      reason: "amount 'not-money' is not a decimal number",
    }]);
    assert.deepEqual(repository.commitInputs[0], {
      acceptedRows: 2,
      rejectedRows: 1,
      currencyTotals: { EUR: "2000000", USD: "1000000" },
    });

    const readsBeforeRetry = offline.reads.length;
    const retry = await ingestFinopsS3DataExport(request, offline.dependencies);
    assert.equal(retry.action, "skipped");
    assert.equal(offline.reads.length, readsBeforeRetry, "committed content is not fetched again");
  });

  it("fails the generation on a partial object read and preserves the previous active view", async () => {
    const value = await manifest(SCOPE_A, [FILE_ONE, FILE_TWO]);
    const repository = new MemoryBillingRepository();
    const offline = offlineDependencies(repository, {
      [FILE_ONE]: csv([
        "first,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
      ]),
      [FILE_TWO]: csv([
        "second,111122223333,AmazonS3,Usage,2026-07-01T01:00:00Z,2.00,USD",
      ]),
    }, { failReadKey: FILE_TWO });
    const request = {
      manifest: value,
      evidence: evidence(value, [
        { currency: "USD", rowCount: 2, totalMicros: "3000000" },
      ]),
    };
    await assert.rejects(
      ingestFinopsS3DataExport(request, offline.dependencies),
      isIngestionError("OBJECT_READ_FAILED"),
    );
    assert.equal(repository.stageCalls.length, 1, "the completed first object was staged");
    assert.deepEqual(repository.failCodes, ["OBJECT_READ_FAILED"]);
    assert.deepEqual(repository.activeLineIds, ["previous-active"]);
    assert.equal(repository.commitInputs.length, 0);

    const recovered = offlineDependencies(repository, {
      [FILE_ONE]: csv([
        "first,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
      ]),
      [FILE_TWO]: csv([
        "second,111122223333,AmazonS3,Usage,2026-07-01T01:00:00Z,2.00,USD",
      ]),
    });
    const retry = await ingestFinopsS3DataExport(request, recovered.dependencies);
    assert.equal(retry.action, "committed", "the exact manifest can be safely retried");
    assert.deepEqual(repository.activeLineIds, ["first", "second"]);
  });

  it("blocks schema drift before staging and records a failed generation", async () => {
    const value = await manifest();
    const repository = new MemoryBillingRepository();
    const drifted = [
      [...HEADER].reverse().join(","),
      "USD,1.00,2026-07-01T00:00:00Z,Usage,AmazonEC2,111122223333,line",
    ].join("\n");
    const offline = offlineDependencies(repository, { [FILE_ONE]: drifted });
    await assert.rejects(
      ingestFinopsS3DataExport({
        manifest: value,
        evidence: evidence(value, [
          { currency: "USD", rowCount: 1, totalMicros: "1000000" },
        ]),
      }, offline.dependencies),
      isIngestionError("SCHEMA_DRIFT"),
    );
    assert.equal(repository.stageCalls.length, 0);
    assert.deepEqual(repository.failCodes, ["SCHEMA_DRIFT"]);
    assert.deepEqual(repository.activeLineIds, ["previous-active"]);
  });

  it("enforces per-object and total compressed, uncompressed, and row ceilings including bombs", async () => {
    const oneRow = csv([
      "one,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
    ]);
    const twoRows = csv([
      "one,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
      "two,111122223333,AmazonS3,Usage,2026-07-01T01:00:00Z,1.00,USD",
    ]);
    const cases: readonly {
      readonly name: string;
      readonly keys: readonly string[];
      readonly contents: Readonly<Record<string, string>>;
      readonly limits: Readonly<Partial<FinopsS3IngestionLimits>>;
      readonly compressedSize?: number;
      readonly decompressedOverride?: (key: string, maximumOutputBytes: number) => Uint8Array;
      readonly code: FinopsS3IngestionError["code"];
    }[] = [
      {
        name: "object compressed",
        keys: [FILE_ONE],
        contents: { [FILE_ONE]: oneRow },
        compressedSize: 4,
        limits: { maxObjectCompressedBytes: 3 },
        code: "OBJECT_COMPRESSED_LIMIT_EXCEEDED",
      },
      {
        name: "total compressed",
        keys: [FILE_ONE, FILE_TWO],
        contents: { [FILE_ONE]: oneRow, [FILE_TWO]: oneRow.replace("one,", "two,") },
        compressedSize: 3,
        limits: { maxTotalCompressedBytes: 5 },
        code: "TOTAL_COMPRESSED_LIMIT_EXCEEDED",
      },
      {
        name: "object uncompressed decompression bomb",
        keys: [FILE_ONE],
        contents: { [FILE_ONE]: oneRow },
        limits: { maxObjectUncompressedBytes: 64 },
        decompressedOverride: () => new Uint8Array(65),
        code: "OBJECT_UNCOMPRESSED_LIMIT_EXCEEDED",
      },
      {
        name: "total uncompressed",
        keys: [FILE_ONE, FILE_TWO],
        contents: { [FILE_ONE]: oneRow, [FILE_TWO]: oneRow.replace("one,", "two,") },
        limits: {
          maxObjectUncompressedBytes: new TextEncoder().encode(oneRow).byteLength + 1,
          maxTotalUncompressedBytes: (new TextEncoder().encode(oneRow).byteLength * 2) - 1,
        },
        code: "TOTAL_UNCOMPRESSED_LIMIT_EXCEEDED",
      },
      {
        name: "object rows",
        keys: [FILE_ONE],
        contents: { [FILE_ONE]: twoRows },
        limits: { maxRowsPerObject: 1 },
        code: "OBJECT_ROW_LIMIT_EXCEEDED",
      },
      {
        name: "total rows",
        keys: [FILE_ONE, FILE_TWO],
        contents: { [FILE_ONE]: oneRow, [FILE_TWO]: oneRow.replace("one,", "two,") },
        limits: { maxTotalRows: 1 },
        code: "TOTAL_ROW_LIMIT_EXCEEDED",
      },
    ];
    for (const entry of cases) {
      const value = await manifest(SCOPE_A, entry.keys);
      const repository = new MemoryBillingRepository();
      const offline = offlineDependencies(repository, entry.contents, {
        compressedSize: entry.compressedSize,
        decompressedOverride: entry.decompressedOverride,
      });
      await assert.rejects(
        ingestFinopsS3DataExport({
          manifest: value,
          evidence: evidence(value, [
            { currency: "USD", rowCount: 2, totalMicros: "2000000" },
          ]),
          limits: entry.limits,
        }, offline.dependencies),
        isIngestionError(entry.code),
        entry.name,
      );
      assert.deepEqual(repository.failCodes, [entry.code], entry.name);
      assert.deepEqual(repository.activeLineIds, ["previous-active"], entry.name);
      assert.equal(repository.commitInputs.length, 0, entry.name);
    }
  });

  it("reduces the object-reader ceiling by prior compressed bytes", async () => {
    const value = await manifest(SCOPE_A, [FILE_ONE, FILE_TWO]);
    const oneRow = csv([
      "one,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
    ]);
    const repository = new MemoryBillingRepository();
    const offline = offlineDependencies(repository, {
      [FILE_ONE]: oneRow,
      [FILE_TWO]: oneRow.replace("one,", "two,"),
    }, { compressedSize: 8 });
    await assert.rejects(
      ingestFinopsS3DataExport({
        manifest: value,
        evidence: evidence(value, [
          { currency: "USD", rowCount: 2, totalMicros: "2000000" },
        ]),
        limits: {
          maxObjectCompressedBytes: 10,
          maxTotalCompressedBytes: 15,
        },
      }, offline.dependencies),
      isIngestionError("TOTAL_COMPRESSED_LIMIT_EXCEEDED"),
    );
    assert.deepEqual(
      offline.reads.map(({ maximumCompressedBytes }) =>
        maximumCompressedBytes),
      [10, 7],
    );
  });

  it("rejects cross-tenant manifests before reads and cross-tenant evidence before commit", async () => {
    const foreignManifest = await manifest(SCOPE_B);
    const tenantRepository = new MemoryBillingRepository();
    const foreignOffline = offlineDependencies(tenantRepository, {
      [FILE_ONE]: csv([
        "foreign,444455556666,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
      ]),
    });
    await assert.rejects(
      ingestFinopsS3DataExport({
        manifest: foreignManifest,
        evidence: evidence(foreignManifest, [
          { currency: "USD", rowCount: 1, totalMicros: "1000000" },
        ]),
      }, foreignOffline.dependencies),
      isIngestionError("REPOSITORY_REJECTED"),
    );
    assert.equal(foreignOffline.reads.length, 0, "unauthorized manifests cannot trigger S3 reads");

    const value = await manifest();
    const evidenceRepository = new MemoryBillingRepository();
    const evidenceOffline = offlineDependencies(evidenceRepository, {
      [FILE_ONE]: csv([
        "local,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
      ]),
    });
    const crossTenantEvidence = evidence(value, [
      { currency: "USD", rowCount: 1, totalMicros: "1000000" },
    ], {
      scope: {
        ...evidence(value, []).scope,
        customerId: SCOPE_B.customerId,
      },
    });
    await assert.rejects(
      ingestFinopsS3DataExport({
        manifest: value,
        evidence: crossTenantEvidence,
      }, evidenceOffline.dependencies),
      (error: unknown) => (
        error instanceof FinopsS3IngestionError
        && error.code === "RECONCILIATION_FAILED"
        && error.reconciliationFailures.some(({ code }) => code === "EVIDENCE_SCOPE_MISMATCH")
      ),
    );
    assert.deepEqual(evidenceRepository.failCodes, ["RECONCILIATION_FAILED"]);
    assert.equal(evidenceRepository.commitInputs.length, 0);
    assert.deepEqual(evidenceRepository.activeLineIds, ["previous-active"]);
  });
});
