import { env } from "cloudflare:workers";
import {
  parseCollectorHealth,
  parsePilotSnapshot,
  parseRegisteredResponse,
  parseVerificationResponse,
} from "./pilot-boundary";
import type { AwsPartition, CollectorHealth, PilotSnapshotPayload } from "./pilot-types";

interface PilotRuntimeEnv {
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_LOCAL_OPERATOR_EMAIL?: string;
  readonly SUTRA_CONNECTION_ENCRYPTION_KEY?: string;
  readonly SUTRA_CONNECTION_KEY_VERSION?: string;
  readonly SUTRA_BROKER_SHARED_SECRET?: string;
  readonly SUTRA_BROKER_URL?: string;
}

export interface PilotActor {
  readonly id: string;
  readonly email: string;
  readonly local: boolean;
}

export interface PilotSecrets {
  readonly connectionEncryptionKey: string;
  readonly connectionKeyVersion: string;
  readonly brokerSharedSecret: string;
  readonly brokerUrl: string;
}

export class PilotServerError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "PilotServerError";
    this.status = status;
    this.code = code;
  }
}

function runtimeEnv(): PilotRuntimeEnv {
  return env as unknown as PilotRuntimeEnv;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function actorIdFromEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  let hash = 2166136261;
  for (const character of normalized) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `user_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function requirePilotActor(request: Request): PilotActor {
  const config = runtimeEnv();
  const url = new URL(request.url);
  if (config.SUTRA_LOCAL_MODE === "true" && isLocalHostname(url.hostname)) {
    const email = config.SUTRA_LOCAL_OPERATOR_EMAIL?.trim() || "local-admin@sutra.invalid";
    return { id: actorIdFromEmail(email), email, local: true };
  }

  const forwardedEmail = request.headers.get("oai-authenticated-user-email")?.trim();
  if (!forwardedEmail) {
    throw new PilotServerError(401, "AUTHENTICATION_REQUIRED", "Sign in before using the Sutra workspace");
  }
  return { id: actorIdFromEmail(forwardedEmail), email: forwardedEmail, local: false };
}

export function getPilotSecrets(): PilotSecrets {
  const config = runtimeEnv();
  const connectionEncryptionKey = config.SUTRA_CONNECTION_ENCRYPTION_KEY?.trim();
  const brokerSharedSecret = config.SUTRA_BROKER_SHARED_SECRET?.trim();
  const connectionKeyVersion = config.SUTRA_CONNECTION_KEY_VERSION?.trim() || "local-v1";
  const brokerUrl = config.SUTRA_BROKER_URL?.trim() || "http://127.0.0.1:8788";

  if (!connectionEncryptionKey || !brokerSharedSecret) {
    throw new PilotServerError(
      503,
      "PILOT_NOT_CONFIGURED",
      "Run the local pilot setup before onboarding an AWS account",
    );
  }
  const parsedBrokerUrl = new URL(brokerUrl);
  if (
    parsedBrokerUrl.protocol !== "http:" ||
    !isLocalHostname(parsedBrokerUrl.hostname) ||
    parsedBrokerUrl.username ||
    parsedBrokerUrl.password ||
    parsedBrokerUrl.pathname !== "/"
  ) {
    throw new PilotServerError(500, "BROKER_CONFIGURATION_INVALID", "The local collector address is invalid");
  }

  return {
    connectionEncryptionKey,
    connectionKeyVersion,
    brokerSharedSecret,
    brokerUrl: parsedBrokerUrl.origin,
  };
}

function decodeBase64(value: string): Uint8Array {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/u, "");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(normalized + padding);
    if (binary.length < 32) throw new Error("short key");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new PilotServerError(500, "BROKER_CONFIGURATION_INVALID", "The local collector signing key is invalid");
  }
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const decoded = decodeBase64(secret);
  const rawKey = new Uint8Array(decoded.byteLength);
  rawKey.set(decoded);
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function brokerFetch<T>(
  path: string,
  method: "GET" | "PUT" | "POST",
  payload?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  const config = getPilotSecrets();
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(
    config.brokerSharedSecret,
    `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.brokerUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-sutra-timestamp": timestamp,
        "x-sutra-nonce": nonce,
        "x-sutra-signature": signature,
      },
      body: body.length === 0 ? undefined : body,
      signal: controller.signal,
    });
  } catch {
    throw new PilotServerError(503, "BROKER_UNAVAILABLE", "The local AWS collector is not reachable");
  } finally {
    clearTimeout(timeout);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 12 * 1024 * 1024) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector response exceeded the pilot limit");
  }
  const responseText = await readLimitedResponseText(response, 12 * 1024 * 1024);
  const responseSignature = response.headers.get("x-sutra-response-signature") ?? "";
  const expectedResponseSignature = await hmacHex(
    config.brokerSharedSecret,
    `${response.status}\n${path}\n${nonce}\n${await sha256Hex(responseText)}`,
  );
  if (!constantTimeEqual(responseSignature, expectedResponseSignature)) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector response signature is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector returned invalid JSON");
  }
  if (!response.ok) {
    const record = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
    const code = safeBrokerErrorCode(record.code);
    throw new PilotServerError(
      response.status >= 500 ? 502 : response.status,
      code,
      publicBrokerMessage(code),
    );
  }
  return parsed as T;
}

