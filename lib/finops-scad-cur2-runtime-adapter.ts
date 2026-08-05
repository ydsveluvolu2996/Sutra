/**
 * Server-owned CUR 2.0/SCAD materialization boundary.
 *
 * The provider is deliberately transport-neutral: production may bind it to
 * the AWS SDK or the signed object broker, but callers can never supply an S3
 * address, account, export, generation, or billing period. Object and row
 * pagination is bounded and every immutable object identity is rechecked.
 */
import {
  buildScadAllocationSnapshot,
  SCAD_BOUNDS,
  type ScadCapture,
  type ScadCur2Row,
  type ScadScope,
  type ScadS3ObjectEvidence,
} from "./finops-scad-allocation.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const GENERATION = /^fbg_[a-f0-9]{64}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const EXPORT_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):bcm-data-exports:[a-z0-9-]+:\d{12}:export\/[A-Za-z0-9_./-]+$/u;
const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const COLUMN = /^[a-z][a-z0-9_]{0,127}$/u;
const TOKEN = /^[A-Za-z0-9._~+\-/=]{1,2048}$/u;
const SAFE = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const MAX_REQUESTS = 25_000;
const PAGE_SIZE = 1_000;
const RETRIES = 3;
const BOUNDARY_KEYS = ["billingPeriodEndAt", "billingPeriodStartAt", "binding", "bucket",
  "exportArn", "exportName", "firstDeliveryObservedAt", "lastAcceptedGenerationId", "prefix",
  "priorDeliverySequence", "scadEnabledAt", "schemaVersion", "scope", "tableConfiguration"] as const;
const SCOPE_KEYS = ["connectionId", "customerId", "orgId", "partition", "payerAccountIds",
  "regions", "usageAccountIds"] as const;
const TABLE_KEYS = ["includeResources", "includeSplitCostAllocationData", "tableName", "timeGranularity"] as const;
const OBJECT_KEYS = ["eTag", "key", "sha256", "sizeBytes", "versionId"] as const;
const ROW_KEYS = ["actualUsage", "currency", "lineItemId", "metric", "netSplitCost",
  "netUnusedCost", "parentResourceId", "payerAccountId", "platform",
  "publicOnDemandSplitCost", "publicOnDemandUnusedCost", "region", "reservedUsage",
  "resourceId", "resourceTags", "sourceRowNumber", "splitCost", "splitUsage",
  "splitUsageRatio", "unusedCost", "usageAccountId", "usageEndAt", "usageStartAt",
  "usageType", "usageUnit"] as const;

export type ScadCur2RuntimeFailureCode =
  | "AUTHORIZATION_FAILED"
  | "SOURCE_UNAVAILABLE"
  | "THROTTLED"
  | "TIMEOUT"
  | "SCHEMA_MISMATCH"
  | "SCOPE_MISMATCH"
  | "OBJECT_CHANGED"
  | "PAGINATION_INVALID"
  | "LIMIT_REACHED"
  | "INTERNAL_ERROR";

export class ScadCur2RuntimeError extends Error {
  public readonly code: ScadCur2RuntimeFailureCode | "INVALID_BOUNDARY" | "DUPLICATE_GENERATION";
  public constructor(code: ScadCur2RuntimeError["code"]) {
    super("SCAD CUR2 materialization was rejected");
    this.name = "ScadCur2RuntimeError";
    this.code = code;
  }
}

export interface ScadCur2RuntimeBoundary {
  readonly schemaVersion: "sutra.scad-cur2-runtime-boundary.v1";
  readonly binding: "SERVER_RESOLVED_SCAD_CUR2_EXPORT";
  readonly scope: ScadScope;
  readonly exportName: string;
  readonly exportArn: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly billingPeriodStartAt: string;
  readonly billingPeriodEndAt: string;
  readonly scadEnabledAt: string;
  readonly firstDeliveryObservedAt: string | null;
  readonly priorDeliverySequence: number;
  readonly lastAcceptedGenerationId: string | null;
  readonly tableConfiguration: ScadCapture["tableConfiguration"];
}

export interface ScadCur2Manifest {
  readonly schemaVersion: "sutra.scad-cur2-provider-manifest.v1";
  readonly scope: ScadScope;
  readonly exportArn: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly billingPeriodStartAt: string;
  readonly billingPeriodEndAt: string;
  readonly manifestSha256: string;
  readonly activeGenerationId: string;
  readonly generatedAt: string;
  readonly dataThroughAt: string;
  readonly schemaColumns: readonly string[];
  readonly expectedObjectCount: number;
  readonly runtimeS3PermissionsValidated: boolean;
}

