/**
 * Pure exact-address loader for completed AWS Compute Optimizer export jobs.
 *
 * It never lists or discovers S3 objects. Every read address comes from a
 * verified export-job binding, and every returned CSV is parsed against its
 * paired AWS CSVW metadata before any result is released.
 */

import {
  COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS,
  ComputeOptimizerExportParserError,
  parseComputeOptimizerExport,
  type ParsedComputeOptimizerExport,
} from "./finops-compute-optimizer-export-parser.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS,
  type ComputeOptimizerExportFamily,
  type ComputeOptimizerProviderExportJobResourceType,
  type VerifiedComputeOptimizerExportJobBinding,
} from "./finops-compute-optimizer-export-plan.ts";
import { COMPUTE_OPTIMIZER_COLLECTION_BOUNDS } from "./finops-compute-optimizer-organization.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const PLAN_ID = /^cope_[a-f0-9]{64}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const SAFE_IDENTITY = /^[^\u0000-\u0020\u007f<>]{1,1024}$/u;
const MAX_KEY_BYTES = 1_024;

export const COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS = Object.freeze({
  maximumConcurrency: COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumConcurrency,
  maximumDurationMs: COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumDurationMs,
  maximumTargets: COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumTargets,
  maximumCsvBytes: COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS.maximumCsvBytes,
  maximumMetadataBytes: COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS.maximumMetadataBytes,
  maximumAggregateBytes: COMPUTE_OPTIMIZER_COLLECTION_BOUNDS.maximumExportBytes,
} as const);

export interface ComputeOptimizerExportObjectSetLimits {
  readonly maximumConcurrency: number;
  readonly maximumCsvBytes: number;
  readonly maximumMetadataBytes: number;
  readonly maximumAggregateBytes: number;
}

export interface ComputeOptimizerExportObjectRead {
  readonly bytes: Uint8Array;
  readonly eTag: string;
  /** null is a current-object GetObject read; a string pins GetObjectVersion. */
  readonly versionId: string | null;
}

export type ComputeOptimizerExportObjectReader = (
  region: string,
  bucket: string,
  key: string,
  maximumBytes: number,
  signal: AbortSignal,
) => Promise<ComputeOptimizerExportObjectRead>;

