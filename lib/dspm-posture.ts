import { canonicalJson } from "./canonical-json.ts";

export const DSPM_SCHEMA_VERSION = "sutra.dspm-evidence.v1" as const;
export const DSPM_MAX_BODY_BYTES = 512 * 1024;
export const DSPM_MAX_ASSETS = 200;

export const DSPM_SOURCES = [
  "aws-macie",
  "agentless-classifier",
  "normalized-import",
] as const;
export type DspmSource = (typeof DSPM_SOURCES)[number];

export const DSPM_RESOURCE_TYPES = [
  "s3-bucket",
  "rds-cluster",
  "rds-snapshot",
  "ebs-snapshot",
  "dynamodb-table",
  "redshift-cluster",
  "efs-filesystem",
  "unknown",
] as const;
export type DspmResourceType = (typeof DSPM_RESOURCE_TYPES)[number];

export const DSPM_CLASSIFICATIONS = [
  "restricted",
  "confidential",
  "internal",
  "public",
  "unknown",
] as const;
export type DspmClassification = (typeof DSPM_CLASSIFICATIONS)[number];

export const DSPM_DATA_CATEGORIES = [
  "credentials",
  "customer-data",
  "financial",
  "health",
  "personal",
  "payment-card",
  "source-code",
] as const;
export type DspmDataCategory = (typeof DSPM_DATA_CATEGORIES)[number];

export const DSPM_COVERAGE_LIMITATIONS = [
  "ACCESS_EVIDENCE_PARTIAL",
  "CLASSIFICATION_PARTIAL",
  "RESOURCE_TYPE_UNSUPPORTED",
  "SOURCE_UNAVAILABLE",
] as const;
export type DspmCoverageLimitation = (typeof DSPM_COVERAGE_LIMITATIONS)[number];

export type DspmCoverageStatus = "COMPLETE" | "PARTIAL";
export type DspmRiskSeverity = "critical" | "high" | "medium" | "low" | "none";

export interface DspmAssetInput {
  readonly resourceKey: string;
  readonly resourceType: DspmResourceType;
  readonly region: string;
  readonly classification: DspmClassification;
  readonly categories: readonly DspmDataCategory[];
  readonly ownerRef: string | null;
  readonly encrypted: boolean | null;
  readonly publicAccess: boolean | null;
  readonly crossAccountAccess: boolean | null;
  readonly externalSharing: boolean | null;
  readonly credentialsDetected: boolean | null;
  readonly dataSizeBytes: number | null;
}

export interface DspmCoverage {
  readonly status: DspmCoverageStatus;
  readonly resourcesDiscovered: number;
  readonly resourcesClassified: number;
  readonly limitations: readonly DspmCoverageLimitation[];
}

export interface DspmPublishRequest {
  readonly connectionId: string;
  readonly source: DspmSource;
  readonly idempotencyKey: string;
  readonly collectedAtMs: number;
  readonly coverage: DspmCoverage;
  readonly assets: readonly DspmAssetInput[];
}

export interface DspmRiskAssessment {
  readonly score: number;
  readonly severity: DspmRiskSeverity;
  readonly factors: readonly string[];
  readonly recommendations: readonly string[];
  readonly title: string | null;
}

const ROOT_KEYS = new Set(["connectionId", "source", "idempotencyKey", "collectedAt", "coverage", "assets"]);
const COVERAGE_KEYS = new Set(["status", "resourcesDiscovered", "resourcesClassified", "limitations"]);
const ASSET_KEYS = new Set([
  "resourceKey",
  "resourceType",
  "region",
  "classification",
  "categories",
  "ownerRef",
  "encrypted",
  "publicAccess",
  "crossAccountAccess",
  "externalSharing",
  "credentialsDetected",
  "dataSizeBytes",
]);
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,95}$/u;
const REGION = /^(?:global|[a-z]{2}(?:-gov)?-[a-z]+-\d)$/u;
const OWNER_REF = /^[\p{L}\p{N}][\p{L}\p{N} ._:@/+()-]{0,127}$/u;
const CATEGORY_SET = new Set<string>(DSPM_DATA_CATEGORIES);
const CLASSIFICATION_SET = new Set<string>(DSPM_CLASSIFICATIONS);
const RESOURCE_TYPE_SET = new Set<string>(DSPM_RESOURCE_TYPES);
const SOURCE_SET = new Set<string>(DSPM_SOURCES);
const LIMITATION_SET = new Set<string>(DSPM_COVERAGE_LIMITATIONS);

