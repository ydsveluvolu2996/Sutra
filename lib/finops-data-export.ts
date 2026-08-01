/**
 * AWS Data Exports manifest boundary.
 *
 * AWS publishes the manifest only after every data object for an execution is
 * present. Consumers must ingest the exact object list from that manifest and
 * replace the partition atomically because current-period exports are revised.
 * This module does not fetch S3 objects or write billing rows; it validates the
 * untrusted manifest and creates the deterministic, tenant-bound ingestion plan
 * that a worker/repository can execute.
 */

export const FINOPS_MANIFEST_MAX_BYTES = 5 * 1024 * 1024;
export const FINOPS_MANIFEST_MAX_FILES = 10_000;
export const FINOPS_MANIFEST_MAX_COLUMNS = 2_000;

export type FinopsExportTable =
  | "cur-2.0"
  | "focus-1.0-aws"
  | "focus-1.2-aws"
  | "cost-optimization-recommendations"
  | "carbon-emissions"
  | "unknown";

export interface FinopsExportScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface FinopsManifestObject {
  readonly bucket: string;
  readonly key: string;
}

export interface FinopsManifestObservation {
  readonly scope: FinopsExportScope;
  readonly bucket: string;
  readonly manifestKey: string;
  readonly eTag: string | null;
  readonly versionId: string | null;
  readonly observedAtIso: string;
  readonly body: string | Readonly<Record<string, unknown>>;
}

export interface ValidatedFinopsManifest {
  readonly scope: FinopsExportScope;
  readonly exportName: string;
  readonly table: FinopsExportTable;
  readonly sourceTableName: string | null;
  readonly billingPeriod: string;
  readonly periodStartIso: string;
  readonly periodEndIso: string;
  readonly sourceUpdatedAtIso: string | null;
  readonly manifest: FinopsManifestObject;
  readonly dataFiles: readonly FinopsManifestObject[];
  readonly columns: readonly string[];
  readonly schemaSha256: string;
  readonly manifestSha256: string;
  readonly eTag: string | null;
  readonly versionId: string | null;
  readonly observedAtIso: string;
}

export interface FinopsManifestRejection {
  readonly code:
    | "INVALID_SCOPE"
    | "INVALID_BUCKET"
    | "INVALID_MANIFEST_KEY"
    | "MANIFEST_TOO_LARGE"
    | "INVALID_JSON"
    | "INVALID_MANIFEST"
    | "UNSUPPORTED_FILE"
    | "CROSS_BUCKET_FILE"
    | "DUPLICATE_FILE"
    | "TOO_MANY_FILES"
    | "TOO_MANY_COLUMNS";
  readonly message: string;
}

export type FinopsManifestValidation =
  | { readonly ok: true; readonly manifest: ValidatedFinopsManifest }
  | { readonly ok: false; readonly rejection: FinopsManifestRejection };

export interface PersistedFinopsPartition {
  readonly scope: FinopsExportScope;
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly manifestSha256: string;
  readonly eTag: string | null;
  readonly versionId: string | null;
  readonly committedAtIso: string;
}

export type FinopsIngestionDecision =
  | {
      readonly action: "ingest";
      readonly reason: "first_delivery" | "corrected_or_refreshed_delivery";
      readonly writeMode: "replace_partition_atomically";
      readonly manifest: ValidatedFinopsManifest;
    }
  | {
      readonly action: "skip";
      readonly reason: "duplicate_manifest";
      readonly manifest: ValidatedFinopsManifest;
    }
  | {
      readonly action: "reject";
      readonly reason: "scope_mismatch" | "partition_mismatch" | "immutable_object_changed";
      readonly manifest: ValidatedFinopsManifest;
    };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function nested(root: Readonly<Record<string, unknown>>, ...path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const parent = record(current);
    if (parent === null) return undefined;
    current = parent[key];
  }
  return current;
}

