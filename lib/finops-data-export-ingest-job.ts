/**
 * Durable tenant-scoped AWS Data Exports ingestion job.
 *
 * AWS access is delegated to the authenticated hosted broker's bounded range
 * protocol. This worker receives no AWS credentials. It validates the fetched
 * manifest, parses/reconciles canonical rows, and atomically activates the
 * generation through FinopsBillingEngineRepository.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import {
  FINOPS_MANIFEST_MAX_BYTES,
  validateFinopsDataExportManifest,
  type ValidatedFinopsManifest,
} from "./finops-data-export.ts";
import {
  createFinopsGzipDecompressor,
} from "./finops-s3-runtime.ts";
import {
  ingestFinopsS3DataExport,
  type FinopsS3IngestionRepository,
  type FinopsS3ObjectReadRequest,
} from "./finops-s3-ingestion.ts";
import type {
  FinopsExpectedCurrencyEvidence,
  FinopsReconciliationEvidence,
} from "./finops-reconciliation.ts";
import type {
  FinopsBillingScope,
} from "../db/finops-billing-engine-repository.ts";
import type { PilotConnection } from "./pilot-types.ts";
import type { FinopsBrokerObject } from "./finops-broker-object-reader.ts";

export const FINOPS_DATA_EXPORT_INGEST_JOB_KIND =
  "finops.data-export.ingest";
export const FOUNDATIONAL_FINOPS_PERMISSION_PACK =
  "standard-2026-08.1";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BUCKET =
  /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/u;
const EXPORT_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;

export interface FinopsDataExportEvidencePayload {
  readonly sourceEvidenceId: string;
  readonly rowCount: number;
  readonly currencies: readonly FinopsExpectedCurrencyEvidence[];
}

export interface FinopsDataExportIngestJobPayload {
  readonly schema: "sutra.finops-data-export-ingest.v1";
  readonly connectionId: string;
  readonly contractId: "foundational-cur2-export-v1";
  readonly exportName: string;
  readonly region: string;
  readonly bucket: string;
  /** Exact add-on-owned root, including export name and trailing slash. */
  readonly prefix: string;
  readonly manifestKey: string;
  readonly evidence: FinopsDataExportEvidencePayload;
}

export interface FinopsDataExportIngestJobDependencies {
  readonly getConnection: (
    orgId: string,
    connectionId: string,
  ) => Promise<PilotConnection | null>;
  readonly repository: FinopsS3IngestionRepository;
  readonly readObject: (
    boundary: {
      readonly scope: Readonly<FinopsBillingScope>;
      readonly jobId: string;
      readonly contractId: "foundational-cur2-export-v1";
      readonly exportName: string;
      readonly region: string;
      readonly bucket: string;
      readonly prefix: string;
    },
    request: FinopsS3ObjectReadRequest,
  ) => Promise<FinopsBrokerObject>;
  readonly now?: () => number;
}

export interface FinopsDataExportJobEnqueuePort {
  enqueue(input: {
    readonly orgId: string;
    readonly customerId: string | null;
    readonly connectionId?: string | null;
    readonly kind: string;
    readonly payload: unknown;
    readonly maxAttempts?: number;
  }): Promise<{ readonly id: string }>;
}

export class FinopsDataExportIngestJobError extends Error {
  public readonly code:
    | "INVALID_JOB"
    | "INVALID_SCOPE"
    | "CONNECTION_NOT_RUNNABLE"
    | "MANIFEST_REJECTED"
    | "SOURCE_EVIDENCE_REJECTED";

  public constructor(code: FinopsDataExportIngestJobError["code"]) {
    super("FinOps Data Export ingestion job rejected");
    this.name = "FinopsDataExportIngestJobError";
    this.code = code;
  }
}

function reject(code: FinopsDataExportIngestJobError["code"]): never {
  throw new FinopsDataExportIngestJobError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && actual.every((key) => expected.includes(key));
}