async function readLimitedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector response exceeded the pilot limit");
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (error) {
    if (error instanceof PilotServerError) throw error;
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector returned invalid response bytes");
  } finally {
    reader.releaseLock();
  }
}

const BROKER_CODES = new Set([
  "ASSUME_ROLE_FAILED",
  "CALLER_IDENTITY_MISMATCH",
  "NEGATIVE_PROBE_INCONCLUSIVE",
  "TRUST_POLICY_UNSAFE",
  "PERMISSION_DENIED",
  "THROTTLED",
  "COLLECTION_FAILED",
  "CONNECTION_NOT_FOUND",
  "INVALID_REQUEST",
]);

function safeBrokerErrorCode(value: unknown): string {
  return typeof value === "string" && BROKER_CODES.has(value) ? value : "BROKER_REQUEST_FAILED";
}

function publicBrokerMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    ASSUME_ROLE_FAILED: "AWS rejected the customer role session",
    CALLER_IDENTITY_MISMATCH: "The assumed AWS identity did not match the onboarded account",
    NEGATIVE_PROBE_INCONCLUSIVE: "The role trust policy could not be proven to require the ExternalId",
    TRUST_POLICY_UNSAFE: "The customer role trust policy did not pass the Sutra safety checks",
    PERMISSION_DENIED: "The customer role is missing a required read-only inventory permission",
    THROTTLED: "AWS throttled this inventory request; retry after a short delay",
    COLLECTION_FAILED: "The AWS inventory collection did not complete",
    CONNECTION_NOT_FOUND: "The collector does not have this scoped connection",
    INVALID_REQUEST: "The collector rejected the scoped request",
    BROKER_REQUEST_FAILED: "The AWS collector rejected the request",
  };
  return messages[code] ?? messages.BROKER_REQUEST_FAILED;
}

export async function getCollectorHealth(expectedPartition?: AwsPartition): Promise<CollectorHealth> {
  return parseCollectorHealth(await brokerFetch<unknown>("/v1/health", "GET"), expectedPartition);
}

export async function registerCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: string;
  readonly roleArn: string;
  readonly externalId: string;
  readonly enabledRegions: readonly string[];
}): Promise<{ registered: true }> {
  return parseRegisteredResponse(
    await brokerFetch<unknown>(`/v1/connections/${input.connectionId}`, "PUT", input),
  );
}

export async function verifyCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
}): Promise<{
  readonly verified: true;
  readonly accountId: string;
  readonly callerIdentityArn: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
}> {
  const payload = { tenantId: input.tenantId, connectionId: input.connectionId, jobId: input.jobId };
  return parseVerificationResponse(
    await brokerFetch(`/v1/connections/${input.connectionId}/verify`, "POST", payload, 45_000),
    { accountId: input.accountId, partition: input.partition },
  );
}

export async function runCollectorSync(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
}): Promise<PilotSnapshotPayload> {
  const payload = { tenantId: input.tenantId, connectionId: input.connectionId, jobId: input.jobId };
  return parsePilotSnapshot(
    await brokerFetch<unknown>(`/v1/connections/${input.connectionId}/sync`, "POST", payload, 180_000),
    {
      jobId: input.jobId,
      connectionId: input.connectionId,
      accountId: input.accountId,
      partition: input.partition,
    },
  );
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof PilotServerError) {
    return jsonResponse({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "REQUEST_FAILED";
  const publicMessage =
    code === "INVALID_INPUT" || code === "INVALID_STATE" || code === "CONFLICT" || code === "NOT_FOUND"
      ? (typeof candidate?.message === "string" ? candidate.message : "The request is invalid")
      : "Sutra could not complete the request";
  const status = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : code === "INVALID_INPUT" ? 400 : code === "INVALID_STATE" ? 409 : 500;
  return jsonResponse({ error: { code, message: publicMessage } }, { status });
}

export function safeValidationFailureCode(error: unknown): string {
  const code = error instanceof PilotServerError ? error.code : "VALIDATION_FAILED";
  return new Set([
    "ASSUME_ROLE_FAILED",
    "BROKER_UNAVAILABLE",
    "CALLER_IDENTITY_MISMATCH",
    "NEGATIVE_PROBE_INCONCLUSIVE",
    "TRUST_POLICY_UNSAFE",
  ]).has(code) ? code : "VALIDATION_FAILED";
}

export function safeCollectionFailureCode(error: unknown): string {
  const code = error instanceof PilotServerError ? error.code : "COLLECTION_FAILED";
  return new Set(["BROKER_UNAVAILABLE", "PERMISSION_DENIED", "THROTTLED"]).has(code)
    ? code
    : "COLLECTION_FAILED";
}
