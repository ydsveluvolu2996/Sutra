/**
 * App-side exact-object assembler for sealed AWS Compute Optimizer exports.
 *
 * The transport is the signed pilot-server broker boundary. This module never
 * receives AWS credentials and cannot list or address any object that was not
 * fixed by the caller before the read began.
 */
import { Buffer } from "node:buffer";

import type {
  ComputeOptimizerExportObjectChunkRequest,
  ComputeOptimizerExportObjectChunkResponse,
} from "../services/aws-collector/src/compute-optimizer-export-object-chunk.ts";
import type {
  ComputeOptimizerExportObjectReader,
} from "./finops-compute-optimizer-export-object-set.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const ETAG = /^(?:"[A-Fa-f0-9]{32,128}(?:-\d{1,8})?"|[A-Fa-f0-9]{32,128}(?:-\d{1,8})?)$/u;
const SAFE_VERSION_ID = /^[^\u0000-\u0020\u007f<>]{1,1024}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_KEY_BYTES = 1_024;
const MAX_BOUND_OBJECTS = 512;
const CHUNK_BYTES = 4 * 1_024 * 1_024;
// Pinned to COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumCsvBytes.
const MAX_OBJECT_BYTES = 256 * 1_024 * 1_024;
const MAX_BASE64_BYTES = Math.ceil(CHUNK_BYTES / 3) * 4;
const MAXIMUM_DURATION_MS = 10 * 60 * 1_000;

export interface ComputeOptimizerExportObjectBoundary {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
  readonly plannedJobId: string;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
}

export interface ComputeOptimizerExportObjectChunkTransport {
  readChunk(
    request: ComputeOptimizerExportObjectChunkRequest,
    context: {
      readonly signal: AbortSignal;
      /** Absolute Unix epoch deadline shared by every chunk in this read. */
      readonly deadlineAtMs: number;
    },
  ): Promise<unknown>;
}

export interface ComputeOptimizerExportObjectReaderOptions {
  /** Absolute Unix epoch deadline. A built-in ten-minute ceiling still applies. */
  readonly deadlineAtMs?: number;
  /** Testable clock; must return a safe non-negative integer. */
  readonly now?: () => number;
}

export class ComputeOptimizerExportObjectReaderError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "ADDRESS_NOT_BOUND"
    | "INVALID_BYTE_LIMIT"
    | "BROKER_RESPONSE_INVALID"
    | "OBJECT_CHANGED"
    | "OBJECT_LIMIT_EXCEEDED"
    | "CHUNK_READ_FAILED"
    | "ABORTED"
    | "DEADLINE_EXCEEDED";

  public constructor(code: ComputeOptimizerExportObjectReaderError["code"]) {
    super("Compute Optimizer export object read rejected");
    this.name = "ComputeOptimizerExportObjectReaderError";
    this.code = code;
  }
}

type FixedBoundary = Readonly<ComputeOptimizerExportObjectBoundary>;