function validKey(value: unknown, trailingSlash = false): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 1_024
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || value.includes("\0")
    || (trailingSlash && !value.endsWith("/"))
  ) return false;
  const parts = value.split("/");
  if (trailingSlash) parts.pop();
  return parts.length > 0
    && !parts.some((part) => part.length === 0 || part === "." || part === "..");
}

function validEvidence(value: unknown): value is FinopsDataExportEvidencePayload {
  if (
    !isRecord(value)
    || !exactKeys(value, ["sourceEvidenceId", "rowCount", "currencies"])
    || typeof value.sourceEvidenceId !== "string"
    || value.sourceEvidenceId.length === 0
    || value.sourceEvidenceId.length > 1_024
    || value.sourceEvidenceId.includes("\0")
    || !Number.isSafeInteger(value.rowCount)
    || (value.rowCount as number) < 0
    || !Array.isArray(value.currencies)
    || value.currencies.length > 128
    || (value.currencies.length === 0 && value.rowCount !== 0)
  ) return false;
  let summedRows = 0;
  const seen = new Set<string>();
  for (const entry of value.currencies) {
    if (
      !isRecord(entry)
      || !exactKeys(entry, ["currency", "rowCount", "totalMicros"])
      || typeof entry.currency !== "string"
      || !CURRENCY.test(entry.currency)
      || seen.has(entry.currency)
      || !Number.isSafeInteger(entry.rowCount)
      || (entry.rowCount as number) < 0
      || typeof entry.totalMicros !== "string"
      || !INTEGER_MICROS.test(entry.totalMicros)
    ) return false;
    seen.add(entry.currency);
    summedRows += entry.rowCount as number;
    if (!Number.isSafeInteger(summedRows)) return false;
  }
  return summedRows === value.rowCount;
}

function parsePayload(value: unknown): FinopsDataExportIngestJobPayload {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schema",
      "connectionId",
      "contractId",
      "exportName",
      "region",
      "bucket",
      "prefix",
      "manifestKey",
      "evidence",
    ])
    || value.schema !== "sutra.finops-data-export-ingest.v1"
    || typeof value.connectionId !== "string"
    || !CONNECTION_ID.test(value.connectionId)
    || value.contractId !== "foundational-cur2-export-v1"
    || typeof value.exportName !== "string"
    || !EXPORT_NAME.test(value.exportName)
    || typeof value.region !== "string"
    || !REGION.test(value.region)
    || typeof value.bucket !== "string"
    || !BUCKET.test(value.bucket)
    || !validKey(value.prefix, true)
    || !value.prefix.endsWith(`${value.exportName}/`)
    || !validKey(value.manifestKey)
    || !value.manifestKey.startsWith(value.prefix)
    || value.manifestKey.length === value.prefix.length
    || !validEvidence(value.evidence)
  ) reject("INVALID_JOB");
  return value as unknown as FinopsDataExportIngestJobPayload;
}

function regionMatchesPartition(
  region: string,
  partition: PilotConnection["partition"],
): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function evidenceFor(
  manifest: ValidatedFinopsManifest,
  input: FinopsDataExportEvidencePayload,
): FinopsReconciliationEvidence {
  return {
    scope: {
      organizationId: manifest.scope.organizationId,
      customerId: manifest.scope.customerId,
      connectionId: manifest.scope.connectionId,
      exportName: manifest.exportName,
      billingPeriod: manifest.billingPeriod,
      generationId: `fbg_${manifest.manifestSha256}`,
    },
    sourceEvidenceId: input.sourceEvidenceId,
    manifestSha256: manifest.manifestSha256,
    rowCount: input.rowCount,
    currencies: input.currencies,
  };
}

