import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  FALCO_MAXIMUM_BODY_BYTES,
  FalcoRuntimeBoundaryError,
  parseFalcoRuntimePayload,
} from "../../lib/falco-runtime-boundary.ts";
import { canonicalFalcoRequest } from "../../lib/falco-request-security.ts";
import type { NormalizedFalcoRuntimeEvent } from "../../lib/falco-runtime-types.ts";

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const HMAC_KEY = /^[A-Za-z0-9_-]{43,172}$/u;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAXIMUM_RESPONSE_BYTES = 16 * 1024;

export interface FalcoGatewayConfig {
  readonly clusterId: string;
  readonly controlPlaneOrigin: string;
  readonly keyId: string;
  readonly hmacKey: Uint8Array;
  readonly forwardTimeoutMs: number;
  readonly maximumAttempts: number;
}

export interface FalcoGatewayDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly nonce: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly log: (entry: {
    readonly event: "forward_failed" | "forward_retry";
    readonly attempt: number;
    readonly status: number | null;
  }) => void;
}

export interface FalcoGatewayRequest {
  readonly method: string;
  readonly pathname: string;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

export interface FalcoGatewayResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export class FalcoGatewayConfigurationError extends Error {
  public constructor() {
    super("Falco signing gateway configuration is invalid");
    this.name = "FalcoGatewayConfigurationError";
  }
}

function invalidConfiguration(): never {
  throw new FalcoGatewayConfigurationError();
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d{1,6}$/u.test(value)) invalidConfiguration();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) invalidConfiguration();
  return parsed;
}

function decodeHmacKey(value: string | undefined): Uint8Array {
  if (value === undefined || !HMAC_KEY.test(value)) invalidConfiguration();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 32 || decoded.byteLength > 128) invalidConfiguration();
  return new Uint8Array(decoded);
}

function controlPlaneOrigin(value: string | undefined): string {
  if (value === undefined || value.length > 2_048) invalidConfiguration();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidConfiguration();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) invalidConfiguration();
  return url.origin;
}

export function loadFalcoGatewayConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FalcoGatewayConfig {
  const clusterId = environment.SUTRA_FALCO_CLUSTER_ID ?? "";
  const keyId = environment.SUTRA_FALCO_KEY_ID ?? "";
  if (!CLUSTER_ID.test(clusterId) || !KEY_ID.test(keyId)) invalidConfiguration();
  return {
    clusterId,
    controlPlaneOrigin: controlPlaneOrigin(environment.SUTRA_FALCO_CONTROL_PLANE_URL),
    keyId,
    hmacKey: decodeHmacKey(environment.SUTRA_FALCO_HMAC_KEY),
    forwardTimeoutMs: boundedInteger(
      environment.SUTRA_FALCO_FORWARD_TIMEOUT_MS,
      5_000,
      500,
      15_000,
    ),
    maximumAttempts: boundedInteger(
      environment.SUTRA_FALCO_FORWARD_ATTEMPTS,
      3,
      1,
      5,
    ),
  };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  ) as T;
}

function falcosidekickSafeEvent(event: NormalizedFalcoRuntimeEvent): Record<string, unknown> {
  return {
    time: event.occurredAt,
    rule: event.rule,
    priority: event.priority,
    source: event.source,
    ...(event.nodeName === null ? {} : { hostname: event.nodeName }),
    output_fields: compact({
      "k8s.ns.name": event.namespace,
      "k8s.pod.name": event.podName,
      "k8s.pod.uid": event.podUid,
      "container.id": event.containerId,
      "container.name": event.containerName,
      // The boundary intentionally stores a display-safe combined image name.
      // Reusing it as the repository preserves that exact allowlisted value.
      "container.image.repository": event.containerImage,
      "proc.name": event.process.name,
      "proc.exepath": event.process.executable,
      "proc.pid": event.process.pid,
      "proc.ppid": event.process.parentPid,
      "user.name": event.process.userName,
      "user.uid": event.process.userId,
      "evt.type": event.process.eventType,
    }),
  };
}