function reject(code: ComputeOptimizerExportObjectReaderError["code"]): never {
  throw new ComputeOptimizerExportObjectReaderError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validKey(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES
    || value.startsWith("/")
    || /[%\\*?\u0000]/u.test(value)
  ) return false;
  return !value.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function validBoundary(value: unknown): value is ComputeOptimizerExportObjectBoundary {
  return isRecord(value)
    && exactKeys(value, [
      "tenantId", "connectionId", "jobId", "contractId", "plannedJobId",
      "region", "bucket", "key",
    ])
    && typeof value.tenantId === "string" && IDENTIFIER.test(value.tenantId)
    && typeof value.connectionId === "string" && CONNECTION_ID.test(value.connectionId)
    && typeof value.jobId === "string" && IDENTIFIER.test(value.jobId)
    && typeof value.contractId === "string" && IDENTIFIER.test(value.contractId)
    && typeof value.plannedJobId === "string" && JOB_ID.test(value.plannedJobId)
    && typeof value.region === "string" && REGION.test(value.region)
    && typeof value.bucket === "string" && BUCKET.test(value.bucket)
    && validKey(value.key);
}

function objectAddress(region: string, bucket: string, key: string): string {
  return `${region}\u0000${bucket}\u0000${key}`;
}

function readNow(now: (() => number) | undefined): number {
  const value = (now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_CONFIGURATION");
  return value;
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length < 4
    || value.length > MAX_BASE64_BYTES
    || value.length % 4 !== 0
  ) reject("BROKER_RESPONSE_INVALID");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (!(
      (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47
    )) reject("BROKER_RESPONSE_INVALID");
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) reject("BROKER_RESPONSE_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) reject("BROKER_RESPONSE_INVALID");
  return new Uint8Array(decoded);
}

async function sha256(value: Uint8Array): Promise<string> {
  const copy = new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function parseIdentity(value: unknown): {
  readonly eTag: string;
  readonly versionId: string | null;
} {
  if (!isRecord(value) || typeof value.kind !== "string") {
    reject("BROKER_RESPONSE_INVALID");
  }
  if (
    value.kind === "VERSION"
    && exactKeys(value, ["kind", "versionId", "eTag"])
    && typeof value.versionId === "string"
    && SAFE_VERSION_ID.test(value.versionId)
    && typeof value.eTag === "string"
    && ETAG.test(value.eTag)
  ) return { versionId: value.versionId, eTag: value.eTag };
  if (
    value.kind === "ETAG"
    && exactKeys(value, ["kind", "versionId", "eTag"])
    && value.versionId === null
    && typeof value.eTag === "string"
    && ETAG.test(value.eTag)
  ) return { versionId: null, eTag: value.eTag };
  reject("BROKER_RESPONSE_INVALID");
}

function exactResponse(value: unknown): value is ComputeOptimizerExportObjectChunkResponse {
  return isRecord(value) && exactKeys(value, [
    "schema", "tenantId", "connectionId", "jobId", "contractId", "plannedJobId",
    "region", "bucket", "key", "offset", "totalBytes", "bytesRead", "complete",
    "identity", "sha256", "bodyBase64",
  ]);
}

async function assemble(
  fixed: FixedBoundary,
  maximumBytes: number,
  deadlineAtMs: number,
  signal: AbortSignal,
  transport: ComputeOptimizerExportObjectChunkTransport,
): Promise<{ readonly bytes: Uint8Array; readonly eTag: string; readonly versionId: string | null }> {
  let offset = 0;
  let totalBytes: number | null = null;
  let identity: { readonly eTag: string; readonly versionId: string | null } | null = null;
  let destination: Uint8Array | null = null;
  const maximumChunks = Math.ceil(maximumBytes / CHUNK_BYTES);

  for (let index = 0; index < maximumChunks; index += 1) {
    if (signal.aborted) reject("ABORTED");
    const requestedBytes = Math.min(CHUNK_BYTES, maximumBytes - offset);
    if (requestedBytes < 1) reject("OBJECT_LIMIT_EXCEEDED");
    const request: ComputeOptimizerExportObjectChunkRequest = {
      ...fixed,
      offset,
      maximumBytes: requestedBytes,
      versionId: identity?.versionId ?? null,
      ifMatch: identity !== null && identity.versionId === null ? identity.eTag : null,
    };
    let candidate: unknown;
    try {
      candidate = await transport.readChunk(request, { signal, deadlineAtMs });
    } catch (error) {
      if (signal.aborted) reject("ABORTED");
      if (error instanceof ComputeOptimizerExportObjectReaderError) throw error;
      reject("CHUNK_READ_FAILED");
    }
    if (!exactResponse(candidate)) reject("BROKER_RESPONSE_INVALID");
    const response = candidate;
    if (
      response.schema !== "sutra.compute-optimizer-export-object-chunk.v1"
      || response.tenantId !== fixed.tenantId
      || response.connectionId !== fixed.connectionId
      || response.jobId !== fixed.jobId
      || response.contractId !== fixed.contractId
      || response.plannedJobId !== fixed.plannedJobId
      || response.region !== fixed.region
      || response.bucket !== fixed.bucket
      || response.key !== fixed.key
      || response.offset !== offset
      || !Number.isSafeInteger(response.totalBytes)
      || response.totalBytes < 1
      || response.totalBytes > maximumBytes
      || !Number.isSafeInteger(response.bytesRead)
      || response.bytesRead < 1
      || response.bytesRead > requestedBytes
      || typeof response.complete !== "boolean"
      || typeof response.sha256 !== "string"
      || !SHA256.test(response.sha256)
      || typeof response.bodyBase64 !== "string"
    ) reject("BROKER_RESPONSE_INVALID");
    const returnedIdentity = parseIdentity(response.identity);
    if (identity === null) {
      identity = returnedIdentity;
      totalBytes = response.totalBytes;
      destination = new Uint8Array(totalBytes);
    } else if (
      response.totalBytes !== totalBytes
      || returnedIdentity.eTag !== identity.eTag
      || returnedIdentity.versionId !== identity.versionId
    ) reject("OBJECT_CHANGED");

    const bytes = decodeBase64(response.bodyBase64);
    if (
      bytes.byteLength !== response.bytesRead
      || await sha256(bytes) !== response.sha256
      || offset > destination!.byteLength - bytes.byteLength
    ) reject("BROKER_RESPONSE_INVALID");
    destination!.set(bytes, offset);
    const nextOffset = offset + bytes.byteLength;
    const isActuallyComplete = nextOffset === totalBytes;
    if (response.complete !== isActuallyComplete) reject("BROKER_RESPONSE_INVALID");
    if (!response.complete && response.bytesRead !== requestedBytes) {
      reject("BROKER_RESPONSE_INVALID");
    }
    if (response.complete) {
      return {
        bytes: new Uint8Array(destination!),
        eTag: identity.eTag,
        versionId: identity.versionId,
      };
    }
    if (nextOffset <= offset || nextOffset >= totalBytes!) reject("BROKER_RESPONSE_INVALID");
    offset = nextOffset;
  }
  reject("OBJECT_LIMIT_EXCEEDED");
}

function hardRace<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  deadlineAtMs: number,
  now: (() => number) | undefined,
): Promise<T> {
  return new Promise<T>((resolve, rejectPromise) => {
    const controller = new AbortController();
    let settled = false;
    const timer: { current?: ReturnType<typeof setTimeout> } = {};
    const finish = (result: { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      if (timer.current !== undefined) clearTimeout(timer.current);
      parentSignal.removeEventListener("abort", onAbort);
      if (!result.ok) controller.abort();
      if (result.ok) resolve(result.value);
      else rejectPromise(result.error);
    };
    const onAbort = (): void => finish({
      ok: false,
      error: new ComputeOptimizerExportObjectReaderError("ABORTED"),
    });
    if (parentSignal.aborted) {
      onAbort();
      return;
    }
    const remaining = deadlineAtMs - readNow(now);
    if (remaining <= 0) {
      finish({
        ok: false,
        error: new ComputeOptimizerExportObjectReaderError("DEADLINE_EXCEEDED"),
      });
      return;
    }
    parentSignal.addEventListener("abort", onAbort, { once: true });
    timer.current = setTimeout(() => finish({
      ok: false,
      error: new ComputeOptimizerExportObjectReaderError("DEADLINE_EXCEEDED"),
    }), remaining);
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish({ ok: true, value }),
        (error: unknown) => finish({ ok: false, error }),
      );
  });
}

/**
 * Creates an object-set-compatible reader over an immutable set of exact CSV
 * and metadata addresses. Unknown keys are rejected before the signed broker
 * transport is called.
 */
export function createComputeOptimizerExportObjectReader(
  boundaries: readonly ComputeOptimizerExportObjectBoundary[],
  transport: ComputeOptimizerExportObjectChunkTransport,
  options: ComputeOptimizerExportObjectReaderOptions = {},
): ComputeOptimizerExportObjectReader {
  if (
    !Array.isArray(boundaries)
    || boundaries.length < 1
    || boundaries.length > MAX_BOUND_OBJECTS
    || !boundaries.every(validBoundary)
    || !isRecord(transport)
    || typeof transport.readChunk !== "function"
    || typeof options !== "object"
    || options === null
    || Array.isArray(options)
    || Object.keys(options).some((key) => !["deadlineAtMs", "now"].includes(key))
    || (options.deadlineAtMs !== undefined
      && (!Number.isSafeInteger(options.deadlineAtMs) || options.deadlineAtMs < 0))
    || (options.now !== undefined && typeof options.now !== "function")
  ) reject("INVALID_CONFIGURATION");
  const configuredDeadlineAtMs = options.deadlineAtMs;
  const configuredNow = options.now;

  const byAddress = new Map<string, FixedBoundary>();
  for (const boundary of boundaries) {
    const fixed = Object.freeze({ ...boundary });
    const address = objectAddress(fixed.region, fixed.bucket, fixed.key);
    if (byAddress.has(address)) reject("INVALID_CONFIGURATION");
    byAddress.set(address, fixed);
  }

  return async (region, bucket, key, maximumBytes, signal) => {
    if (!(signal instanceof AbortSignal)) reject("INVALID_CONFIGURATION");
    const fixed = byAddress.get(objectAddress(region, bucket, key));
    if (fixed === undefined) reject("ADDRESS_NOT_BOUND");
    if (
      !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1
      || maximumBytes > MAX_OBJECT_BYTES
    ) reject("INVALID_BYTE_LIMIT");
    const startedAt = readNow(configuredNow);
    const builtInDeadline = startedAt + MAXIMUM_DURATION_MS;
    if (!Number.isSafeInteger(builtInDeadline)) reject("INVALID_CONFIGURATION");
    const deadlineAtMs = Math.min(configuredDeadlineAtMs ?? builtInDeadline, builtInDeadline);
    return hardRace(
      (operationSignal) => assemble(
        fixed, maximumBytes, deadlineAtMs, operationSignal, transport,
      ),
      signal,
      deadlineAtMs,
      configuredNow,
    );
  };
}
