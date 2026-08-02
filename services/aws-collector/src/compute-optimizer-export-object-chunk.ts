/**
 * Broker-private, bounded S3 range reader for one sealed Compute Optimizer
 * CSV/CSVW object. Temporary credentials never leave this module.
 */
import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import {
  parseComputeOptimizerExportObjectVersionIdentity,
} from "./compute-optimizer-export-object-contract.js";
import type { AwsTemporaryCredentials } from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const ETAG = /^(?:"[A-Fa-f0-9]{32,128}(?:-\d{1,8})?"|[A-Fa-f0-9]{32,128}(?:-\d{1,8})?)$/u;
const MAX_KEY_BYTES = 1_024;
const MAX_OBJECT_OFFSET = 2_147_483_647;

export const COMPUTE_OPTIMIZER_EXPORT_OBJECT_CHUNK_MAX_BYTES = 4 * 1_024 * 1_024;
export const COMPUTE_OPTIMIZER_EXPORT_OBJECT_CHUNK_DEADLINE_MS = 20_000;

export interface ComputeOptimizerExportObjectChunkRequest {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
  readonly plannedJobId: string;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly offset: number;
  readonly maximumBytes: number;
  readonly versionId: string | null;
  readonly ifMatch: string | null;
}

export type ComputeOptimizerExportObjectChunkIdentity =
  | {
      readonly kind: "VERSION";
      readonly versionId: string;
      readonly eTag: string;
    }
  | {
      readonly kind: "ETAG";
      readonly versionId: null;
      readonly eTag: string;
    };

export interface ComputeOptimizerExportObjectChunkResponse {
  readonly schema: "sutra.compute-optimizer-export-object-chunk.v1";
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
  readonly plannedJobId: string;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly offset: number;
  readonly totalBytes: number;
  readonly bytesRead: number;
  readonly complete: boolean;
  readonly identity: ComputeOptimizerExportObjectChunkIdentity;
  readonly sha256: string;
  readonly bodyBase64: string;
}