export function normalizeFalcosidekickBody(input: {
  readonly clusterId: string;
  readonly body: Uint8Array;
}): Uint8Array {
  const events = parseFalcoRuntimePayload(input);
  return Buffer.from(JSON.stringify({
    events: events.map(falcosidekickSafeEvent),
  }), "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function signedHeaders(input: {
  readonly config: FalcoGatewayConfig;
  readonly path: string;
  readonly body: Uint8Array;
  readonly timestamp: string;
  readonly nonce: string;
}): Headers {
  const bodySha256 = sha256(input.body);
  const signature = createHmac("sha256", input.config.hmacKey)
    .update(canonicalFalcoRequest({
      method: "POST",
      path: input.path,
      timestamp: input.timestamp,
      nonce: input.nonce,
      keyId: input.config.keyId,
      clusterId: input.config.clusterId,
      bodySha256,
    }))
    .digest("base64url");
  return new Headers({
    "content-type": "application/json",
    "content-length": String(input.body.byteLength),
    "x-sutra-falco-timestamp": input.timestamp,
    "x-sutra-falco-nonce": input.nonce,
    "x-sutra-falco-key-id": input.config.keyId,
    "x-sutra-falco-signature": signature,
  });
}

function response(status: number, code: string): FalcoGatewayResponse {
  return {
    status,
    body: {
      schemaVersion: "sutra.falco.gateway-response.v1",
      code,
    },
  };
}

async function discardResponseBody(result: Response): Promise<void> {
  const length = result.headers.get("content-length");
  if (length !== null && /^\d+$/u.test(length) && Number(length) > MAXIMUM_RESPONSE_BYTES) {
    await result.body?.cancel();
    return;
  }
  await result.body?.cancel();
}

async function forward(
  config: FalcoGatewayConfig,
  body: Uint8Array,
  dependencies: FalcoGatewayDependencies,
): Promise<boolean> {
  const path = `/api/v1/kubernetes/runtime-events/${config.clusterId}`;
  const target = new URL(path, `${config.controlPlaneOrigin}/`);
  for (let attempt = 1; attempt <= config.maximumAttempts; attempt += 1) {
    const timestamp = String(dependencies.now());
    const nonce = dependencies.nonce();
    let result: Response | null = null;
    try {
      result = await dependencies.fetch(target, {
        method: "POST",
        redirect: "error",
        headers: signedHeaders({ config, path, body, timestamp, nonce }),
        body: Buffer.from(body),
        signal: AbortSignal.timeout(config.forwardTimeoutMs),
      });
      const successful = result.status >= 200 && result.status < 300;
      const retryable = RETRYABLE_STATUS.has(result.status);
      await discardResponseBody(result);
      if (successful) return true;
      if (!retryable || attempt === config.maximumAttempts) {
        dependencies.log({ event: "forward_failed", attempt, status: result.status });
        return false;
      }
      dependencies.log({ event: "forward_retry", attempt, status: result.status });
    } catch {
      if (result !== null) await discardResponseBody(result);
      if (attempt === config.maximumAttempts) {
        dependencies.log({ event: "forward_failed", attempt, status: null });
        return false;
      }
      dependencies.log({ event: "forward_retry", attempt, status: null });
    }
    await dependencies.sleep(Math.min(100 * (2 ** (attempt - 1)), 1_000));
  }
  return false;
}

export function defaultFalcoGatewayDependencies(): FalcoGatewayDependencies {
  return {
    fetch,
    now: Date.now,
    nonce: () => randomBytes(24).toString("base64url"),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log: (entry) => {
      process.stderr.write(`${JSON.stringify({
        service: "sutra-falco-signing-gateway",
        ...entry,
      })}\n`);
    },
  };
}

export async function handleFalcoGatewayRequest(
  request: FalcoGatewayRequest,
  config: FalcoGatewayConfig,
  dependencies: FalcoGatewayDependencies = defaultFalcoGatewayDependencies(),
): Promise<FalcoGatewayResponse> {
  if (request.pathname === "/healthz" || request.pathname === "/readyz") {
    return request.method === "GET" ? response(200, "OK") : response(405, "METHOD_NOT_ALLOWED");
  }
  if (request.pathname !== "/events") return response(404, "NOT_FOUND");
  if (request.method !== "POST") return response(405, "METHOD_NOT_ALLOWED");
  if (request.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return response(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  if (request.body.byteLength > FALCO_MAXIMUM_BODY_BYTES) {
    return response(413, "BODY_TOO_LARGE");
  }
  let normalized: Uint8Array;
  try {
    normalized = normalizeFalcosidekickBody({
      clusterId: config.clusterId,
      body: request.body,
    });
  } catch (error) {
    if (error instanceof FalcoRuntimeBoundaryError) {
      return response(error.code === "BODY_TOO_LARGE" ? 413 : 400, error.code);
    }
    return response(400, "INVALID_INPUT");
  }
  return await forward(config, normalized, dependencies)
    ? response(202, "ACCEPTED")
    : response(503, "FORWARD_UNAVAILABLE");
}
