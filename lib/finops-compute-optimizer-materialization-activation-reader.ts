/**
 * App-side hostile-response boundary for the signed collector activation
 * manifest. The later broker wiring owns authentication; this reader owns
 * exact request/response binding, region completeness, bounds and deadlines.
 */
import type {
  ComputeOptimizerMaterializationActivationManifest,
  ComputeOptimizerMaterializationActivationManifestRegion,
  ComputeOptimizerMaterializationActivationManifestRequest,
} from "../services/aws-collector/src/compute-optimizer-materialization-activation-manifest.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,62}$/u;
const MAX_REGIONS = 50;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAXIMUM_DURATION_MS = 15_000;

export interface ComputeOptimizerMaterializationActivationReaderBoundary {
  readonly request: ComputeOptimizerMaterializationActivationManifestRequest;
  /** Trusted server-side region expectation; never sourced from a browser body. */
  readonly enabledRegions: readonly string[];
}

export interface ComputeOptimizerMaterializationActivationManifestTransport {
  readActivationManifest(
    request: ComputeOptimizerMaterializationActivationManifestRequest,
    context: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

export interface ComputeOptimizerMaterializationActivationReaderOptions {
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
  readonly maximumDurationMs?: number;
  readonly now?: () => number;
}

export class ComputeOptimizerMaterializationActivationReaderError extends Error {
  public constructor(public readonly code:
    | "INVALID_CONFIGURATION"
    | "ABORTED"
    | "DEADLINE_EXCEEDED"
    | "TRANSPORT_FAILED"
    | "BROKER_RESPONSE_INVALID"
    | "REGION_MATRIX_INVALID"
    | "LIMIT_EXCEEDED") {
    super("Compute Optimizer materialization activation manifest read rejected");
    this.name = "ComputeOptimizerMaterializationActivationReaderError";
  }
}

function reject(code: ComputeOptimizerMaterializationActivationReaderError["code"]): never {
  throw new ComputeOptimizerMaterializationActivationReaderError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function regionMatchesPartition(region: string, partition: string): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return partition === "aws" && !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exactRegions(value: unknown, partition: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REGIONS
    || value.some((region) => typeof region !== "string" || !REGION.test(region)
      || !regionMatchesPartition(region, partition))) reject("INVALID_CONFIGURATION");
  const regions = [...value].sort() as string[];
  if (new Set(regions).size !== regions.length) reject("INVALID_CONFIGURATION");
  return Object.freeze(regions);
}

function cloneRequest(value: unknown): ComputeOptimizerMaterializationActivationManifestRequest {
  let clone: unknown;
  try { clone = JSON.parse(JSON.stringify(value)) as unknown; } catch {
    return reject("INVALID_CONFIGURATION");
  }
  if (!isRecord(clone) || !exactKeys(clone, [
    "schema", "requestId", "tenantId", "connectionId", "accountId", "partition",
    "requiredPermissionPackVersion",
  ]) || clone.schema
      !== "sutra.compute-optimizer-materialization-activation-manifest-request.v1"
    || typeof clone.requestId !== "string" || !IDENTIFIER.test(clone.requestId)
    || typeof clone.tenantId !== "string" || !IDENTIFIER.test(clone.tenantId)
    || typeof clone.connectionId !== "string" || !CONNECTION_ID.test(clone.connectionId)
    || typeof clone.accountId !== "string" || !ACCOUNT_ID.test(clone.accountId)
    || (clone.partition !== "aws" && clone.partition !== "aws-us-gov"
      && clone.partition !== "aws-cn")
    || clone.requiredPermissionPackVersion !== "standard-2026-08.5") {
    reject("INVALID_CONFIGURATION");
  }
  return Object.freeze(clone as unknown as ComputeOptimizerMaterializationActivationManifestRequest);
}

function readNow(clock: (() => number) | undefined): number {
  let value: unknown;
  try { value = (clock ?? Date.now)(); } catch { return reject("INVALID_CONFIGURATION"); }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    reject("INVALID_CONFIGURATION");
  }
  return value;
}

function validPrefix(basePrefix: unknown, effectivePrefix: unknown, accountId: string): boolean {
  if (typeof basePrefix !== "string" || typeof effectivePrefix !== "string"
    || encodedBytes(basePrefix) > 180 || basePrefix.startsWith("/")
    || /[%\\*?\u0000]/u.test(basePrefix)
    || effectivePrefix !== `${basePrefix}compute-optimizer/${accountId}/`) return false;
  if (basePrefix === "") return true;
  if (!basePrefix.endsWith("/")) return false;
  const segments = basePrefix.slice(0, -1).split("/");
  return segments.length >= 1 && segments.length <= 4
    && segments.every((segment) => segment !== "." && segment !== ".."
      && PREFIX_SEGMENT.test(segment));
}

function validRow(
  value: unknown,
  expectedRegion: string,
  accountId: string,
): value is ComputeOptimizerMaterializationActivationManifestRegion {
  return isRecord(value) && exactKeys(value, [
    "region", "describeContractId", "launchContractId", "objectReadContractId",
    "bucket", "basePrefix", "effectivePrefix",
  ]) && value.region === expectedRegion
    && typeof value.describeContractId === "string" && IDENTIFIER.test(value.describeContractId)
    && typeof value.launchContractId === "string" && IDENTIFIER.test(value.launchContractId)
    && typeof value.objectReadContractId === "string" && IDENTIFIER.test(value.objectReadContractId)
    && typeof value.bucket === "string" && BUCKET.test(value.bucket)
    && validPrefix(value.basePrefix, value.effectivePrefix, accountId);
}

function parseResponse(
  value: unknown,
  request: ComputeOptimizerMaterializationActivationManifestRequest,
  enabledRegions: readonly string[],
): ComputeOptimizerMaterializationActivationManifest {
  let serialized: string;
  let clone: unknown;
  try {
    serialized = JSON.stringify(value);
    if (encodedBytes(serialized) > MAX_RESPONSE_BYTES) reject("LIMIT_EXCEEDED");
    clone = JSON.parse(serialized) as unknown;
  } catch (error) {
    if (error instanceof ComputeOptimizerMaterializationActivationReaderError) throw error;
    return reject("BROKER_RESPONSE_INVALID");
  }
  if (!isRecord(clone) || !exactKeys(clone, [
    "schema", "requestId", "tenantId", "connectionId", "accountId", "partition",
    "permissionPackVersion", "regions",
  ]) || clone.schema
      !== "sutra.compute-optimizer-materialization-activation-manifest-response.v1"
    || clone.requestId !== request.requestId || clone.tenantId !== request.tenantId
    || clone.connectionId !== request.connectionId || clone.accountId !== request.accountId
    || clone.partition !== request.partition
    || clone.permissionPackVersion !== request.requiredPermissionPackVersion
    || !Array.isArray(clone.regions)) reject("BROKER_RESPONSE_INVALID");
  if (clone.regions.length !== enabledRegions.length
    || clone.regions.some((row, index) =>
      !validRow(row, enabledRegions[index]!, request.accountId))) {
    reject("REGION_MATRIX_INVALID");
  }
  const rows = clone.regions as unknown as ComputeOptimizerMaterializationActivationManifestRegion[];
  const identities = rows.flatMap((row) => [
    row.describeContractId, row.launchContractId, row.objectReadContractId,
  ]);
  if (new Set(identities).size !== identities.length) reject("REGION_MATRIX_INVALID");
  return Object.freeze({
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId: request.requestId,
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    accountId: request.accountId,
    partition: request.partition,
    permissionPackVersion: "standard-2026-08.5",
    regions: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
  });
}

function hardBoundary<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  durationMs: number,
): Promise<T> {
  return new Promise<T>((resolve, rejectPromise) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      callback();
    };
    const onParentAbort = (): void => {
      controller.abort();
      finish(() => rejectPromise(
        new ComputeOptimizerMaterializationActivationReaderError("ABORTED"),
      ));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => rejectPromise(
        new ComputeOptimizerMaterializationActivationReaderError("DEADLINE_EXCEEDED"),
      ));
    }, durationMs);
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (parentSignal?.aborted === true) return onParentAbort();
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => finish(() => resolve(value)),
      () => finish(() => rejectPromise(
        new ComputeOptimizerMaterializationActivationReaderError("TRANSPORT_FAILED"),
      )),
    );
  });
}