export class DspmInputError extends Error {
  public readonly code = "INVALID_INPUT";

  public constructor(message = "The DSPM evidence is invalid") {
    super(message);
    this.name = "DspmInputError";
  }
}

function invalid(message?: string): never {
  throw new DspmInputError(message);
}

function exactRecord(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.has(key))) invalid();
  return record;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid();
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) invalid();
  return trimmed;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") invalid();
  return value;
}

function nullableSafeInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>): T {
  if (typeof value !== "string" || !allowed.has(value)) invalid();
  return value as T;
}

function stringEnumArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  maximum: number,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const normalized = value.map((entry) => enumValue<T>(entry, allowed));
  if (new Set(normalized).size !== normalized.length) invalid();
  return normalized.sort((left, right) => left.localeCompare(right, "en-US"));
}

function parseAsset(value: unknown): DspmAssetInput {
  const record = exactRecord(value, ASSET_KEYS);
  const resourceKey = boundedText(record.resourceKey, 512);
  const region = boundedText(record.region, 32);
  if (!REGION.test(region)) invalid();
  const ownerRef = record.ownerRef === null ? null : boundedText(record.ownerRef, 128);
  if (ownerRef !== null && !OWNER_REF.test(ownerRef)) invalid();
  return {
    resourceKey,
    resourceType: enumValue(record.resourceType, RESOURCE_TYPE_SET),
    region,
    classification: enumValue(record.classification, CLASSIFICATION_SET),
    categories: stringEnumArray(record.categories, CATEGORY_SET, DSPM_DATA_CATEGORIES.length),
    ownerRef,
    encrypted: nullableBoolean(record.encrypted),
    publicAccess: nullableBoolean(record.publicAccess),
    crossAccountAccess: nullableBoolean(record.crossAccountAccess),
    externalSharing: nullableBoolean(record.externalSharing),
    credentialsDetected: nullableBoolean(record.credentialsDetected),
    dataSizeBytes: nullableSafeInteger(record.dataSizeBytes),
  };
}

/**
 * Strict normalized evidence boundary. It accepts classifications and booleans,
 * never object samples, discovered values, policy documents, credentials, or
 * principal names. Unknown keys fail closed so producers cannot accidentally
 * persist sensitive scanner output when their upstream schema changes.
 */
export function parseDspmPublishRequest(value: unknown, nowMs = Date.now()): DspmPublishRequest {
  const record = exactRecord(value, ROOT_KEYS);
  const connectionId = boundedText(record.connectionId, 64);
  const idempotencyKey = boundedText(record.idempotencyKey, 96);
  if (!CONNECTION_ID.test(connectionId) || !IDEMPOTENCY_KEY.test(idempotencyKey)) invalid();
  const collectedAt = boundedText(record.collectedAt, 64);
  const collectedAtMs = Date.parse(collectedAt);
  // A far-future timestamp would pin the connection head and prevent later
  // legitimate scans from becoming current. Five minutes permits clock skew.
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(collectedAtMs) ||
    collectedAtMs < Date.UTC(2000, 0, 1) ||
    collectedAtMs > nowMs + 5 * 60 * 1_000
  ) invalid();

  const coverageRecord = exactRecord(record.coverage, COVERAGE_KEYS);
  const coverage: DspmCoverage = {
    status: enumValue(coverageRecord.status, new Set(["COMPLETE", "PARTIAL"])),
    resourcesDiscovered: nonNegativeInteger(coverageRecord.resourcesDiscovered),
    resourcesClassified: nonNegativeInteger(coverageRecord.resourcesClassified),
    limitations: stringEnumArray(
      coverageRecord.limitations,
      LIMITATION_SET,
      DSPM_COVERAGE_LIMITATIONS.length,
    ),
  };
  if (
    coverage.resourcesClassified > coverage.resourcesDiscovered ||
    (coverage.status === "COMPLETE" && coverage.limitations.length > 0)
  ) invalid();

  if (!Array.isArray(record.assets) || record.assets.length > DSPM_MAX_ASSETS) invalid();
  const assets = record.assets.map(parseAsset);
  const resourceKeys = new Set(assets.map((asset) => asset.resourceKey));
  if (resourceKeys.size !== assets.length || coverage.resourcesClassified < assets.length) invalid();

  return {
    connectionId,
    source: enumValue(record.source, SOURCE_SET),
    idempotencyKey,
    collectedAtMs,
    coverage,
    assets,
  };
}

