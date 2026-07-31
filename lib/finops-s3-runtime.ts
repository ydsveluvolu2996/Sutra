/**
 * Production runtime adapters for the pure FinOps S3 ingestion orchestrator.
 *
 * The adapters are deliberately credential- and scheduler-agnostic. A caller
 * injects an already configured AWS SDK-compatible client. Requests are
 * restricted to one exact tenant scope, bucket, and key prefix; there is no
 * alternate key, local content, retry source, or network fallback.
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { FinopsBillingScope } from "../db/finops-billing-engine-repository.ts";
import type {
  FinopsGzipDecompressor,
  FinopsS3IngestionDependencies,
  FinopsS3ObjectReader,
} from "./finops-s3-ingestion.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BUCKET =
  /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/u;
const MAX_KEY_BYTES = 1_024;
const MAX_SAFE_LIMIT = 2_147_483_647;
const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

export interface FinopsS3GetObjectOutput {
  readonly Body?: unknown;
  readonly ContentLength?: number;
}

export interface FinopsS3GetObjectClient {
  send(
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<FinopsS3GetObjectOutput>;
}

export interface FinopsS3RuntimeBoundary {
  readonly scope: Readonly<FinopsBillingScope>;
  readonly bucket: string;
  /** Must end in "/" so similarly named sibling prefixes cannot match. */
  readonly prefix: string;
}

export interface FinopsS3RuntimeConfiguration
  extends FinopsS3RuntimeBoundary {
  readonly client: FinopsS3GetObjectClient;
}

export type FinopsS3RuntimeFailureCode =
  | "INVALID_CONFIGURATION"
  | "REQUEST_SCOPE_MISMATCH"
  | "REQUEST_BUCKET_MISMATCH"
  | "REQUEST_PREFIX_MISMATCH"
  | "INVALID_BYTE_LIMIT"
  | "S3_GET_OBJECT_FAILED"
  | "MISSING_STREAM_BODY"
  | "INVALID_STREAM_BODY"
  | "COMPRESSED_STREAM_FAILED"
  | "COMPRESSED_LIMIT_EXCEEDED"
  | "INVALID_GZIP"
  | "DECOMPRESSION_UNAVAILABLE"
  | "DECOMPRESSION_FAILED"
  | "UNCOMPRESSED_LIMIT_EXCEEDED";

export class FinopsS3RuntimeError extends Error {
  public readonly code: FinopsS3RuntimeFailureCode;

  public constructor(code: FinopsS3RuntimeFailureCode) {
    super("FinOps S3 runtime rejected");
    this.name = "FinopsS3RuntimeError";
    this.code = code;
  }
}