export interface ComputeOptimizerExportObjectChunkClient {
  send(
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<GetObjectCommandOutput>;
}

export type ComputeOptimizerExportObjectChunkClientFactory = (
  region: string,
  credentials: AwsTemporaryCredentials,
) => ComputeOptimizerExportObjectChunkClient;

export class ComputeOptimizerExportObjectChunkError extends Error {
  public constructor(public readonly code:
    | "INVALID_REQUEST"
    | "OBJECT_READ_FAILED"
    | "OBJECT_CHANGED"
    | "OBJECT_RESPONSE_INVALID"
    | "OBJECT_RANGE_LIMIT_EXCEEDED"
    | "OBJECT_READ_TIMEOUT") {
    super("Compute Optimizer export object chunk request rejected");
    this.name = "ComputeOptimizerExportObjectChunkError";
  }
}

export function parseComputeOptimizerExportObjectChunkRequest(
  body: string,
  pathConnectionId: string,
): ComputeOptimizerExportObjectChunkRequest {
  let candidate: unknown;
  try {
    candidate = JSON.parse(body) as unknown;
  } catch {
    return reject("INVALID_REQUEST");
  }
  const keys = [
    "tenantId", "connectionId", "jobId", "contractId", "plannedJobId",
    "region", "bucket", "key", "offset", "maximumBytes", "versionId", "ifMatch",
  ] as const;
  if (!exactRecord(candidate, keys)) reject("INVALID_REQUEST");
  const request = candidate;
  if (
    typeof request.tenantId !== "string" || !IDENTIFIER.test(request.tenantId) ||
    typeof request.connectionId !== "string" || !CONNECTION_ID.test(request.connectionId) ||
    request.connectionId !== pathConnectionId ||
    typeof request.jobId !== "string" || !IDENTIFIER.test(request.jobId) ||
    typeof request.contractId !== "string" || !IDENTIFIER.test(request.contractId) ||
    typeof request.plannedJobId !== "string" || !JOB_ID.test(request.plannedJobId) ||
    typeof request.region !== "string" || !REGION.test(request.region) ||
    typeof request.bucket !== "string" || !BUCKET.test(request.bucket) ||
    !validKey(request.key) ||
    !Number.isSafeInteger(request.offset) ||
    (request.offset as number) < 0 ||
    (request.offset as number) > MAX_OBJECT_OFFSET ||
    !Number.isSafeInteger(request.maximumBytes) ||
    (request.maximumBytes as number) < 1 ||
    (request.maximumBytes as number) > COMPUTE_OPTIMIZER_EXPORT_OBJECT_CHUNK_MAX_BYTES ||
    !validVersionId(request.versionId) ||
    (request.ifMatch !== null &&
      (typeof request.ifMatch !== "string" || !ETAG.test(request.ifMatch))) ||
    ((request.offset as number) === 0
      ? request.versionId !== null || request.ifMatch !== null
      : (request.versionId === null) === (request.ifMatch === null))
  ) reject("INVALID_REQUEST");
  return request as unknown as ComputeOptimizerExportObjectChunkRequest;
}

export async function readComputeOptimizerExportObjectChunk(
  request: ComputeOptimizerExportObjectChunkRequest,
  credentials: AwsTemporaryCredentials,
  clientFactory: ComputeOptimizerExportObjectChunkClientFactory,
  deadlineMs = COMPUTE_OPTIMIZER_EXPORT_OBJECT_CHUNK_DEADLINE_MS,
): Promise<ComputeOptimizerExportObjectChunkResponse> {
  const exact = parseComputeOptimizerExportObjectChunkRequest(
    JSON.stringify(request),
    request.connectionId,
  );
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
    reject("INVALID_REQUEST");
  }
  const end = exact.offset + exact.maximumBytes - 1;
  if (!Number.isSafeInteger(end) || end > MAX_OBJECT_OFFSET) reject("INVALID_REQUEST");
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, rejectPromise) => {
    timer = setTimeout(() => {
      controller.abort();
      rejectPromise(new ComputeOptimizerExportObjectChunkError("OBJECT_READ_TIMEOUT"));
    }, deadlineMs);
  });
  try {
    return await Promise.race([
      executeRead(exact, credentials, clientFactory, controller, end),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function executeRead(
  request: ComputeOptimizerExportObjectChunkRequest,
  credentials: AwsTemporaryCredentials,
  clientFactory: ComputeOptimizerExportObjectChunkClientFactory,
  controller: AbortController,
  end: number,
): Promise<ComputeOptimizerExportObjectChunkResponse> {
  const client = clientFactory(request.region, credentials);
  let output: GetObjectCommandOutput;
  try {
    output = await client.send(new GetObjectCommand({
      Bucket: request.bucket,
      Key: request.key,
      Range: `bytes=${request.offset}-${end}`,
      ...(request.versionId === null ? {} : { VersionId: request.versionId }),
      ...(request.ifMatch === null ? {} : { IfMatch: request.ifMatch }),
    }), { abortSignal: controller.signal });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (new Set(["PreconditionFailed", "NoSuchVersion", "InvalidObjectState"]).has(name)) {
      reject("OBJECT_CHANGED");
    }
    reject("OBJECT_READ_FAILED");
  }
  const range = parseContentRange(output.ContentRange);
  const contentLength = output.ContentLength;
  if (
    range === null || range.start !== request.offset ||
    typeof contentLength !== "number" || !Number.isSafeInteger(contentLength) ||
    contentLength < 1 || contentLength > request.maximumBytes ||
    range.end - range.start + 1 !== contentLength
  ) {
    controller.abort();
    reject("OBJECT_RESPONSE_INVALID");
  }
  const bytes = await readBoundedBody(output.Body, request.maximumBytes, controller);
  if (bytes.byteLength !== contentLength) reject("OBJECT_RESPONSE_INVALID");
  const outputVersionId = normalizeVersionId(output.VersionId);
  const outputEtag = normalizeEtag(output.ETag);
  if (
    (output.VersionId !== undefined && outputVersionId === null) ||
    (output.ETag !== undefined && outputEtag === null)
  ) reject("OBJECT_RESPONSE_INVALID");
  let identity: ComputeOptimizerExportObjectChunkIdentity;
  if (request.versionId !== null) {
    if (outputVersionId !== request.versionId || outputEtag === null) reject("OBJECT_CHANGED");
    identity = { kind: "VERSION", versionId: request.versionId, eTag: outputEtag };
  } else if (request.ifMatch !== null) {
    if (outputEtag === null || stripQuotes(outputEtag) !== stripQuotes(request.ifMatch)) {
      reject("OBJECT_CHANGED");
    }
    identity = { kind: "ETAG", versionId: null, eTag: outputEtag };
  } else if (outputVersionId !== null && outputEtag !== null) {
    identity = { kind: "VERSION", versionId: outputVersionId, eTag: outputEtag };
  } else if (outputEtag !== null) {
    identity = { kind: "ETAG", versionId: null, eTag: outputEtag };
  } else {
    reject("OBJECT_RESPONSE_INVALID");
  }
  return {
    schema: "sutra.compute-optimizer-export-object-chunk.v1",
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    jobId: request.jobId,
    contractId: request.contractId,
    plannedJobId: request.plannedJobId,
    region: request.region,
    bucket: request.bucket,
    key: request.key,
    offset: request.offset,
    totalBytes: range.total,
    bytesRead: bytes.byteLength,
    complete: range.end + 1 === range.total,
    identity,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bodyBase64: Buffer.from(bytes).toString("base64"),
  };
}

async function readBoundedBody(
  body: unknown,
  maximumBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  if ((typeof body !== "object" && typeof body !== "function") || body === null ||
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
    reject("OBJECT_RESPONSE_INVALID");
  }
  const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const current = await iterator.next();
      if (current.done) break;
      if (!(current.value instanceof Uint8Array)) reject("OBJECT_RESPONSE_INVALID");
      if (current.value.byteLength > maximumBytes - total) {
        controller.abort();
        await iterator.return?.().catch(() => undefined);
        reject("OBJECT_RANGE_LIMIT_EXCEEDED");
      }
      const copy = new Uint8Array(current.value);
      chunks.push(copy);
      total += copy.byteLength;
    }
  } catch (error) {
    controller.abort();
    await iterator.return?.().catch(() => undefined);
    if (error instanceof ComputeOptimizerExportObjectChunkError) throw error;
    reject("OBJECT_READ_FAILED");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseContentRange(value: string | undefined): {
  readonly start: number; readonly end: number; readonly total: number;
} | null {
  const match = value === undefined ? null : /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) &&
    Number.isSafeInteger(total) && start >= 0 && end >= start && total >= 1 && end < total
    ? { start, end, total }
    : null;
}

function normalizeEtag(value: string | undefined): string | null {
  return value !== undefined && ETAG.test(value) ? value : null;
}

function normalizeVersionId(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    return parseComputeOptimizerExportObjectVersionIdentity({
      kind: "VERSION",
      versionId: value,
    }).versionId;
  } catch {
    return null;
  }
}

function validVersionId(value: unknown): boolean {
  if (value === null) return true;
  try {
    parseComputeOptimizerExportObjectVersionIdentity({ kind: "VERSION", versionId: value });
    return true;
  } catch {
    return false;
  }
}

function validKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_KEY_BYTES || value.startsWith("/") ||
    /[%\\*?\u0000]/u.test(value)) return false;
  return !value.split("/").some((segment) =>
    segment.length === 0 || segment === "." || segment === ".."
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function stripQuotes(value: string): string {
  return value.replace(/^"|"$/gu, "");
}

function reject(code: ComputeOptimizerExportObjectChunkError["code"]): never {
  throw new ComputeOptimizerExportObjectChunkError(code);
}

export function createAwsComputeOptimizerExportObjectChunkClient(
  region: string,
  credentials: AwsTemporaryCredentials,
): ComputeOptimizerExportObjectChunkClient {
  return new S3Client({ ...workloadIdentityAwsClientConfig(region), credentials });
}