export interface LoadedComputeOptimizerExportObjectIdentity {
  readonly key: string;
  readonly eTag: string;
  /** null identifies a non-versioned/current object; a string identifies an exact S3 version. */
  readonly versionId: string | null;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LoadedComputeOptimizerExportTargetBundle {
  readonly region: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
  readonly providerResourceType: ComputeOptimizerProviderExportJobResourceType;
  readonly requestSha256: string;
  readonly jobId: string;
  readonly bucket: string;
  readonly csvObject: LoadedComputeOptimizerExportObjectIdentity;
  readonly metadataObject: LoadedComputeOptimizerExportObjectIdentity;
  readonly parsed: ParsedComputeOptimizerExport;
}

export interface LoadedComputeOptimizerExportObjectSet {
  readonly schemaVersion: "sutra.compute-optimizer-export-object-set.v1";
  readonly planId: string;
  readonly planContentSha256: string;
  readonly aggregateBytes: number;
  readonly targets: readonly LoadedComputeOptimizerExportTargetBundle[];
}

export interface LoadComputeOptimizerExportObjectSetOptions {
  readonly signal?: AbortSignal;
  /** Absolute Unix epoch deadline. The built-in maximum duration still applies. */
  readonly deadlineAtMs?: number;
  readonly limits?: Partial<ComputeOptimizerExportObjectSetLimits>;
  /** Testable clock; must remain monotonic and return a safe non-negative integer. */
  readonly now?: () => number;
}

export class ComputeOptimizerExportObjectSetError extends Error {
  // Declared and assigned rather than a constructor parameter property: Node's default strip-only TypeScript mode
  // cannot transform parameter properties, so any test importing this module without the transform loader fails to
  // load it.
  public readonly code:
    | "INVALID_INPUT"
    | "LIMIT_EXCEEDED"
    | "ABORTED"
    | "DEADLINE_EXCEEDED"
    | "ADDRESS_SET_MISMATCH"
    | "READ_FAILED"
    | "OBJECT_IDENTITY_MISMATCH"
    | "OBJECT_MUTATED"
    | "PARSE_REJECTED";
  public constructor(code: ComputeOptimizerExportObjectSetError["code"]) {
    super("Compute Optimizer export object set rejected");
    this.name = "ComputeOptimizerExportObjectSetError";
    this.code = code;
  }
}

type ValidatedTarget = VerifiedComputeOptimizerExportJobBinding["targets"][number];
type ObjectKind = "csv" | "metadata";

interface ReadTask {
  readonly target: ValidatedTarget;
  readonly kind: ObjectKind;
  readonly key: string;
  readonly maximumBytes: number;
}

interface LoadedObject {
  readonly source: ComputeOptimizerExportObjectRead;
  readonly bytes: Uint8Array;
  readonly identity: LoadedComputeOptimizerExportObjectIdentity;
}

const EXPORT_FAMILIES = new Set<ComputeOptimizerExportFamily>([
  "EC2_INSTANCE",
  "AUTO_SCALING_GROUP",
  "EBS_VOLUME",
  "LAMBDA_FUNCTION",
  "ECS_SERVICE",
  "LICENSE",
  "RDS_DATABASE",
  "IDLE_RESOURCE",
]);

const PROVIDER_TYPES_BY_FAMILY: Readonly<
  Record<ComputeOptimizerExportFamily, ReadonlySet<ComputeOptimizerProviderExportJobResourceType>>
> = Object.freeze({
  EC2_INSTANCE: new Set<ComputeOptimizerProviderExportJobResourceType>(["Ec2Instance"]),
  AUTO_SCALING_GROUP: new Set<ComputeOptimizerProviderExportJobResourceType>(["AutoScalingGroup"]),
  EBS_VOLUME: new Set<ComputeOptimizerProviderExportJobResourceType>(["EbsVolume"]),
  LAMBDA_FUNCTION: new Set<ComputeOptimizerProviderExportJobResourceType>(["LambdaFunction"]),
  ECS_SERVICE: new Set<ComputeOptimizerProviderExportJobResourceType>(["EcsService"]),
  LICENSE: new Set<ComputeOptimizerProviderExportJobResourceType>(["License"]),
  RDS_DATABASE: new Set<ComputeOptimizerProviderExportJobResourceType>([
    "RdsDBInstance",
    "AuroraDBClusterStorage",
  ]),
  IDLE_RESOURCE: new Set<ComputeOptimizerProviderExportJobResourceType>(["Idle"]),
});

function reject(code: ComputeOptimizerExportObjectSetError["code"]): never {
  throw new ComputeOptimizerExportObjectSetError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function validKey(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || value.includes("\0")
  ) return false;
  return !value.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function validCsvBasename(value: string, region: string, jobId: string): boolean {
  const prefix = `${region}-`;
  const suffix = `-${jobId}.csv`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  return value.slice(prefix.length, -suffix.length).length > 0;
}

function hasProviderObjectPath(key: string): boolean {
  const parent = key.slice(0, key.lastIndexOf("/") + 1);
  return /(?:^|\/)compute-optimizer\/\d{12}\/$/u.test(parent);
}

function pair(target: Pick<ValidatedTarget, "region" | "exportFamily">): string {
  return `${target.region}\u0000${target.exportFamily}`;
}

function address(region: string, bucket: string, key: string): string {
  return `${region}\u0000${bucket}\u0000${key}`;
}

function validateBinding(value: unknown): ValidatedTarget[] {
  if (
    !isRecord(value)
    || !exactKeys(value, ["planId", "contentSha256", "targets"])
    || typeof value.planId !== "string"
    || !PLAN_ID.test(value.planId)
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || !Array.isArray(value.targets)
    || value.targets.length < 1
  ) reject("ADDRESS_SET_MISMATCH");
  if (value.targets.length > COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumTargets) {
    reject("LIMIT_EXCEEDED");
  }

  const pairs = new Set<string>();
  const jobs = new Set<string>();
  const addresses = new Set<string>();
  const regionBuckets = new Map<string, string>();
  const bucketRegions = new Map<string, string>();
  const targets: ValidatedTarget[] = [];
  for (const candidate of value.targets) {
    if (
      !isRecord(candidate)
      || !exactKeys(candidate, [
        "region",
        "exportFamily",
        "providerResourceType",
        "requestSha256",
        "jobId",
        "bucket",
        "objectKey",
        "metadataKey",
      ])
      || typeof candidate.region !== "string"
      || !REGION.test(candidate.region)
      || typeof candidate.exportFamily !== "string"
      || !EXPORT_FAMILIES.has(candidate.exportFamily as ComputeOptimizerExportFamily)
      || typeof candidate.providerResourceType !== "string"
      || !PROVIDER_TYPES_BY_FAMILY[candidate.exportFamily as ComputeOptimizerExportFamily].has(
        candidate.providerResourceType as ComputeOptimizerProviderExportJobResourceType,
      )
      || typeof candidate.requestSha256 !== "string"
      || !SHA256.test(candidate.requestSha256)
      || typeof candidate.jobId !== "string"
      || !JOB_ID.test(candidate.jobId)
      || typeof candidate.bucket !== "string"
      || !BUCKET.test(candidate.bucket)
      || !validKey(candidate.objectKey)
      || !validKey(candidate.metadataKey)
      || !candidate.objectKey.endsWith(".csv")
      || !hasProviderObjectPath(candidate.objectKey)
      || candidate.metadataKey !== `${candidate.objectKey.slice(0, -4)}-metadata.json`
      || !validCsvBasename(basename(candidate.objectKey), candidate.region, candidate.jobId)
    ) reject("ADDRESS_SET_MISMATCH");
    const target = candidate as unknown as ValidatedTarget;
    const targetPair = pair(target);
    const csvAddress = address(target.region, target.bucket, target.objectKey);
    const metadataAddress = address(target.region, target.bucket, target.metadataKey);
    const knownBucket = regionBuckets.get(target.region);
    const knownRegion = bucketRegions.get(target.bucket);
    if (
      pairs.has(targetPair)
      || jobs.has(target.jobId)
      || addresses.has(csvAddress)
      || addresses.has(metadataAddress)
      || csvAddress === metadataAddress
      || (knownBucket !== undefined && knownBucket !== target.bucket)
      || (knownRegion !== undefined && knownRegion !== target.region)
    ) reject("ADDRESS_SET_MISMATCH");
    pairs.add(targetPair);
    jobs.add(target.jobId);
    addresses.add(csvAddress);
    addresses.add(metadataAddress);
    regionBuckets.set(target.region, target.bucket);
    bucketRegions.set(target.bucket, target.region);
    targets.push({ ...target });
  }
  return targets.sort((left, right) =>
    left.region.localeCompare(right.region) || left.exportFamily.localeCompare(right.exportFamily));
}

function configuredLimits(
  value: Partial<ComputeOptimizerExportObjectSetLimits> | undefined,
): ComputeOptimizerExportObjectSetLimits {
  if (value !== undefined && !isRecord(value)) reject("INVALID_INPUT");
  const keys = [
    "maximumConcurrency",
    "maximumCsvBytes",
    "maximumMetadataBytes",
    "maximumAggregateBytes",
  ] as const;
  if (value !== undefined && Object.keys(value).some((key) => !keys.includes(
    key as typeof keys[number],
  ))) reject("INVALID_INPUT");
  const limits = { ...COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS, ...value };
  for (const key of keys) {
    if (
      !Number.isSafeInteger(limits[key])
      || limits[key] < 1
      || limits[key] > COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS[key]
    ) reject("INVALID_INPUT");
  }
  return limits;
}

function currentTime(now: (() => number) | undefined): number {
  const value = now?.() ?? Date.now();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_INPUT");
  return value;
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", copyBytes(bytes).buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectPromise(
      new ComputeOptimizerExportObjectSetError("ABORTED"),
    ));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => rejectPromise(error)),
    );
  });
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function safeReadResult(value: unknown, maximumBytes: number): ComputeOptimizerExportObjectRead {
  if (
    !isRecord(value)
    || !exactKeys(value, ["bytes", "eTag", "versionId"])
    || !(value.bytes instanceof Uint8Array)
    || value.bytes.byteLength < 1
    || typeof value.eTag !== "string"
    || !SAFE_IDENTITY.test(value.eTag)
    || (value.versionId !== null
      && (typeof value.versionId !== "string" || !SAFE_IDENTITY.test(value.versionId)))
  ) reject("OBJECT_IDENTITY_MISMATCH");
  if (value.bytes.byteLength > maximumBytes) reject("LIMIT_EXCEEDED");
  return value as unknown as ComputeOptimizerExportObjectRead;
}