function first(root: Readonly<Record<string, unknown>>, paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    const value = nested(root, ...path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function rejection(code: FinopsManifestRejection["code"], message: string): FinopsManifestValidation {
  return { ok: false, rejection: { code, message } };
}

function validScope(scope: FinopsExportScope): boolean {
  return [scope.organizationId, scope.customerId, scope.connectionId]
    .every((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value));
}

function validBucket(bucket: string): boolean {
  return /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket);
}

function validKey(key: string): boolean {
  if (key === "" || key.length > 1_024 || key.startsWith("/") || key.includes("\0") || key.includes("\\")) return false;
  return !key.split("/").some((part) => part === "." || part === "..");
}

function parseIso(value: unknown): string | null {
  const candidate = text(value);
  if (candidate === null) return null;
  const epoch = Date.parse(candidate);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function periodFromKey(key: string): string | null {
  const match = /(?:^|\/)BILLING_PERIOD=(\d{4}-(?:0[1-9]|1[0-2]))(?:\/|$)/u.exec(key);
  return match?.[1] ?? null;
}

function periodBounds(period: string): { readonly start: string; readonly end: string } {
  const [yearText, monthText] = period.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    end: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

function periodFromDates(start: string | null): string | null {
  return start === null ? null : start.slice(0, 7);
}

function inferTable(sourceTableName: string | null, exportName: string): FinopsExportTable {
  const candidate = `${sourceTableName ?? ""} ${exportName}`.toUpperCase().replaceAll("-", "_");
  if (
    candidate.includes("FOCUS")
    && (candidate.includes("1.2") || candidate.includes("1_2"))
  ) return "focus-1.2-aws";
  if (candidate.includes("FOCUS")) return "focus-1.0-aws";
  if (candidate.includes("COST_OPTIMIZATION") || candidate.includes("RECOMMENDATION")) return "cost-optimization-recommendations";
  if (candidate.includes("CARBON") || candidate.includes("EMISSION")) return "carbon-emissions";
  if (candidate.includes("CUR") || candidate.includes("COST_AND_USAGE")) return "cur-2.0";
  return "unknown";
}

function normalizeObjectPath(value: unknown, expectedBucket: string): FinopsManifestObject | FinopsManifestRejection {
  const item = record(value);
  const raw = text(value) ?? text(item?.filePath) ?? text(item?.fileName) ?? text(item?.key) ?? text(item?.s3Key);
  if (raw === null) return { code: "INVALID_MANIFEST", message: "Every manifest data-file entry must contain an S3 object key." };
  let bucket = expectedBucket;
  let key = raw;
  if (raw.startsWith("s3://")) {
    const match = /^s3:\/\/([^/]+)\/(.+)$/u.exec(raw);
    if (match === null) return { code: "INVALID_MANIFEST", message: "A manifest data-file S3 URI is malformed." };
    bucket = match[1] ?? "";
    key = match[2] ?? "";
  }
  if (bucket !== expectedBucket) return { code: "CROSS_BUCKET_FILE", message: "Manifest data files must remain in the configured export bucket." };
  if (!validKey(key)) return { code: "INVALID_MANIFEST", message: "A manifest data-file key is unsafe or malformed." };
  if (!/\.(?:csv\.gz|snappy\.parquet|parquet)$/u.test(key)) {
    return { code: "UNSUPPORTED_FILE", message: "Only gzip CSV and Parquet AWS Data Export objects are accepted." };
  }
  return { bucket, key };
}

function columnsFrom(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    const item = record(entry);
    const name = text(entry) ?? text(item?.name) ?? text(item?.columnName);
    if (name === null) return null;
    names.push(name);
  }
  return names;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const valueRecord = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(valueRecord).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(valueRecord[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function validateFinopsDataExportManifest(
  observation: FinopsManifestObservation,
): Promise<FinopsManifestValidation> {
  if (!validScope(observation.scope)) return rejection("INVALID_SCOPE", "Organization, customer, and connection scope are required.");
  if (!validBucket(observation.bucket)) return rejection("INVALID_BUCKET", "The configured S3 bucket name is invalid.");
  if (!validKey(observation.manifestKey)) return rejection("INVALID_MANIFEST_KEY", "The manifest S3 key is unsafe or malformed.");
  const observedAtIso = parseIso(observation.observedAtIso);
  if (observedAtIso === null) return rejection("INVALID_MANIFEST", "The manifest observation time must be an ISO timestamp.");

  let root: Readonly<Record<string, unknown>> | null;
  if (typeof observation.body === "string") {
    if (new TextEncoder().encode(observation.body).byteLength > FINOPS_MANIFEST_MAX_BYTES) {
      return rejection("MANIFEST_TOO_LARGE", "The AWS Data Export manifest exceeds the accepted size.");
    }
    try {
      root = record(JSON.parse(observation.body) as unknown);
    } catch {
      return rejection("INVALID_JSON", "The AWS Data Export manifest is not valid JSON.");
    }
  } else {
    root = record(observation.body);
  }
  if (root === null) return rejection("INVALID_MANIFEST", "The AWS Data Export manifest root must be an object.");

  const metadata = record(root.metadata);
  const exportName = text(first(root, [["exportName"], ["metadata", "exportName"], ["export", "name"]]));
  const sourceTableName = text(first(root, [["tableName"], ["exportTableName"], ["metadata", "exportTableName"], ["metadata", "tableName"], ["export", "tableName"]]));
  if (exportName === null) return rejection("INVALID_MANIFEST", "The manifest does not identify its export name.");

  const rawFiles = first(root, [["dataFiles"], ["data", "dataFiles"], ["files"], ["export", "dataFiles"]]);
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return rejection("INVALID_MANIFEST", "The manifest must list at least one delivered data object.");
  }
  if (rawFiles.length > FINOPS_MANIFEST_MAX_FILES) {
    return rejection("TOO_MANY_FILES", `The manifest lists more than ${FINOPS_MANIFEST_MAX_FILES} data objects.`);
  }
  const dataFiles: FinopsManifestObject[] = [];
  const seen = new Set<string>();
  for (const rawFile of rawFiles) {
    const normalized = normalizeObjectPath(rawFile, observation.bucket);
    if ("code" in normalized) return { ok: false, rejection: normalized };
    if (seen.has(normalized.key)) return rejection("DUPLICATE_FILE", "The manifest lists the same data object more than once.");
    seen.add(normalized.key);
    dataFiles.push(normalized);
  }

  const rawColumns = first(root, [["columns"], ["data", "columns"], ["schema", "columns"], ["export", "columns"]]);
  const columns = columnsFrom(rawColumns);
  if (columns === null || columns.length === 0) return rejection("INVALID_MANIFEST", "The manifest must list its delivered columns.");
  if (columns.length > FINOPS_MANIFEST_MAX_COLUMNS) {
    return rejection("TOO_MANY_COLUMNS", `The manifest lists more than ${FINOPS_MANIFEST_MAX_COLUMNS} columns.`);
  }
  if (new Set(columns).size !== columns.length) return rejection("INVALID_MANIFEST", "The manifest contains duplicate column names.");

  const start = parseIso(first(root, [["billingPeriod", "start"], ["data", "billingPeriod", "start"], ["billingPeriod", "startDate"], ["data", "billingPeriod", "startDate"]]));
  const end = parseIso(first(root, [["billingPeriod", "end"], ["data", "billingPeriod", "end"], ["billingPeriod", "endDate"], ["data", "billingPeriod", "endDate"]]));
  const billingPeriod = periodFromKey(observation.manifestKey) ?? periodFromKey(dataFiles[0]?.key ?? "") ?? periodFromDates(start);
  if (billingPeriod === null) return rejection("INVALID_MANIFEST", "The manifest billing period could not be established.");
  const bounds = periodBounds(billingPeriod);
  const periodStartIso = start ?? bounds.start;
  const periodEndIso = end ?? bounds.end;
  if (periodStartIso.slice(0, 7) !== billingPeriod || Date.parse(periodEndIso) <= Date.parse(periodStartIso)) {
    return rejection("INVALID_MANIFEST", "The manifest billing-period dates are inconsistent.");
  }
  if (dataFiles.some((file) => periodFromKey(file.key) !== null && periodFromKey(file.key) !== billingPeriod)) {
    return rejection("INVALID_MANIFEST", "Manifest data objects cross billing-period partitions.");
  }

  const sourceUpdatedAtIso = parseIso(
    metadata?.exportLastUpdatedTime
      ?? metadata?.lastUpdatedTime
      ?? root.exportLastUpdatedTime
      ?? root.lastUpdatedTime,
  );
  const canonical = {
    exportName,
    sourceTableName,
    billingPeriod,
    periodStartIso,
    periodEndIso,
    columns,
    dataFiles: dataFiles.map((file) => file.key),
  };
  return {
    ok: true,
    manifest: {
      scope: observation.scope,
      exportName,
      table: inferTable(sourceTableName, exportName),
      sourceTableName,
      billingPeriod,
      periodStartIso,
      periodEndIso,
      sourceUpdatedAtIso,
      manifest: { bucket: observation.bucket, key: observation.manifestKey },
      dataFiles,
      columns,
      schemaSha256: await sha256(canonicalJson(columns)),
      manifestSha256: await sha256(canonicalJson(canonical)),
      eTag: text(observation.eTag),
      versionId: text(observation.versionId),
      observedAtIso,
    },
  };
}

function sameScope(left: FinopsExportScope, right: FinopsExportScope): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

export function decideFinopsDataExportIngestion(
  manifest: ValidatedFinopsManifest,
  persisted: PersistedFinopsPartition | null,
): FinopsIngestionDecision {
  if (persisted === null) {
    return { action: "ingest", reason: "first_delivery", writeMode: "replace_partition_atomically", manifest };
  }
  if (!sameScope(manifest.scope, persisted.scope)) return { action: "reject", reason: "scope_mismatch", manifest };
  if (manifest.exportName !== persisted.exportName || manifest.billingPeriod !== persisted.billingPeriod) {
    return { action: "reject", reason: "partition_mismatch", manifest };
  }
  if (manifest.manifestSha256 === persisted.manifestSha256) {
    return { action: "skip", reason: "duplicate_manifest", manifest };
  }
  if (
    manifest.versionId !== null
    && persisted.versionId !== null
    && manifest.versionId === persisted.versionId
  ) {
    return { action: "reject", reason: "immutable_object_changed", manifest };
  }
  return {
    action: "ingest",
    reason: "corrected_or_refreshed_delivery",
    writeMode: "replace_partition_atomically",
    manifest,
  };
}