export interface ScadCur2ManifestObject {
  readonly key: string;
  readonly eTag: string;
  readonly versionId: string | null;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ScadCur2ObjectPage {
  readonly objects: readonly ScadCur2ManifestObject[];
  readonly nextToken: string | null;
}

export interface ScadCur2RowPage {
  readonly object: ScadCur2ManifestObject;
  readonly rows: readonly Omit<ScadCur2Row, "sourceObjectId">[];
  readonly nextToken: string | null;
}

export interface ScadCur2Provider {
  getManifest(boundary: ScadCur2RuntimeBoundary, signal: AbortSignal): Promise<ScadCur2Manifest>;
  listManifestObjects(input: {
    readonly boundary: ScadCur2RuntimeBoundary;
    readonly manifestSha256: string;
    readonly pageSize: 1000;
    readonly token: string | null;
  }, signal: AbortSignal): Promise<ScadCur2ObjectPage>;
  readObjectRows(input: {
    readonly boundary: ScadCur2RuntimeBoundary;
    readonly manifestSha256: string;
    readonly object: ScadCur2ManifestObject;
    readonly pageSize: 1000;
    readonly token: string | null;
  }, signal: AbortSignal): Promise<ScadCur2RowPage>;
}

export type ScadCur2CollectionResult =
  | {
    readonly disposition: "MATERIALIZED";
    readonly capture: ScadCapture;
    readonly sourceState: ReturnType<typeof buildScadAllocationSnapshot>["state"];
    readonly failureCodes: readonly ScadCur2RuntimeFailureCode[];
    readonly requestCount: number;
    readonly retryCount: number;
  }
  | {
    readonly disposition: "DUPLICATE";
    readonly activeGenerationId: string;
    readonly manifestSha256: string;
    readonly requestCount: number;
    readonly retryCount: number;
  };

function reject(code: ScadCur2RuntimeError["code"]): never {
  throw new ScadCur2RuntimeError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sameScope(left: ScadScope, right: ScadScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactObject(left: ScadCur2ManifestObject, right: ScadCur2ManifestObject): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateBoundary(value: ScadCur2RuntimeBoundary): void {
  if (!record(value) || !exactKeys(value, BOUNDARY_KEYS)
    || !record(value.scope) || !exactKeys(value.scope, SCOPE_KEYS)
    || !record(value.tableConfiguration) || !exactKeys(value.tableConfiguration, TABLE_KEYS)
    || value.schemaVersion !== "sutra.scad-cur2-runtime-boundary.v1"
    || value.binding !== "SERVER_RESOLVED_SCAD_CUR2_EXPORT"
    || !SAFE.test(value.scope.orgId) || !SAFE.test(value.scope.customerId)
    || !CONNECTION.test(value.scope.connectionId)
    || !["aws", "aws-us-gov", "aws-cn"].includes(value.scope.partition)
    || value.scope.payerAccountIds.length === 0
    || value.scope.payerAccountIds.some((item) => !ACCOUNT.test(item))
    || value.scope.usageAccountIds.length === 0
    || value.scope.usageAccountIds.some((item) => !ACCOUNT.test(item))
    || value.scope.regions.length === 0
    || value.scope.regions.some((item) => !REGION.test(item))
    || new Set(value.scope.payerAccountIds).size !== value.scope.payerAccountIds.length
    || new Set(value.scope.usageAccountIds).size !== value.scope.usageAccountIds.length
    || new Set(value.scope.regions).size !== value.scope.regions.length
    || !SAFE.test(value.exportName)
    || !EXPORT_ARN.test(value.exportArn)
    || !value.exportArn.includes(`:${value.scope.payerAccountIds[0]}:export/`)
    || !BUCKET.test(value.bucket) || !SAFE.test(value.prefix)
    || value.prefix.startsWith("/") || !value.prefix.endsWith("/")
    || value.prefix.includes("\\")
    || value.prefix.split("/").some((part) => part === "." || part === "..")
    || !validTime(value.billingPeriodStartAt) || !validTime(value.billingPeriodEndAt)
    || !validTime(value.scadEnabledAt)
    || value.firstDeliveryObservedAt !== null && !validTime(value.firstDeliveryObservedAt)
    || !Number.isSafeInteger(value.priorDeliverySequence)
    || value.priorDeliverySequence < 0
    || value.firstDeliveryObservedAt === null && value.priorDeliverySequence !== 0
    || value.firstDeliveryObservedAt !== null && value.priorDeliverySequence === 0
    || value.lastAcceptedGenerationId !== null && !GENERATION.test(value.lastAcceptedGenerationId)
    || value.lastAcceptedGenerationId !== null && value.firstDeliveryObservedAt === null
    || value.tableConfiguration.tableName !== "COST_AND_USAGE_REPORT"
    || value.tableConfiguration.timeGranularity !== "HOURLY") reject("INVALID_BOUNDARY");
}

function failure(error: unknown): ScadCur2RuntimeFailureCode {
  if (error instanceof ScadCur2RuntimeError
    && error.code !== "INVALID_BOUNDARY"
    && error.code !== "DUPLICATE_GENERATION") return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "TIMEOUT";
  return "SOURCE_UNAVAILABLE";
}

async function sha(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function validToken(value: string | null): boolean {
  return value === null || TOKEN.test(value);
}

export class ScadCur2RuntimeAdapter {
  private readonly provider: ScadCur2Provider;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  public constructor(
    provider: ScadCur2Provider,
    now: () => number = Date.now,
    delay: (milliseconds: number, signal: AbortSignal) => Promise<void> =
      (milliseconds, signal) => new Promise((resolve, rejectPromise) => {
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          rejectPromise(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
  ) {
    this.provider = provider;
    this.now = now;
    this.delay = delay;
  }

  public async collectGeneration(
    boundary: ScadCur2RuntimeBoundary,
    signal: AbortSignal,
  ): Promise<ScadCur2CollectionResult> {
    validateBoundary(boundary);
    const startedMs = this.now();
    let requests = 0;
    let retries = 0;
    const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
      let attempt = 0;
      while (true) {
        if (signal.aborted || this.now() - startedMs > SCAD_BOUNDS.maximumCaptureDurationMs) {
          reject("TIMEOUT");
        }
        if (++requests > MAX_REQUESTS) reject("LIMIT_REACHED");
        try { return await operation(); } catch (error) {
          if (++attempt >= RETRIES || signal.aborted) {
            throw new ScadCur2RuntimeError(failure(error));
          }
          retries += 1;
          await this.delay(200 * (2 ** (attempt - 1)), signal);
        }
      }
    };

    const manifest = await invoke(() => this.provider.getManifest(boundary, signal));
    if (manifest.schemaVersion !== "sutra.scad-cur2-provider-manifest.v1"
      || !sameScope(manifest.scope, boundary.scope)
      || manifest.exportArn !== boundary.exportArn
      || manifest.bucket !== boundary.bucket || manifest.prefix !== boundary.prefix
      || manifest.billingPeriodStartAt !== boundary.billingPeriodStartAt
      || manifest.billingPeriodEndAt !== boundary.billingPeriodEndAt
      || !SHA256.test(manifest.manifestSha256)
      || manifest.activeGenerationId !== `fbg_${manifest.manifestSha256}`
      || !validTime(manifest.generatedAt) || !validTime(manifest.dataThroughAt)
      || !Number.isSafeInteger(manifest.expectedObjectCount)
      || manifest.expectedObjectCount < 0
      || manifest.expectedObjectCount > SCAD_BOUNDS.maximumObjects
      || manifest.schemaColumns.length > SCAD_BOUNDS.maximumColumns
      || manifest.schemaColumns.some((column) => !COLUMN.test(column))
      || new Set(manifest.schemaColumns).size !== manifest.schemaColumns.length) reject("SCOPE_MISMATCH");
    if (manifest.activeGenerationId === boundary.lastAcceptedGenerationId) {
      return { disposition: "DUPLICATE", activeGenerationId: manifest.activeGenerationId,
        manifestSha256: manifest.manifestSha256, requestCount: requests, retryCount: retries };
    }

    const listed: ScadCur2ManifestObject[] = [];
    const objectKeys = new Set<string>();
    const objectTokens = new Set<string>();
    let objectToken: string | null = null;
    do {
      const page = await invoke(() => this.provider.listManifestObjects({ boundary,
        manifestSha256: manifest.manifestSha256, pageSize: PAGE_SIZE, token: objectToken }, signal));
      if (!record(page) || !exactKeys(page, ["nextToken", "objects"])
        || !Array.isArray(page.objects) || !validToken(page.nextToken) || page.objects.length > PAGE_SIZE
        || page.nextToken !== null && objectTokens.has(page.nextToken)) reject("PAGINATION_INVALID");
      for (const object of page.objects) {
        if (!record(object) || !exactKeys(object, OBJECT_KEYS)
          || typeof object.key !== "string" || typeof object.eTag !== "string"
          || typeof object.sha256 !== "string" || typeof object.sizeBytes !== "number"
          || object.versionId !== null && typeof object.versionId !== "string"
          || !object.key.startsWith(boundary.prefix) || object.key === boundary.prefix
          || objectKeys.has(object.key) || !SAFE.test(object.key) || !SAFE.test(object.eTag)
          || object.versionId !== null && !SAFE.test(object.versionId)
          || !SHA256.test(object.sha256) || !Number.isSafeInteger(object.sizeBytes)
          || object.sizeBytes < 0) reject("OBJECT_CHANGED");
        objectKeys.add(object.key);
        listed.push({ key: object.key, eTag: object.eTag,
          versionId: object.versionId as string | null, sha256: object.sha256,
          sizeBytes: object.sizeBytes });
      }
      if (listed.length > SCAD_BOUNDS.maximumObjects) reject("LIMIT_REACHED");
      if (page.nextToken !== null) objectTokens.add(page.nextToken);
      objectToken = page.nextToken;
    } while (objectToken !== null);
    if (listed.length !== manifest.expectedObjectCount) reject("SCHEMA_MISMATCH");

    const objects: ScadS3ObjectEvidence[] = [];
    const rows: ScadCur2Row[] = [];
    const failures = new Set<ScadCur2RuntimeFailureCode>();
    for (const source of listed) {
      if (source.versionId === null) {
        failures.add("OBJECT_CHANGED");
        continue;
      }
      const objectId = `sco_${await sha([boundary.bucket, source.key, source.versionId, source.sha256])}`;
      const pending: ScadCur2Row[] = [];
      const rowTokens = new Set<string>();
      let rowToken: string | null = null;
      try {
        do {
          const page = await invoke(() => this.provider.readObjectRows({ boundary,
            manifestSha256: manifest.manifestSha256, object: source,
            pageSize: PAGE_SIZE, token: rowToken }, signal));
          if (!record(page) || !exactKeys(page, ["nextToken", "object", "rows"])
            || !record(page.object) || !Array.isArray(page.rows)
            || !exactObject(page.object as unknown as ScadCur2ManifestObject, source)
            || page.rows.length > PAGE_SIZE
            || page.rows.some((row) => !record(row) || !exactKeys(row, ROW_KEYS))) reject("OBJECT_CHANGED");
          if (!validToken(page.nextToken) || page.nextToken !== null && rowTokens.has(page.nextToken)) {
            reject("PAGINATION_INVALID");
          }
          pending.push(...page.rows.map((row) => ({ ...row, sourceObjectId: objectId })));
          if (rows.length + pending.length > SCAD_BOUNDS.maximumRows) reject("LIMIT_REACHED");
          if (page.nextToken !== null) rowTokens.add(page.nextToken);
          rowToken = page.nextToken;
        } while (rowToken !== null);
        rows.push(...pending);
        objects.push({ objectId, bucket: boundary.bucket, ...source });
      } catch (error) {
        failures.add(failure(error));
      }
    }

    const completedMs = this.now();
    const captureBody = [boundary.scope, manifest.manifestSha256, startedMs, completedMs, objects, rows];
    const capture: ScadCapture = {
      schemaVersion: "sutra.scad-allocation.capture.v1",
      scope: boundary.scope,
      captureId: `scad_${await sha(captureBody)}`,
      startedAt: new Date(startedMs).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
      exportName: boundary.exportName,
      exportArn: boundary.exportArn,
      activeGenerationId: manifest.activeGenerationId,
      correctionOfGenerationId: boundary.lastAcceptedGenerationId,
      manifestSha256: manifest.manifestSha256,
      generatedAt: manifest.generatedAt,
      dataThroughAt: manifest.dataThroughAt,
      billingPeriodStartAt: boundary.billingPeriodStartAt,
      billingPeriodEndAt: boundary.billingPeriodEndAt,
      scadEnabledAt: boundary.scadEnabledAt,
      firstDeliveryObservedAt: boundary.firstDeliveryObservedAt ?? new Date(completedMs).toISOString(),
      deliverySequence: boundary.priorDeliverySequence + 1,
      destination: { bucket: boundary.bucket, prefix: boundary.prefix },
      tableConfiguration: boundary.tableConfiguration,
      coverage: {
        runtimeS3PermissionsValidated: manifest.runtimeS3PermissionsValidated,
        expectedObjectCount: manifest.expectedObjectCount,
        processedObjectCount: objects.length,
        failedObjectCount: manifest.expectedObjectCount - objects.length,
        rowsExhausted: objects.length === manifest.expectedObjectCount,
        schemaColumns: [...manifest.schemaColumns].sort(),
        errorCode: failures.size === 0 ? null : [...failures].sort()[0]!,
      },
      objects,
      rows,
    };
    const snapshot = buildScadAllocationSnapshot(capture, boundary.scope, completedMs);
    return { disposition: "MATERIALIZED", capture, sourceState: snapshot.state,
      failureCodes: [...failures].sort(), requestCount: requests, retryCount: retries };
  }

  /** Compatibility with the existing daily materialization job contract. */
  public async collect(boundary: ScadCur2RuntimeBoundary, signal: AbortSignal): Promise<ScadCapture> {
    const result = await this.collectGeneration(boundary, signal);
    if (result.disposition === "DUPLICATE") reject("DUPLICATE_GENERATION");
    return result.capture;
  }
}