const REGULATED = new Set<DspmDataCategory>([
  "credentials",
  "financial",
  "health",
  "personal",
  "payment-card",
]);

function severityFor(score: number): DspmRiskSeverity {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  if (score > 0) return "low";
  return "none";
}

/** Deterministic, explainable scoring over metadata only. */
export function assessDspmAsset(asset: DspmAssetInput): DspmRiskAssessment {
  let score = 0;
  const factors: string[] = [];
  const recommendations = new Set<string>();
  const add = (points: number, factor: string, recommendation?: string): void => {
    score += points;
    factors.push(factor);
    if (recommendation !== undefined) recommendations.add(recommendation);
  };

  if (asset.classification === "restricted") add(35, "restricted-data");
  else if (asset.classification === "confidential") add(25, "confidential-data");
  else if (asset.classification === "internal") add(10, "internal-data");
  else if (asset.classification === "unknown") {
    add(5, "classification-unknown", "Complete classification coverage for this data store.");
  }
  if (asset.categories.some((category) => REGULATED.has(category))) {
    add(20, "regulated-data", "Confirm the data owner's retention and regulatory controls.");
  }
  if (asset.publicAccess === true) {
    add(35, "public-access", "Remove public access unless it is explicitly approved.");
  } else if (asset.publicAccess === null) {
    add(5, "public-access-unknown", "Collect effective public-access evidence.");
  }
  if (asset.encrypted === false) {
    add(20, "unencrypted", "Encrypt the data store with a customer-approved key.");
  } else if (asset.encrypted === null) {
    add(5, "encryption-unknown", "Collect encryption-at-rest evidence.");
  }
  if (asset.crossAccountAccess === true) {
    add(15, "cross-account-access", "Review and constrain cross-account access.");
  }
  if (asset.externalSharing === true) {
    add(20, "external-sharing", "Remove unapproved external sharing.");
  }
  if (asset.credentialsDetected === true) {
    add(25, "credentials-detected", "Rotate exposed credentials and remove them from the data store.");
  }
  if (asset.ownerRef === null) {
    add(5, "owner-unassigned", "Assign a responsible data owner.");
  }

  const boundedScore = Math.min(score, 100);
  const severity = severityFor(boundedScore);
  const sensitive = asset.classification === "restricted" || asset.classification === "confidential";
  const title = severity === "none"
    ? null
    : sensitive && asset.publicAccess === true
      ? "Sensitive data store has public access"
      : asset.credentialsDetected === true
        ? "Data store contains credential material"
        : asset.encrypted === false
          ? "Data store is not encrypted at rest"
          : "Data security posture requires review";
  return {
    score: boundedScore,
    severity,
    factors,
    recommendations: [...recommendations],
    title,
  };
}

export async function dspmEvidenceSha256(request: DspmPublishRequest): Promise<string> {
  const evidence = canonicalJson({
    schemaVersion: DSPM_SCHEMA_VERSION,
    connectionId: request.connectionId,
    source: request.source,
    collectedAtMs: request.collectedAtMs,
    coverage: request.coverage,
    assets: request.assets,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidence));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