export async function readComputeOptimizerMaterializationActivationManifest(
  boundary: ComputeOptimizerMaterializationActivationReaderBoundary,
  transport: ComputeOptimizerMaterializationActivationManifestTransport,
  options: ComputeOptimizerMaterializationActivationReaderOptions = {},
): Promise<ComputeOptimizerMaterializationActivationManifest> {
  const optionRecord: unknown = options;
  if (!isRecord(boundary) || !exactKeys(boundary, ["request", "enabledRegions"])
    || !isRecord(transport) || typeof transport.readActivationManifest !== "function"
    || !isRecord(optionRecord)
    || Object.keys(optionRecord).some((key) =>
      !["signal", "deadlineAtMs", "maximumDurationMs", "now"].includes(key))
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    reject("INVALID_CONFIGURATION");
  }
  const request = cloneRequest(boundary.request);
  const regions = exactRegions(boundary.enabledRegions, request.partition);
  const startedAtMs = readNow(options.now);
  const maximumDurationMs = options.maximumDurationMs ?? MAXIMUM_DURATION_MS;
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1
    || maximumDurationMs > MAXIMUM_DURATION_MS) reject("INVALID_CONFIGURATION");
  const callerDeadline = options.deadlineAtMs ?? startedAtMs + maximumDurationMs;
  if (!Number.isSafeInteger(callerDeadline) || callerDeadline <= startedAtMs) {
    reject("DEADLINE_EXCEEDED");
  }
  const durationMs = Math.min(maximumDurationMs, callerDeadline - startedAtMs);
  let response: unknown;
  try {
    response = await hardBoundary(
      (signal) => transport.readActivationManifest(request, { signal }),
      options.signal,
      durationMs,
    );
  } catch (error) {
    if (error instanceof ComputeOptimizerMaterializationActivationReaderError) throw error;
    return reject("TRANSPORT_FAILED");
  }
  return parseResponse(response, request, regions);
}