/**
 * Loads and validates one exact, all-or-nothing object set. A failure aborts
 * remaining reads and releases no partial target array.
 */
export async function loadComputeOptimizerExportObjectSet(
  binding: VerifiedComputeOptimizerExportJobBinding,
  reader: ComputeOptimizerExportObjectReader,
  options: LoadComputeOptimizerExportObjectSetOptions = {},
): Promise<LoadedComputeOptimizerExportObjectSet> {
  if (
    typeof reader !== "function"
    || typeof options !== "object"
    || options === null
    || Array.isArray(options)
  ) reject("INVALID_INPUT");
  if (Object.keys(options).some((key) => ![
    "signal",
    "deadlineAtMs",
    "limits",
    "now",
  ].includes(key))) reject("INVALID_INPUT");
  const targets = validateBinding(binding);
  const limits = configuredLimits(options.limits);
  const startedAt = currentTime(options.now);
  if (
    options.signal !== undefined
    && !(options.signal instanceof AbortSignal)
  ) reject("INVALID_INPUT");
  if (
    options.deadlineAtMs !== undefined
    && (!Number.isSafeInteger(options.deadlineAtMs) || options.deadlineAtMs < 0)
  ) reject("INVALID_INPUT");
  if (options.signal?.aborted === true) reject("ABORTED");
  if (options.deadlineAtMs !== undefined && options.deadlineAtMs <= startedAt) {
    reject("DEADLINE_EXCEEDED");
  }
  if (
    startedAt > Number.MAX_SAFE_INTEGER
      - COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumDurationMs
  ) reject("INVALID_INPUT");

  const deadlineAt = Math.min(
    options.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
    startedAt + COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumDurationMs,
  );
  const tasks: ReadTask[] = targets.flatMap((target) => [
    { target, kind: "csv", key: target.objectKey, maximumBytes: limits.maximumCsvBytes },
    { target, kind: "metadata", key: target.metadataKey, maximumBytes: limits.maximumMetadataBytes },
  ]);
  const expectedAddresses = new Set(tasks.map((task) =>
    address(task.target.region, task.target.bucket, task.key)));
  if (expectedAddresses.size !== tasks.length) reject("ADDRESS_SET_MISMATCH");

  const controller = new AbortController();
  let abortKind: "external" | "deadline" | "failure" | null = null;
  const abortFromParent = (): void => {
    if (abortKind === null) abortKind = "external";
    controller.abort();
  };
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    if (abortKind === null) abortKind = "deadline";
    controller.abort();
  }, Math.max(1, deadlineAt - startedAt));

  let nextTask = 0;
  let aggregateBytes = 0;
  let firstFailure: ComputeOptimizerExportObjectSetError | null = null;
  const loadedByAddress = new Map<string, LoadedObject>();
  const sourceViews: Array<{
    readonly buffer: ArrayBufferLike;
    readonly start: number;
    readonly end: number;
  }> = [];

  const assertActive = (): void => {
    if (controller.signal.aborted) {
      reject(abortKind === "deadline" ? "DEADLINE_EXCEEDED" : "ABORTED");
    }
  };

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = nextTask;
      nextTask += 1;
      if (index >= tasks.length) return;
      const task = tasks[index]!;
      const taskAddress = address(task.target.region, task.target.bucket, task.key);
      try {
        let unsafe: unknown;
        try {
          unsafe = await withAbort(
            Promise.resolve().then(() => reader(
              task.target.region,
              task.target.bucket,
              task.key,
              task.maximumBytes,
              controller.signal,
            )),
            controller.signal,
          );
        } catch {
          if (controller.signal.aborted) {
            reject(abortKind === "deadline" ? "DEADLINE_EXCEEDED" : "ABORTED");
          }
          reject("READ_FAILED");
        }
        if (controller.signal.aborted) {
          reject(abortKind === "deadline" ? "DEADLINE_EXCEEDED" : "ABORTED");
        }
        const source = safeReadResult(unsafe, task.maximumBytes);
        const eTag = source.eTag;
        const versionId = source.versionId;
        const start = source.bytes.byteOffset;
        const end = start + source.bytes.byteLength;
        if (sourceViews.some((view) =>
          view.buffer === source.bytes.buffer && start < view.end && end > view.start)) {
          reject("OBJECT_IDENTITY_MISMATCH");
        }
        sourceViews.push({ buffer: source.bytes.buffer, start, end });
        const bytes = copyBytes(source.bytes);
        aggregateBytes += bytes.byteLength;
        if (aggregateBytes > limits.maximumAggregateBytes) reject("LIMIT_EXCEEDED");
        const objectSha256 = await sha256(bytes);
        if (
          (unsafe as ComputeOptimizerExportObjectRead).eTag !== eTag
          || (unsafe as ComputeOptimizerExportObjectRead).versionId !== versionId
          || !sameBytes(source.bytes, bytes)
        ) reject("OBJECT_MUTATED");
        loadedByAddress.set(taskAddress, {
          source,
          bytes,
          identity: {
            key: task.key,
            eTag,
            versionId,
            bytes: bytes.byteLength,
            sha256: objectSha256,
          },
        });
      } catch (error) {
        const safe = error instanceof ComputeOptimizerExportObjectSetError
          ? error
          : new ComputeOptimizerExportObjectSetError("READ_FAILED");
        if (firstFailure === null) firstFailure = safe;
        if (abortKind === null) abortKind = "failure";
        controller.abort();
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from(
      { length: Math.min(limits.maximumConcurrency, tasks.length) },
      worker,
    ));
    if (firstFailure !== null) throw firstFailure;
    if (controller.signal.aborted) {
      reject(abortKind === "deadline" ? "DEADLINE_EXCEEDED" : "ABORTED");
    }
    if (
      loadedByAddress.size !== expectedAddresses.size
      || [...loadedByAddress.keys()].some((key) => !expectedAddresses.has(key))
    ) reject("ADDRESS_SET_MISMATCH");

    const bundles: LoadedComputeOptimizerExportTargetBundle[] = [];
    for (const target of targets) {
      assertActive();
      const csv = loadedByAddress.get(address(target.region, target.bucket, target.objectKey));
      const metadata = loadedByAddress.get(address(
        target.region,
        target.bucket,
        target.metadataKey,
      ));
      if (csv === undefined || metadata === undefined) reject("ADDRESS_SET_MISMATCH");
      let parsed: ParsedComputeOptimizerExport;
      try {
        parsed = await parseComputeOptimizerExport({
          metadataBytes: metadata.bytes,
          csvBytes: csv.bytes,
          trustedCsvBasename: basename(target.objectKey),
          limits: {
            maximumMetadataBytes: limits.maximumMetadataBytes,
            maximumCsvBytes: limits.maximumCsvBytes,
          },
        });
      } catch (error) {
        if (
          error instanceof ComputeOptimizerExportParserError
          && error.code === "URL_MISMATCH"
        ) reject("ADDRESS_SET_MISMATCH");
        reject("PARSE_REJECTED");
      }
      const [csvSha256, metadataSha256] = await Promise.all([
        sha256(csv.bytes),
        sha256(metadata.bytes),
      ]);
      assertActive();
      if (
        parsed.csvBasename !== basename(target.objectKey)
        || parsed.objectSha256 !== csv.identity.sha256
        || parsed.metadataSha256 !== metadata.identity.sha256
        || csvSha256 !== csv.identity.sha256
        || metadataSha256 !== metadata.identity.sha256
        || csv.source.eTag !== csv.identity.eTag
        || csv.source.versionId !== csv.identity.versionId
        || metadata.source.eTag !== metadata.identity.eTag
        || metadata.source.versionId !== metadata.identity.versionId
        || !sameBytes(csv.source.bytes, csv.bytes)
        || !sameBytes(metadata.source.bytes, metadata.bytes)
      ) reject("OBJECT_MUTATED");
      bundles.push({
        region: target.region,
        exportFamily: target.exportFamily,
        providerResourceType: target.providerResourceType,
        requestSha256: target.requestSha256,
        jobId: target.jobId,
        bucket: target.bucket,
        csvObject: csv.identity,
        metadataObject: metadata.identity,
        parsed,
      });
    }

    assertActive();
    const finishedAt = currentTime(options.now);
    if (finishedAt < startedAt) reject("INVALID_INPUT");
    if (finishedAt >= deadlineAt) reject("DEADLINE_EXCEEDED");

    return deepFreeze({
      schemaVersion: "sutra.compute-optimizer-export-object-set.v1",
      planId: binding.planId,
      planContentSha256: binding.contentSha256,
      aggregateBytes,
      targets: bundles,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