function scopeFor(
  job: RunnableJob,
): FinopsBillingScope {
  if (job.customerId === null || job.connectionId === null) {
    reject("INVALID_SCOPE");
  }
  if (
    !IDENTIFIER.test(job.orgId)
    || !IDENTIFIER.test(job.customerId)
    || !CONNECTION_ID.test(job.connectionId)
  ) reject("INVALID_SCOPE");
  return {
    orgId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
}

export async function enqueueFinopsDataExportIngestJob(
  port: FinopsDataExportJobEnqueuePort,
  input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly payload: FinopsDataExportIngestJobPayload;
  },
): Promise<{ readonly jobId: string }> {
  if (
    !IDENTIFIER.test(input.orgId)
    || !IDENTIFIER.test(input.customerId)
  ) reject("INVALID_SCOPE");
  const payload = parsePayload(input.payload);
  const stored = await port.enqueue({
    orgId: input.orgId,
    customerId: input.customerId,
    connectionId: payload.connectionId,
    kind: FINOPS_DATA_EXPORT_INGEST_JOB_KIND,
    payload,
    maxAttempts: 6,
  });
  return { jobId: stored.id };
}

export async function runFinopsDataExportIngestJob(
  job: RunnableJob,
  dependencies: FinopsDataExportIngestJobDependencies,
): Promise<void> {
  if (job.kind !== FINOPS_DATA_EXPORT_INGEST_JOB_KIND) reject("INVALID_JOB");
  const scope = scopeFor(job);
  const payload = parsePayload(job.payload);
  if (payload.connectionId !== scope.connectionId) reject("INVALID_SCOPE");
  const connection = await dependencies.getConnection(
    scope.orgId,
    scope.connectionId,
  );
  if (
    connection === null
    || connection.id !== scope.connectionId
    || connection.customerId !== scope.customerId
    || connection.sourceKind !== "aws_trust_role"
    || connection.status !== "active"
    || connection.permissionPackVersion !== FOUNDATIONAL_FINOPS_PERMISSION_PACK
    || !regionMatchesPartition(payload.region, connection.partition)
  ) reject("CONNECTION_NOT_RUNNABLE");

  const boundary = {
    scope,
    jobId: job.id,
    contractId: payload.contractId,
    exportName: payload.exportName,
    region: payload.region,
    bucket: payload.bucket,
    prefix: payload.prefix,
  } as const;
  const manifestObject = await dependencies.readObject(boundary, {
    scope,
    bucket: payload.bucket,
    key: payload.manifestKey,
    maximumCompressedBytes: FINOPS_MANIFEST_MAX_BYTES,
  });
  let manifestBody: string;
  try {
    manifestBody = new TextDecoder("utf-8", { fatal: true })
      .decode(manifestObject.bytes);
  } catch {
    return reject("MANIFEST_REJECTED");
  }
  const validation = await validateFinopsDataExportManifest({
    scope: {
      organizationId: scope.orgId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
    },
    bucket: payload.bucket,
    manifestKey: payload.manifestKey,
    eTag: manifestObject.eTag,
    versionId: manifestObject.versionId,
    observedAtIso: new Date((dependencies.now ?? Date.now)()).toISOString(),
    body: manifestBody,
  });
  if (!validation.ok) reject("MANIFEST_REJECTED");
  const manifest = validation.manifest;
  if (
    manifest.exportName !== payload.exportName
    || manifest.table !== "cur-2.0"
    || manifest.manifest.bucket !== payload.bucket
    || manifest.manifest.key !== payload.manifestKey
    || manifest.dataFiles.some((file) => (
      file.bucket !== payload.bucket
      || file.key === payload.prefix
      || !file.key.startsWith(payload.prefix)
    ))
  ) reject("MANIFEST_REJECTED");

  const evidence = evidenceFor(manifest, payload.evidence);
  if (evidence.manifestSha256 !== manifest.manifestSha256) {
    reject("SOURCE_EVIDENCE_REJECTED");
  }
  const decompressor = createFinopsGzipDecompressor({
    scope,
    bucket: payload.bucket,
    prefix: payload.prefix,
  });
  await ingestFinopsS3DataExport(
    { manifest, evidence },
    {
      repository: dependencies.repository,
      readObject: async (request) =>
        (await dependencies.readObject(boundary, request)).bytes,
      decompressGzip: decompressor,
    },
  );
}