interface WebReader {
  read(): Promise<
    | { readonly done: true; readonly value?: undefined }
    | { readonly done: false; readonly value: unknown }
  >;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

interface WebStreamLike {
  getReader(): WebReader;
}

interface AsyncIteratorLike {
  next(): Promise<IteratorResult<unknown>>;
  return?(): Promise<IteratorResult<unknown>>;
}

interface AsyncIterableLike {
  [Symbol.asyncIterator](): AsyncIteratorLike;
}

function runtimeError(code: FinopsS3RuntimeFailureCode): never {
  throw new FinopsS3RuntimeError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function validKey(value: unknown, requireTrailingSlash = false): value is string {
  if (
    !validText(value, MAX_KEY_BYTES)
    || value.startsWith("/")
    || value.includes("\\")
    || (requireTrailingSlash && !value.endsWith("/"))
  ) return false;
  return !value.split("/").some((part) => part === "." || part === "..");
}

function validScope(value: unknown): value is FinopsBillingScope {
  return isRecord(value)
    && typeof value.orgId === "string"
    && IDENTIFIER.test(value.orgId)
    && typeof value.customerId === "string"
    && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string"
    && CONNECTION_ID.test(value.connectionId);
}

function sameScope(
  left: FinopsBillingScope,
  right: FinopsBillingScope,
): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function validBoundary(
  value: unknown,
): value is FinopsS3RuntimeBoundary {
  return isRecord(value)
    && validScope(value.scope)
    && typeof value.bucket === "string"
    && BUCKET.test(value.bucket)
    && validKey(value.prefix, true);
}

function validLimit(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SAFE_LIMIT;
}

function assertAddress(
  boundary: FinopsS3RuntimeBoundary,
  request: {
    readonly scope: Readonly<FinopsBillingScope>;
    readonly bucket: string;
    readonly key: string;
  },
): void {
  if (!validScope(request.scope) || !sameScope(boundary.scope, request.scope)) {
    runtimeError("REQUEST_SCOPE_MISMATCH");
  }
  if (request.bucket !== boundary.bucket) {
    runtimeError("REQUEST_BUCKET_MISMATCH");
  }
  if (
    !validKey(request.key)
    || !request.key.startsWith(boundary.prefix)
    || request.key.length === boundary.prefix.length
  ) runtimeError("REQUEST_PREFIX_MISMATCH");
}

function asWebStream(value: unknown): WebStreamLike | null {
  if (!isRecord(value) || typeof value.getReader !== "function") return null;
  return value as unknown as WebStreamLike;
}

function asAsyncIterable(value: unknown): AsyncIterableLike | null {
  if (
    (typeof value !== "object" && typeof value !== "function")
    || value === null
  ) return null;
  const iterator = (value as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ];
  return typeof iterator === "function"
    ? value as AsyncIterableLike
    : null;
}

function byteChunk(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function concatenate(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBoundedWebStream(
  stream: WebStreamLike,
  maximumBytes: number,
  limitCode:
    | "COMPRESSED_LIMIT_EXCEEDED"
    | "UNCOMPRESSED_LIMIT_EXCEEDED",
  failureCode: "COMPRESSED_STREAM_FAILED" | "DECOMPRESSION_FAILED",
  abort?: () => void,
): Promise<Uint8Array> {
  let reader: WebReader;
  try {
    reader = stream.getReader();
  } catch {
    runtimeError("INVALID_STREAM_BODY");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const current = await reader.read();
      if (current.done) break;
      const chunk = byteChunk(current.value);
      if (chunk === null) runtimeError("INVALID_STREAM_BODY");
      if (chunk.byteLength > maximumBytes - totalBytes) {
        abort?.();
        try {
          await reader.cancel?.();
        } catch {
          // Preserve the deterministic byte-limit failure.
        }
        runtimeError(limitCode);
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof FinopsS3RuntimeError) {
      abort?.();
      try {
        await reader.cancel?.();
      } catch {
        // Preserve the deterministic validation or byte-limit failure.
      }
      throw error;
    }
    abort?.();
    try {
      await reader.cancel?.();
    } catch {
      // Preserve the deterministic stream failure.
    }
    runtimeError(failureCode);
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // Lock release does not change the already determined result.
    }
  }
  return concatenate(chunks, totalBytes);
}

async function readBoundedAsyncIterable(
  stream: AsyncIterableLike,
  maximumBytes: number,
  abort: () => void,
): Promise<Uint8Array> {
  let iterator: AsyncIteratorLike;
  try {
    iterator = stream[Symbol.asyncIterator]();
  } catch {
    runtimeError("INVALID_STREAM_BODY");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const current = await iterator.next();
      if (current.done) break;
      const chunk = byteChunk(current.value);
      if (chunk === null) runtimeError("INVALID_STREAM_BODY");
      if (chunk.byteLength > maximumBytes - totalBytes) {
        abort();
        try {
          await iterator.return?.();
        } catch {
          // Preserve the deterministic byte-limit failure.
        }
        runtimeError("COMPRESSED_LIMIT_EXCEEDED");
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof FinopsS3RuntimeError) {
      abort();
      try {
        await iterator.return?.();
      } catch {
        // Preserve the deterministic validation or byte-limit failure.
      }
      throw error;
    }
    abort();
    try {
      await iterator.return?.();
    } catch {
      // Preserve the deterministic stream failure.
    }
    runtimeError("COMPRESSED_STREAM_FAILED");
  }
  return concatenate(chunks, totalBytes);
}

function immutableBoundary(
  value: FinopsS3RuntimeBoundary,
): FinopsS3RuntimeBoundary {
  if (!validBoundary(value)) runtimeError("INVALID_CONFIGURATION");
  return {
    scope: {
      orgId: value.scope.orgId,
      customerId: value.scope.customerId,
      connectionId: value.scope.connectionId,
    },
    bucket: value.bucket,
    prefix: value.prefix,
  };
}

/**
 * Build an exact-address GetObject reader around an injected AWS SDK client.
 */
export function createFinopsS3ObjectReader(
  configuration: FinopsS3RuntimeConfiguration,
): FinopsS3ObjectReader {
  if (
    !isRecord(configuration)
    || !validBoundary(configuration)
    || !isRecord(configuration.client)
    || typeof configuration.client.send !== "function"
  ) runtimeError("INVALID_CONFIGURATION");
  const boundary = immutableBoundary(configuration);
  const client = configuration.client;
  return async (request) => {
    assertAddress(boundary, request);
    if (!validLimit(request.maximumCompressedBytes)) {
      runtimeError("INVALID_BYTE_LIMIT");
    }
    const controller = new AbortController();
    let received: unknown;
    try {
      received = await client.send(
        new GetObjectCommand({
          Bucket: request.bucket,
          Key: request.key,
        }),
        { abortSignal: controller.signal },
      );
    } catch {
      runtimeError("S3_GET_OBJECT_FAILED");
    }
    if (!isRecord(received)) runtimeError("INVALID_STREAM_BODY");
    const contentLength = received.ContentLength;
    if (
      contentLength !== undefined
      && (
        typeof contentLength !== "number"
        || !Number.isSafeInteger(contentLength)
        || contentLength < 0
      )
    ) runtimeError("INVALID_STREAM_BODY");
    if (
      typeof contentLength === "number"
      && contentLength > request.maximumCompressedBytes
    ) {
      controller.abort();
      runtimeError("COMPRESSED_LIMIT_EXCEEDED");
    }
    const body = received.Body;
    if (body === undefined || body === null) {
      controller.abort();
      runtimeError("MISSING_STREAM_BODY");
    }
    const web = asWebStream(body);
    if (web !== null) {
      return readBoundedWebStream(
        web,
        request.maximumCompressedBytes,
        "COMPRESSED_LIMIT_EXCEEDED",
        "COMPRESSED_STREAM_FAILED",
        () => controller.abort(),
      );
    }
    const iterable = asAsyncIterable(body);
    if (iterable !== null) {
      return readBoundedAsyncIterable(
        iterable,
        request.maximumCompressedBytes,
        () => controller.abort(),
      );
    }
    controller.abort();
    runtimeError("INVALID_STREAM_BODY");
  };
}

/**
 * Build a Web DecompressionStream gzip adapter with a hard output ceiling.
 */
export function createFinopsGzipDecompressor(
  configuredBoundary: FinopsS3RuntimeBoundary,
): FinopsGzipDecompressor {
  const boundary = immutableBoundary(configuredBoundary);
  return async (request) => {
    assertAddress(boundary, {
      scope: request.scope,
      bucket: request.object.bucket,
      key: request.object.key,
    });
    if (!validLimit(request.maximumOutputBytes)) {
      runtimeError("INVALID_BYTE_LIMIT");
    }
    if (
      !(request.compressed instanceof Uint8Array)
      || request.compressed.byteLength < 2
      || request.compressed[0] !== GZIP_MAGIC_FIRST
      || request.compressed[1] !== GZIP_MAGIC_SECOND
    ) runtimeError("INVALID_GZIP");
    if (typeof globalThis.DecompressionStream !== "function") {
      runtimeError("DECOMPRESSION_UNAVAILABLE");
    }

    let decompressed: ReadableStream<Uint8Array>;
    try {
      const compressed = new Uint8Array(request.compressed.byteLength);
      compressed.set(request.compressed);
      const source = new ReadableStream<BufferSource>({
        start(controller) {
          controller.enqueue(compressed);
          controller.close();
        },
      });
      decompressed = source.pipeThrough(new DecompressionStream("gzip"));
    } catch {
      runtimeError("DECOMPRESSION_FAILED");
    }
    return readBoundedWebStream(
      decompressed as unknown as WebStreamLike,
      request.maximumOutputBytes,
      "UNCOMPRESSED_LIMIT_EXCEEDED",
      "DECOMPRESSION_FAILED",
    );
  };
}

/**
 * Convenience composition for the two dependency slots owned by the runtime.
 */
export function createFinopsS3Runtime(
  configuration: FinopsS3RuntimeConfiguration,
): Pick<
  FinopsS3IngestionDependencies,
  "readObject" | "decompressGzip"
> {
  return {
    readObject: createFinopsS3ObjectReader(configuration),
    decompressGzip: createFinopsGzipDecompressor(configuration),
  };
}
