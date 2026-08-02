import { env } from "cloudflare:workers";
import {
  parseCollectorHealth,
  parsePilotSnapshot,
  parseRegisteredResponse,
  parseVerificationResponse,
} from "./pilot-boundary";
import type {
  AwsPartition,
  AwsPermissionCapabilityAssessment,
  AwsRoleProvisioningMode,
  CollectorHealth,
  PilotSnapshotPayload,
} from "./pilot-types";
import {
  parseLocalFixtureCatalog,
  parseLocalFixtureEnqueue,
  parseLocalFixtureJobs,
  parseLocalFixtureResultFromCatalog,
  parseLocalFixtureScheduleResponse,
  parseLocalFixtureSchedules,
  type LocalFixtureDescriptor,
  type LocalFixtureJobResult,
  type LocalFixtureJobSummary,
  type LocalFixtureSchedule,
  type LocalFixtureVersion,
} from "./local-ops-types";
import { authorizePilotRequest, type AuthorizedPilotActor } from "./api-auth";
import type { Capability } from "./auth-policy";
import { LIVE_AWS_BROKER_TIMEOUT_MS } from "../services/aws-collector/src/live-collection-limits";
import { parseAwsCostSnapshot } from "./cost-boundary";
import type { AwsCostSnapshot } from "./cost-types";
import { parseAwsSecurityEventCollection } from "./security-event-boundary";
import type { AwsSecurityEventCollection } from "./security-event-types";
import {
  HostedBrokerClientSecurityError,
  signHostedBrokerRequest,
  verifyHostedBrokerResponse,
  type HostedBrokerClientSigningConfiguration,
} from "./hosted-broker-client-security";
import type { AgentlessScanReadiness } from "./aws-agentless-readiness";
import type { FinopsExportChunkRequest } from "../services/aws-collector/src/finops-export-chunk";
import type {
  ComputeOptimizerExportObjectChunkRequest,
} from "../services/aws-collector/src/compute-optimizer-export-object-chunk";
import type { FinopsSourceId } from "./finops-source-health";

interface PilotRuntimeEnv {
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_CONNECTION_ENCRYPTION_KEY?: string;
  readonly SUTRA_CONNECTION_KEY_VERSION?: string;
  readonly SUTRA_BROKER_SHARED_SECRET?: string;
  readonly SUTRA_BROKER_URL?: string;
  readonly SUTRA_BROKER_AUTH_MODE?: string;
  readonly SUTRA_BROKER_CLIENT_KEY_ID?: string;
  readonly SUTRA_BROKER_CLIENT_PRIVATE_KEY?: string;
  readonly SUTRA_BROKER_RESPONSE_KEY_ID?: string;
  readonly SUTRA_BROKER_RESPONSE_PUBLIC_KEY?: string;
}

export type PilotActor = AuthorizedPilotActor;

export interface PilotSecrets {
  readonly connectionEncryptionKey: string;
  readonly connectionKeyVersion: string;
  readonly brokerUrl: string;
  readonly brokerAuthentication:
    | { readonly mode: "hmac"; readonly sharedSecret: string }
    | ({ readonly mode: "asymmetric" } & HostedBrokerClientSigningConfiguration);
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

export function requirePilotActor(
  request: Request,
  capability: Capability = "workspace:read",
  customerId?: string,
): Promise<PilotActor> {
  return authorizePilotRequest(request, capability, customerId);
}

export function isLocalSimulationRuntime(): boolean {
  return runtimeEnv().SUTRA_LOCAL_MODE === "true";
}

/**
 * Fixture catalogs, queues, schedules, and publication controls are developer
 * tooling. Keep the boundary on the server as well as in the UI so a hosted
 * session cannot reach sample evidence by calling an `/api/local/*` URL
 * directly.
 */
export function assertLocalSimulationRuntime(): void {
  if (!isLocalSimulationRuntime()) {
    throw new PilotServerError(404, "NOT_FOUND", "The requested resource was not found");
  }
}

export function getPilotSecrets(): PilotSecrets {
  const config = runtimeEnv();
  const connectionEncryptionKey = config.SUTRA_CONNECTION_ENCRYPTION_KEY?.trim();
  const connectionKeyVersion = config.SUTRA_CONNECTION_KEY_VERSION?.trim() || "local-v1";
  const brokerUrl = config.SUTRA_BROKER_URL?.trim() || "http://127.0.0.1:8788";

  if (!connectionEncryptionKey) {
    throw new PilotServerError(
      503,
      "PILOT_NOT_CONFIGURED",
      "Collector configuration is incomplete",
    );
  }
  const parsedBrokerUrl = new URL(brokerUrl);
  const local = config.SUTRA_LOCAL_MODE === "true";
  const validLocalUrl =
    parsedBrokerUrl.protocol === "http:" &&
    isLocalHostname(parsedBrokerUrl.hostname);
  const validHostedUrl =
    parsedBrokerUrl.protocol === "https:" &&
    !isLocalHostname(parsedBrokerUrl.hostname);
  if (
    (local ? !validLocalUrl : !validHostedUrl) ||
    parsedBrokerUrl.username ||
    parsedBrokerUrl.password ||
    parsedBrokerUrl.pathname !== "/" ||
    parsedBrokerUrl.search ||
    parsedBrokerUrl.hash
  ) {
    throw new PilotServerError(500, "BROKER_CONFIGURATION_INVALID", "The collector address configuration is invalid");
  }

  let brokerAuthentication: PilotSecrets["brokerAuthentication"];
  if (local) {
    const sharedSecret = config.SUTRA_BROKER_SHARED_SECRET?.trim();
    if (!sharedSecret) {
      throw new PilotServerError(503, "PILOT_NOT_CONFIGURED", "Collector configuration is incomplete");
    }
    brokerAuthentication = { mode: "hmac", sharedSecret };
  } else {
    if (config.SUTRA_BROKER_AUTH_MODE !== "asymmetric") {
      throw new PilotServerError(500, "BROKER_CONFIGURATION_INVALID", "The collector signing configuration is invalid");
    }
    const clientKeyId = config.SUTRA_BROKER_CLIENT_KEY_ID?.trim();
    const clientPrivateKey = config.SUTRA_BROKER_CLIENT_PRIVATE_KEY?.trim();
    const brokerKeyId = config.SUTRA_BROKER_RESPONSE_KEY_ID?.trim();
    const brokerPublicKey = config.SUTRA_BROKER_RESPONSE_PUBLIC_KEY?.trim();
    if (!clientKeyId || !clientPrivateKey || !brokerKeyId || !brokerPublicKey) {
      throw new PilotServerError(503, "PILOT_NOT_CONFIGURED", "Collector configuration is incomplete");
    }
    brokerAuthentication = {
      mode: "asymmetric",
      clientKeyId,
      clientPrivateKey,
      brokerKeyId,
      brokerPublicKey,
    };
  }
  return {
    connectionEncryptionKey,
    connectionKeyVersion,
    brokerUrl: parsedBrokerUrl.origin,
    brokerAuthentication,
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
    throw new PilotServerError(500, "BROKER_CONFIGURATION_INVALID", "The collector signing configuration is invalid");
  }
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const source = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return toHex(await crypto.subtle.digest("SHA-256", bytes.buffer));
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

async function brokerFetchEnvelope<T>(
  path: string,
  method: "GET" | "PUT" | "POST",
  payload?: unknown,
  timeoutMs = 20_000,
  externalSignal?: AbortSignal,
): Promise<{ readonly value: T; readonly authenticatedBody: Uint8Array }> {
  const config = getPilotSecrets();
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const nonce = crypto.randomUUID();
  const authenticationHeaders: Record<string, string> = {};
  if (config.brokerAuthentication.mode === "hmac") {
    const timestamp = Date.now().toString();
    const bodyHash = await sha256Hex(body);
    authenticationHeaders["x-sutra-timestamp"] = timestamp;
    authenticationHeaders["x-sutra-nonce"] = nonce;
    authenticationHeaders["x-sutra-signature"] = await hmacHex(
      config.brokerAuthentication.sharedSecret,
      `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`,
    );
  } else {
    try {
      Object.assign(authenticationHeaders, (await signHostedBrokerRequest({
        method,
        path,
        body,
        now: Date.now(),
        nonce,
        config: config.brokerAuthentication,
      })).headers);
    } catch {
      throw new PilotServerError(500, "BROKER_CONFIGURATION_INVALID", "The collector signing configuration is invalid");
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = externalSignal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, externalSignal]);
  let response: Response;
  try {
    response = await fetch(`${config.brokerUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...authenticationHeaders,
      },
      body: body.length === 0 ? undefined : body,
      signal: requestSignal,
    });
  } catch {
    throw new PilotServerError(503, "BROKER_UNAVAILABLE", "The AWS collector is not reachable");
  } finally {
    clearTimeout(timeout);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 12 * 1024 * 1024) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector response exceeded the service limit");
  }
  const responseBody = await readLimitedResponseText(response, 12 * 1024 * 1024);
  const responseText = responseBody.text;
  if (config.brokerAuthentication.mode === "hmac") {
    const responseSignature = response.headers.get("x-sutra-response-signature") ?? "";
    const expectedResponseSignature = await hmacHex(
      config.brokerAuthentication.sharedSecret,
      `${response.status}\n${path}\n${nonce}\n${await sha256Hex(responseBody.bytes)}`,
    );
    if (!constantTimeEqual(responseSignature, expectedResponseSignature)) {
      throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector response signature is invalid");
    }
  } else {
    try {
      await verifyHostedBrokerResponse({
        status: response.status,
        path,
        nonce,
        body: responseBody.bytes,
        headers: response.headers,
        config: config.brokerAuthentication,
      });
    } catch (error) {
      if (error instanceof HostedBrokerClientSecurityError) {
        throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector response signature is invalid");
      }
      throw error;
    }
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
  return {
    value: parsed as T,
    // This is the exact UTF-8 body whose digest was authenticated immediately
    // above. Keep it beside the parsed value so evidence archival cannot
    // accidentally serialize a semantically-equivalent but different payload.
    authenticatedBody: responseBody.bytes,
  };
}

async function brokerFetch<T>(
  path: string,
  method: "GET" | "PUT" | "POST",
  payload?: unknown,
  timeoutMs = 20_000,
): Promise<T> {
  return (await brokerFetchEnvelope<T>(path, method, payload, timeoutMs)).value;
}

async function readLimitedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<{ readonly text: string; readonly bytes: Uint8Array }> {
  if (response.body === null) return { text: "", bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let result = "";
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector response exceeded the service limit");
      }
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: result, bytes };
  } catch (error) {
    if (error instanceof PilotServerError) throw error;
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector returned invalid response bytes");
  } finally {
    reader.releaseLock();
  }
}

const BROKER_CODES = new Set([
  "ASSUME_ROLE_DENIED",
  "ASSUME_ROLE_FAILED",
  "CALLER_IDENTITY_MISMATCH",
  "NEGATIVE_PROBE_INCONCLUSIVE",
  "TRUST_POLICY_UNSAFE",
  "PERMISSION_DENIED",
  "THROTTLED",
  "COLLECTION_FAILED",
  "CONNECTION_NOT_FOUND",
  "INVALID_REQUEST",
  "IDEMPOTENCY_CONFLICT",
  "JOB_FAILED",
  "JOB_NOT_FOUND",
  "JOB_NOT_READY",
  "SCHEDULE_NOT_FOUND",
  "STALE_SCHEDULE_MUTATION",
  "ALREADY_RUNNING",
  "RUN_NOT_TRACKED",
]);

function safeBrokerErrorCode(value: unknown): string {
  return typeof value === "string" && BROKER_CODES.has(value) ? value : "BROKER_REQUEST_FAILED";
}

function publicBrokerMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    ASSUME_ROLE_DENIED: "AWS denied the customer role session; verify that the role and trust policy still match this connection",
    ASSUME_ROLE_FAILED: "AWS rejected the customer role session",
    CALLER_IDENTITY_MISMATCH: "The assumed AWS identity did not match the onboarded account",
    NEGATIVE_PROBE_INCONCLUSIVE: "The role trust policy could not be proven to require the ExternalId",
    TRUST_POLICY_UNSAFE: "The customer role trust policy did not pass the Sutra safety checks",
    PERMISSION_DENIED: "The customer role is missing a required read-only inventory permission",
    THROTTLED: "AWS throttled this inventory request; retry after a short delay",
    COLLECTION_FAILED: "The AWS inventory collection did not complete",
    CONNECTION_NOT_FOUND: "The collector does not have this scoped connection",
    INVALID_REQUEST: "The collector rejected the scoped request",
    IDEMPOTENCY_CONFLICT: "That operation key is already bound to a different simulated request",
    JOB_FAILED: "The simulated inventory job exhausted its retries",
    JOB_NOT_FOUND: "The simulated inventory job was not found",
    JOB_NOT_READY: "The simulated inventory job is not complete",
    SCHEDULE_NOT_FOUND: "The simulated collection schedule was not found",
    STALE_SCHEDULE_MUTATION: "The schedule change was superseded by a newer operation",
    ALREADY_RUNNING: "That agentless scan is already running",
    RUN_NOT_TRACKED: "The agentless scan is not tracked by the collector",
    BROKER_REQUEST_FAILED: "The AWS collector rejected the request",
  };
  return messages[code] ?? messages.BROKER_REQUEST_FAILED;
}

/**
 * Starts an agentless scan in the collector.
 *
 * The Worker cannot execute one itself: workerd holds no AWS SDK and no AWS
 * credentials, by design. The collector owns the SDK, the role broker and the
 * workload identity, so this hands over only the approved plan; scan-account
 * settings remain pinned inside the broker. It gets back a 202 — the scan outlives
 * any HTTP request, so the poll below is how
 * its outcome is learned.
 */
export async function startAgentlessScan(input: {
  readonly runId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly plan: unknown;
}): Promise<{
  readonly runId: string;
  readonly phase: "running" | "completed" | "failed";
  readonly startedAt: string;
}> {
  const value = await brokerFetch<unknown>(
    `/v1/agentless/scans/${input.runId}/execute`,
    "POST",
    {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      plan: input.plan,
    },
  );
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless start response is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.runId !== input.runId ||
    (record.phase !== "running" && record.phase !== "completed" && record.phase !== "failed") ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    new Date(record.startedAt).toISOString() !== record.startedAt
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless start response is invalid");
  }
  return {
    runId: input.runId,
    phase: record.phase,
    startedAt: record.startedAt,
  };
}

/** Polls a scan. An untracked run is a 404 from the collector, which is NOT "clean". */
export async function readAgentlessRun(input: {
  readonly runId: string;
  readonly tenantId: string;
  readonly connectionId: string;
}): Promise<{
  readonly runId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly phase: "running" | "completed" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly execution: unknown | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}> {
  const query = new URLSearchParams({
    tenantId: input.tenantId,
    connectionId: input.connectionId,
  });
  const value = await brokerFetch<unknown>(
    `/v1/agentless/scans/${input.runId}?${query.toString()}`,
    "GET",
  );
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless run response is invalid");
  }
  const state = value as Record<string, unknown>;
  const phase = state.phase;
  const error = state.error;
  if (
    state.runId !== input.runId ||
    state.tenantId !== input.tenantId ||
    state.connectionId !== input.connectionId ||
    (phase !== "running" && phase !== "completed" && phase !== "failed") ||
    typeof state.startedAt !== "string" ||
    (state.finishedAt !== null && typeof state.finishedAt !== "string") ||
    (error !== null && (
      typeof error !== "object" ||
      Array.isArray(error) ||
      typeof (error as Record<string, unknown>).code !== "string" ||
      typeof (error as Record<string, unknown>).message !== "string"
    ))
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless run response is invalid");
  }
  return {
    runId: input.runId,
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    phase,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt as string | null,
    execution: state.execution ?? null,
    error: error as { readonly code: string; readonly message: string } | null,
  };
}

export async function getCollectorHealth(expectedPartition?: AwsPartition): Promise<CollectorHealth> {
  const health = parseCollectorHealth(await brokerFetch<unknown>("/v1/health", "GET"), expectedPartition);
  if (!isLocalSimulationRuntime() && health.mode !== "live") {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The hosted collector did not report live mode");
  }
  return health;
}

export async function getAgentlessExecutionReadiness(): Promise<AgentlessScanReadiness> {
  const value = await brokerFetch<unknown>("/v1/agentless/readiness", "GET");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless readiness response is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 5 ||
    keys.some((key) => !["schema", "canExecute", "canPlan", "gaps", "summary"].includes(key)) ||
    record.schema !== "sutra.aws-agentless-readiness.v1" ||
    typeof record.canExecute !== "boolean" ||
    record.canPlan !== true ||
    typeof record.summary !== "string" ||
    record.summary.length === 0 || record.summary.length > 600 ||
    !Array.isArray(record.gaps) || record.gaps.length > 10
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless readiness response is invalid");
  }
  const gaps = record.gaps.map((gap) => {
    if (typeof gap !== "object" || gap === null || Array.isArray(gap)) {
      throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless readiness response is invalid");
    }
    const entry = gap as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 3 ||
      typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.id) ||
      typeof entry.summary !== "string" || entry.summary.length === 0 || entry.summary.length > 500 ||
      (entry.owner !== "engineering" && entry.owner !== "operator")
    ) {
      throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless readiness response is invalid");
    }
    return {
      id: entry.id,
      summary: entry.summary,
      owner: entry.owner,
    } as const;
  });
  if ((record.canExecute && gaps.length !== 0) || (!record.canExecute && gaps.length === 0)) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless readiness response is inconsistent");
  }
  return {
    schema: "sutra.aws-agentless-readiness.v1",
    canExecute: record.canExecute,
    canPlan: true,
    gaps,
    summary: record.summary,
  };
}

export async function getAgentlessPlanProfile(): Promise<{
  readonly scanAccountId: string;
  readonly kmsReencrypt: boolean;
}> {
  const value = await brokerFetch<unknown>("/v1/agentless/plan-profile", "GET");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless plan profile is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.schema !== "sutra.aws-agentless-plan-profile.v1" ||
    typeof record.scanAccountId !== "string" ||
    !/^\d{12}$/u.test(record.scanAccountId) ||
    typeof record.kmsReencrypt !== "boolean"
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless plan profile is invalid");
  }
  return {
    scanAccountId: record.scanAccountId,
    kmsReencrypt: record.kmsReencrypt,
  };
}

export interface AgentlessTeardownSweepResource {
  readonly connectionId: string;
  readonly resourceId: string;
  readonly resourceKind: "snapshot" | "volume" | "instance";
  readonly accountScope: "customer" | "sutra-scan-account";
  readonly region: string;
}

export async function requestAgentlessTeardownSweep(input: {
  readonly tenantId: string;
  readonly operationId: string;
  readonly resources: readonly AgentlessTeardownSweepResource[];
}): Promise<{
  readonly outcomes: readonly {
    readonly resourceId: string;
    readonly disposition:
      | "settled"
      | "deleted"
      | "awaiting-customer"
      | "retry-failed"
      | "unknown";
    readonly detail: string;
  }[];
  readonly summary: { readonly considered: number; readonly stillOutstanding: number };
}> {
  const value = await brokerFetch<unknown>(
    "/v1/agentless/teardown-sweep",
    "POST",
    input,
    5 * 60_000,
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless cleanup response is invalid");
  }
  const record = value as Record<string, unknown>;
  const outcomes = record.outcomes;
  const summary = record.summary;
  if (
    Object.keys(record).sort().join(",") !== "outcomes,schema,summary" ||
    record.schema !== "sutra.aws-agentless-teardown-sweep.v1" ||
    !Array.isArray(outcomes) ||
    outcomes.length !== input.resources.length ||
    typeof summary !== "object" ||
    summary === null ||
    Array.isArray(summary)
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless cleanup response is invalid");
  }
  const expectedIds = new Set(input.resources.map((resource) => resource.resourceId));
  const parsedOutcomes = outcomes.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless cleanup response is invalid");
    }
    const outcome = value as Record<string, unknown>;
    if (
      Object.keys(outcome).sort().join(",") !== "detail,disposition,resourceId" ||
      typeof outcome.resourceId !== "string" ||
      !expectedIds.delete(outcome.resourceId) ||
      (outcome.disposition !== "settled" &&
        outcome.disposition !== "deleted" &&
        outcome.disposition !== "awaiting-customer" &&
        outcome.disposition !== "retry-failed" &&
        outcome.disposition !== "unknown") ||
      typeof outcome.detail !== "string" ||
      outcome.detail.length === 0 ||
      outcome.detail.length > 500
    ) {
      throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless cleanup response is invalid");
    }
    return {
      resourceId: outcome.resourceId,
      disposition: outcome.disposition,
      detail: outcome.detail,
    } as const;
  });
  const summaryRecord = summary as Record<string, unknown>;
  const dispositions = ["settled", "deleted", "awaitingCustomer", "retryFailed", "unknown"] as const;
  if (
    Object.keys(summaryRecord).sort().join(",") !==
      "awaitingCustomer,considered,deleted,retryFailed,settled,stillOutstanding,unknown" ||
    dispositions.some((key) =>
      !Number.isSafeInteger(summaryRecord[key]) ||
      (summaryRecord[key] as number) < 0) ||
    summaryRecord.considered !== parsedOutcomes.length ||
    summaryRecord.stillOutstanding !==
      parsedOutcomes.filter((outcome) =>
        outcome.disposition !== "settled" && outcome.disposition !== "deleted").length
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The agentless cleanup response is invalid");
  }
  return {
    outcomes: parsedOutcomes,
    summary: {
      considered: summaryRecord.considered as number,
      stillOutstanding: summaryRecord.stillOutstanding as number,
    },
  };
}

export async function registerCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: string;
  readonly roleArn: string;
  readonly externalId: string;
  readonly enabledRegions: readonly string[];
  readonly roleProvisioningMode: AwsRoleProvisioningMode;
  readonly expectedRolePath: string;
  readonly expectedRoleName: string;
}): Promise<{ registered: true }> {
  return parseRegisteredResponse(
    await brokerFetch<unknown>(`/v1/connections/${input.connectionId}`, "PUT", input),
  );
}

export async function activateCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly roleArn: string;
}): Promise<void> {
  const response = await brokerFetch<unknown>(
    `/v1/connections/${input.connectionId}/activate`,
    "POST",
    input,
  );
  assertLifecycleAcknowledgement(response, "activated");
}

export async function discardStagedCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly roleArn: string;
}): Promise<void> {
  const response = await brokerFetch<unknown>(
    `/v1/connections/${input.connectionId}/discard`,
    "POST",
    input,
  );
  assertLifecycleAcknowledgement(response, "discarded");
}

export async function disableCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
}): Promise<void> {
  const response = await brokerFetch<unknown>(
    `/v1/connections/${input.connectionId}/disable`,
    "POST",
    input,
  );
  assertLifecycleAcknowledgement(response, "disabled");
}

export async function offboardCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
}): Promise<void> {
  const response = await brokerFetch<unknown>(
    `/v1/connections/${input.connectionId}/offboard`,
    "POST",
    input,
  );
  assertLifecycleAcknowledgement(response, "offboarded");
}

function assertLifecycleAcknowledgement(
  value: unknown,
  key: "activated" | "discarded" | "disabled" | "offboarded",
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !(key in value) ||
    (value as Record<string, unknown>)[key] !== true
  ) {
    throw new PilotServerError(
      502,
      "BROKER_RESPONSE_INVALID",
      "The collector lifecycle acknowledgement was invalid",
    );
  }
}

export async function verifyCollectorConnection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly sessionNamePrefix: string;
}): Promise<{
  readonly verified: true;
  readonly accountId: string;
  readonly roleArn: string;
  readonly roleSessionName: string;
  readonly callerIdentityArn: string;
  readonly missingExternalIdDenied: true;
  readonly wrongExternalIdDenied: true;
  readonly trustPolicyAttested: true;
  readonly permissionPolicyAttested: true;
  readonly sessionPolicyApplied: true;
  readonly permissionPackVersion: "standard-2026-07.4";
  readonly capabilityAssessment: AwsPermissionCapabilityAssessment;
}> {
  const payload = { tenantId: input.tenantId, connectionId: input.connectionId, jobId: input.jobId };
  return parseVerificationResponse(
    await brokerFetch(`/v1/connections/${input.connectionId}/verify`, "POST", payload, 45_000),
    {
      accountId: input.accountId,
      partition: input.partition,
      roleArn: input.roleArn,
      sessionNamePrefix: input.sessionNamePrefix,
    },
  );
}

export async function runCollectorSync(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
}): Promise<{
  readonly snapshot: PilotSnapshotPayload;
  readonly rawEvidenceBytes: Uint8Array;
}> {
  const payload = { tenantId: input.tenantId, connectionId: input.connectionId, jobId: input.jobId };
  const response = await brokerFetchEnvelope<unknown>(
    `/v1/connections/${input.connectionId}/sync`,
    "POST",
    payload,
    LIVE_AWS_BROKER_TIMEOUT_MS,
  );
  return {
    snapshot: await parsePilotSnapshot(response.value, {
      jobId: input.jobId,
      connectionId: input.connectionId,
      accountId: input.accountId,
      partition: input.partition,
    }),
    rawEvidenceBytes: response.authenticatedBody,
  };
}

/**
 * Request one broker-bounded S3 range for canonical FinOps ingestion.
 *
 * The shared broker client authenticates the request and verifies the signed
 * response before returning. Temporary AWS credentials never enter this
 * process, and this function never accepts or returns an unbounded object.
 */
export async function runFinopsExportChunkRead(
  input: FinopsExportChunkRequest,
): Promise<unknown> {
  return brokerFetch<unknown>(
    `/v1/connections/${input.connectionId}/finops-export-chunk`,
    "POST",
    {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      jobId: input.jobId,
      contractId: input.contractId,
      exportName: input.exportName,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      key: input.key,
      offset: input.offset,
      maximumBytes: input.maximumBytes,
      versionId: input.versionId,
      ifMatch: input.ifMatch,
    },
    90_000,
  );
}

/**
 * Sends one exact Compute Optimizer object-range request over the existing
 * authenticated broker channel. The response is returned only after its
 * broker signature has been verified; AWS credentials never cross this edge.
 */
export async function runComputeOptimizerExportObjectChunkRead(
  input: ComputeOptimizerExportObjectChunkRequest,
  context: {
    readonly signal: AbortSignal;
    readonly deadlineAtMs: number;
  },
): Promise<unknown> {
  if (
    !(context.signal instanceof AbortSignal)
    || !Number.isSafeInteger(context.deadlineAtMs)
  ) {
    throw new PilotServerError(
      400,
      "INVALID_REQUEST",
      "The Compute Optimizer export object read boundary was invalid",
    );
  }
  const remainingMs = context.deadlineAtMs - Date.now();
  if (context.signal.aborted || remainingMs <= 0) {
    throw new PilotServerError(
      408,
      "REQUEST_TIMEOUT",
      "The Compute Optimizer export object read deadline elapsed",
    );
  }
  return (await brokerFetchEnvelope<unknown>(
    `/v1/connections/${input.connectionId}/compute-optimizer-export-object-chunk`,
    "POST",
    {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      jobId: input.jobId,
      contractId: input.contractId,
      plannedJobId: input.plannedJobId,
      region: input.region,
      bucket: input.bucket,
      key: input.key,
      offset: input.offset,
      maximumBytes: input.maximumBytes,
      versionId: input.versionId,
      ifMatch: input.ifMatch,
    },
    Math.min(90_000, remainingMs),
    context.signal,
  )).value;
}

export interface FinopsSourceCollectionResult {
  readonly schemaVersion: "sutra.finops-source-dispatch.v1";
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
  readonly sourceId: FinopsSourceId;
  readonly configured: boolean;
  readonly implementationState: "NOT_CONFIGURED" | "NOT_IMPLEMENTED" | "IMPLEMENTED";
  readonly collectionStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string | null;
  readonly collectedAt: string;
  readonly dataThroughAt: string | null;
  readonly coverage: {
    readonly pagesObserved: number;
    readonly recordsObserved: number;
    readonly recordsAccepted: number;
    readonly recordsRejected: number;
    readonly recordsOmitted: number;
  };
  readonly evidence: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly limitations: readonly string[];
}

const FINOPS_SOURCE_RESULT_KEYS = [
  "schemaVersion",
  "tenantId",
  "connectionId",
  "jobId",
  "contractId",
  "sourceId",
  "configured",
  "implementationState",
  "collectionStatus",
  "accountId",
  "partition",
  "region",
  "collectedAt",
  "dataThroughAt",
  "coverage",
  "evidence",
  "errorCode",
  "limitations",
] as const;
const FINOPS_SOURCE_COVERAGE_KEYS = [
  "pagesObserved",
  "recordsObserved",
  "recordsAccepted",
  "recordsRejected",
  "recordsOmitted",
] as const;
const FINOPS_SOURCE_ACCOUNT_ID = /^\d{12}$/u;
const FINOPS_SOURCE_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const FINOPS_SOURCE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const FINOPS_SOURCE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const FINOPS_SOURCE_CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function exactFinopsRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === expectedKeys.length && actual.every((key) => expectedKeys.includes(key))
    ? record
    : null;
}

function normalizedFinopsIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value ? value : null;
}

function boundedFinopsCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finopsRegionMatchesPartition(
  region: string,
  partition: AwsPartition,
): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function safeFinopsJson(
  value: unknown,
  depth = 0,
  budget: { remaining: number } = { remaining: 100_000 },
): boolean {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 16_384 && !value.includes("\0");
  if (Array.isArray(value)) {
    return value.length <= 25_000 && value.every((entry) => safeFinopsJson(entry, depth + 1, budget));
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 2_000 && entries.every(([key, entry]) =>
    key.length > 0 && key.length <= 256 && !key.includes("\0") &&
    safeFinopsJson(entry, depth + 1, budget));
}

/**
 * Re-validates the signed broker result against server-resolved connection and
 * source identity. A syntactically valid response cannot redirect evidence to
 * another tenant, connection, contract, account, partition, or source.
 */
export function parseFinopsSourceCollectionResult(
  value: unknown,
  expected: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly jobId: string;
    readonly contractId: string;
    readonly sourceId: FinopsSourceId;
    readonly accountId: string;
    readonly partition: AwsPartition;
  },
): FinopsSourceCollectionResult {
  const record = exactFinopsRecord(value, FINOPS_SOURCE_RESULT_KEYS);
  const coverage = exactFinopsRecord(record?.coverage, FINOPS_SOURCE_COVERAGE_KEYS);
  const collectedAt = normalizedFinopsIso(record?.collectedAt);
  const dataThroughAt = record?.dataThroughAt === null
    ? null
    : normalizedFinopsIso(record?.dataThroughAt);
  const region = record?.region;
  const evidence = record?.evidence;
  const limitations = record?.limitations;
  const errorCode = record?.errorCode;
  if (
    record === null || coverage === null ||
    record.schemaVersion !== "sutra.finops-source-dispatch.v1" ||
    record.tenantId !== expected.tenantId ||
    record.connectionId !== expected.connectionId ||
    record.jobId !== expected.jobId ||
    record.contractId !== expected.contractId ||
    record.sourceId !== expected.sourceId ||
    record.accountId !== expected.accountId || !FINOPS_SOURCE_ACCOUNT_ID.test(expected.accountId) ||
    record.partition !== expected.partition ||
    typeof record.configured !== "boolean" ||
    !new Set(["NOT_CONFIGURED", "NOT_IMPLEMENTED", "IMPLEMENTED"]).has(String(record.implementationState)) ||
    !new Set(["COMPLETE", "PARTIAL", "UNAVAILABLE"]).has(String(record.collectionStatus)) ||
    (region !== null && (
      typeof region !== "string" ||
      !FINOPS_SOURCE_REGION.test(region) ||
      !finopsRegionMatchesPartition(region, expected.partition)
    )) ||
    collectedAt === null ||
    (record.dataThroughAt !== null && dataThroughAt === null) ||
    (dataThroughAt !== null && dataThroughAt > collectedAt) ||
    !FINOPS_SOURCE_COVERAGE_KEYS.every((key) => boundedFinopsCount(coverage[key])) ||
    (coverage.recordsAccepted as number) + (coverage.recordsRejected as number) +
      (coverage.recordsOmitted as number) > (coverage.recordsObserved as number) ||
    !Array.isArray(limitations) || limitations.length > 256 ||
    limitations.some((entry) => typeof entry !== "string" || !FINOPS_SOURCE_CODE.test(entry)) ||
    (errorCode !== null && (typeof errorCode !== "string" || !FINOPS_SOURCE_CODE.test(errorCode))) ||
    (evidence !== null && (
      typeof evidence !== "object" || Array.isArray(evidence) || !safeFinopsJson(evidence)
    )) ||
    (record.collectionStatus === "UNAVAILABLE" && evidence !== null) ||
    (record.collectionStatus !== "UNAVAILABLE" && (
      record.configured !== true || record.implementationState !== "IMPLEMENTED" || evidence === null
    )) ||
    (record.collectionStatus === "COMPLETE" && (
      errorCode !== null || dataThroughAt === null ||
      coverage.recordsRejected !== 0 || coverage.recordsOmitted !== 0 ||
      coverage.recordsAccepted !== coverage.recordsObserved
    )) ||
    ((record.implementationState === "NOT_CONFIGURED" || record.implementationState === "NOT_IMPLEMENTED") &&
      record.collectionStatus !== "UNAVAILABLE")
  ) {
    throw new PilotServerError(
      502,
      "BROKER_RESPONSE_INVALID",
      "The collector returned invalid FinOps source evidence",
    );
  }
  return record as unknown as FinopsSourceCollectionResult;
}

/**
 * Calls the server-owned FinOps source endpoint through the authenticated
 * broker boundary. AWS operations and provider filters are deliberately absent
 * from this contract; the persisted contract and collector catalog own them.
 */
export async function runFinopsSourceCollection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
  readonly sourceId: FinopsSourceId;
  readonly accountId: string;
  readonly partition: AwsPartition;
}): Promise<FinopsSourceCollectionResult> {
  if (
    !FINOPS_SOURCE_IDENTIFIER.test(input.tenantId) ||
    !FINOPS_SOURCE_CONNECTION_ID.test(input.connectionId) ||
    !FINOPS_SOURCE_IDENTIFIER.test(input.jobId) ||
    !FINOPS_SOURCE_IDENTIFIER.test(input.contractId) ||
    !FINOPS_SOURCE_IDENTIFIER.test(input.sourceId) ||
    !FINOPS_SOURCE_ACCOUNT_ID.test(input.accountId) ||
    !new Set<AwsPartition>(["aws", "aws-us-gov", "aws-cn"]).has(input.partition)
  ) {
    throw new PilotServerError(
      400,
      "INVALID_INPUT",
      "The FinOps source collection identity is invalid",
    );
  }
  const value = await brokerFetch<unknown>(
    `/v1/connections/${input.connectionId}/finops-source`,
    "POST",
    {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      jobId: input.jobId,
      contractId: input.contractId,
    },
    90_000,
  );
  return parseFinopsSourceCollectionResult(value, input);
}

/**
 * Requests a complete, broker-signed Organizations account taxonomy for one
 * pinned management-account connection. The app never supplies AWS operations,
 * endpoint, region, credentials, pagination tokens, or the signing key.
 */
export async function runSignedOrganizationsTaxonomy(input: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
}): Promise<unknown> {
  if (
    !FINOPS_SOURCE_IDENTIFIER.test(input.tenantId)
    || !FINOPS_SOURCE_IDENTIFIER.test(input.customerId)
    || !FINOPS_SOURCE_CONNECTION_ID.test(input.connectionId)
    || !FINOPS_SOURCE_IDENTIFIER.test(input.jobId)
    || !FINOPS_SOURCE_IDENTIFIER.test(input.contractId)
  ) {
    throw new PilotServerError(
      400,
      "INVALID_INPUT",
      "The signed Organizations taxonomy identity is invalid",
    );
  }
  return await brokerFetch<unknown>(
    `/v1/connections/${input.connectionId}/organizations-taxonomy`,
    "POST",
    {
      tenantId: input.tenantId,
      customerId: input.customerId,
      connectionId: input.connectionId,
      jobId: input.jobId,
      contractId: input.contractId,
    },
    150_000,
  );
}

export async function runCollectorCostCollection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
}): Promise<AwsCostSnapshot> {
  const payload = { tenantId: input.tenantId, connectionId: input.connectionId, jobId: input.jobId };
  return parseAwsCostSnapshot(
    await brokerFetch<unknown>(
      `/v1/connections/${input.connectionId}/costs`,
      "POST",
      payload,
      90_000,
    ),
    input.accountId,
  );
}

export async function runCollectorSecurityEventCollection(input: {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly windowStart: string;
  readonly windowEnd: string;
}): Promise<AwsSecurityEventCollection> {
  const payload = {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    jobId: input.jobId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  };
  return parseAwsSecurityEventCollection(
    await brokerFetch<unknown>(
      `/v1/connections/${input.connectionId}/security-events`,
      "POST",
      payload,
      120_000,
    ),
    input.accountId,
  );
}

export async function getLocalFixtureCatalog(): Promise<readonly LocalFixtureDescriptor[]> {
  return parseLocalFixtureCatalog(await brokerFetch<unknown>("/v1/local/fixtures", "GET"));
}

export async function listLocalFixtureJobs(
  limit = 50,
  scope?: { readonly tenantId: string; readonly customerId: string },
  options: { readonly reviewRequired?: boolean } = {},
): Promise<readonly LocalFixtureJobSummary[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PilotServerError(400, "INVALID_INPUT", "The local job limit is invalid");
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (scope !== undefined) {
    query.set("tenantId", scope.tenantId);
    query.set("customerId", scope.customerId);
  }
  if (options.reviewRequired === true) query.set("reviewRequired", "true");
  return parseLocalFixtureJobs(
    await brokerFetch<unknown>(`/v1/local/jobs?${query.toString()}`, "GET"),
  );
}

export async function enqueueLocalFixtureJob(input: {
  readonly fixture: LocalFixtureDescriptor;
  readonly version: LocalFixtureVersion;
  readonly idempotencyKey: string;
}): Promise<{ readonly created: boolean; readonly job: LocalFixtureJobSummary }> {
  const payload = {
    tenantId: input.fixture.tenantId,
    fixtureId: input.fixture.fixtureId,
    version: input.version,
    idempotencyKey: input.idempotencyKey,
  };
  return parseLocalFixtureEnqueue(
    await brokerFetch<unknown>("/v1/local/jobs/simulated-sync", "POST", payload),
    input.fixture,
    input.version,
  );
}

export async function getLocalFixtureJobResult(input: {
  readonly jobId: string;
  readonly fixture: LocalFixtureDescriptor;
}): Promise<LocalFixtureJobResult> {
  const query = new URLSearchParams({
    tenantId: input.fixture.tenantId,
    customerId: input.fixture.customerId,
  });
  return parseLocalFixtureResultFromCatalog(
    await brokerFetch<unknown>(
      `/v1/local/jobs/${input.jobId}/result?${query.toString()}`,
      "GET",
      undefined,
      30_000,
    ),
    [input.fixture],
    input.jobId,
  );
}

export async function acknowledgeLocalFixtureJobPublication(input: {
  readonly fixture: LocalFixtureDescriptor;
  readonly jobId: string;
  readonly publicationId: string;
  readonly publishedAt: string;
}): Promise<void> {
  const response = await brokerFetch<unknown>(
    `/v1/local/jobs/${input.jobId}/published`,
    "POST",
    {
      tenantId: input.fixture.tenantId,
      customerId: input.fixture.customerId,
      publicationId: input.publicationId,
      publishedAt: input.publishedAt,
    },
  );
  if (
    typeof response !== "object" || response === null || Array.isArray(response) ||
    Object.keys(response).join(",") !== "acknowledged" ||
    !("acknowledged" in response) || response.acknowledged !== true
  ) {
    throw new PilotServerError(
      502,
      "BROKER_RESPONSE_INVALID",
      "The collector publication acknowledgement was invalid",
    );
  }
}

export async function localFixtureScheduleId(tenantId: string, fixtureId: string): Promise<string> {
  return `sched_${(await sha256Hex(`local-fixture-schedule\u0000${tenantId}\u0000${fixtureId}`)).slice(0, 48)}`;
}

export async function getLocalFixtureSchedules(
  fixture: LocalFixtureDescriptor,
): Promise<readonly LocalFixtureSchedule[]> {
  const query = new URLSearchParams({
    tenantId: fixture.tenantId,
    customerId: fixture.customerId,
  });
  const schedules = parseLocalFixtureSchedules(
    await brokerFetch<unknown>(`/v1/local/schedules?${query.toString()}`, "GET"),
  );
  if (schedules.some((schedule) => !scheduleMatchesFixture(schedule, fixture))) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector schedule scope is invalid");
  }
  return schedules;
}

export async function upsertLocalFixtureSchedule(input: {
  readonly fixture: LocalFixtureDescriptor;
  readonly scheduleId: string;
  readonly mutationId: string;
  readonly mutationSequence: number;
  readonly version: LocalFixtureVersion;
  readonly everyMs: number;
  readonly enabled: boolean;
  readonly firstRunAt: string;
}): Promise<LocalFixtureSchedule> {
  const schedule = parseLocalFixtureScheduleResponse(await brokerFetch<unknown>(
    `/v1/local/schedules/${input.scheduleId}`,
    "PUT",
    {
      tenantId: input.fixture.tenantId,
      mutationId: input.mutationId,
      mutationSequence: input.mutationSequence,
      fixtureId: input.fixture.fixtureId,
      version: input.version,
      everyMs: input.everyMs,
      enabled: input.enabled,
      firstRunAt: input.firstRunAt,
    },
  ));
  if (
    schedule.scheduleId !== input.scheduleId ||
    schedule.version !== input.version ||
    schedule.everyMs !== input.everyMs ||
    schedule.enabled !== input.enabled ||
    !scheduleMatchesFixture(schedule, input.fixture)
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector schedule response is invalid");
  }
  return schedule;
}

export async function setLocalFixtureScheduleEnabled(input: {
  readonly fixture: LocalFixtureDescriptor;
  readonly scheduleId: string;
  readonly mutationId: string;
  readonly mutationSequence: number;
  readonly enabled: boolean;
}): Promise<LocalFixtureSchedule> {
  const schedule = parseLocalFixtureScheduleResponse(await brokerFetch<unknown>(
    `/v1/local/schedules/${input.scheduleId}/enabled`,
    "POST",
    {
      tenantId: input.fixture.tenantId,
      enabled: input.enabled,
      mutationId: input.mutationId,
      mutationSequence: input.mutationSequence,
    },
  ));
  if (
    schedule.scheduleId !== input.scheduleId ||
    schedule.enabled !== input.enabled ||
    !scheduleMatchesFixture(schedule, input.fixture)
  ) {
    throw new PilotServerError(502, "BROKER_RESPONSE_INVALID", "The collector schedule response is invalid");
  }
  return schedule;
}

function scheduleMatchesFixture(
  schedule: LocalFixtureSchedule,
  fixture: LocalFixtureDescriptor,
): boolean {
  return schedule.tenantId === fixture.tenantId &&
    schedule.fixtureId === fixture.fixtureId &&
    schedule.customerId === fixture.customerId &&
    schedule.connectionId === fixture.connectionId &&
    fixture.availableVersions.includes(schedule.version);
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
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "REQUEST_FAILED";
  const safeCodes = new Set([
    "AUTHENTICATION_REQUIRED",
    "AUTHORIZATION_DENIED",
    "BOOTSTRAP_ALREADY_COMPLETED",
    "CONFLICT",
    "INVALID_CREDENTIALS",
    "INVALID_INPUT",
    "INVALID_STATE",
    "MFA_ALREADY_ENROLLED",
    "MFA_CODE_INVALID",
    "MFA_ENROLLMENT_REQUIRED",
    "MFA_RECENT_REQUIRED",
    "MFA_REQUIRED",
    "NOT_FOUND",
    "TURNSTILE_CONFIGURATION_INVALID",
    "TURNSTILE_REJECTED",
    "TURNSTILE_REQUIRED",
    "TURNSTILE_UNAVAILABLE",
  ]);
  const publicMessage = safeCodes.has(code) && typeof candidate?.message === "string"
    ? candidate.message
    : "Sutra could not complete the request";
  const candidateStatus = typeof candidate?.status === "number" ? candidate.status : null;
  const status = candidateStatus !== null && [400, 401, 403, 404, 409, 429, 503].includes(candidateStatus)
    ? candidateStatus
    : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : code === "INVALID_INPUT" ? 400 : code === "INVALID_STATE" ? 409 : 500;
  const requestId = crypto.randomUUID();
  if (runtimeEnv().SUTRA_LOCAL_MODE === "true") {
    const diagnostic = typeof candidate?.message === "string"
      ? candidate.message
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED]")
        .replace(/\b[A-Za-z0-9_-]{43,}\b/gu, "[REDACTED]")
        .slice(0, 500)
      : "Non-error failure";
    console.error(JSON.stringify({ event: "sutra.request.failed", requestId, code, status, diagnostic }));
  }
  return jsonResponse({ error: { code, message: publicMessage, requestId } }, { status });
}

export function safeValidationFailureCode(error: unknown): string {
  const code = error instanceof PilotServerError ? error.code : "VALIDATION_FAILED";
  return new Set([
    "ASSUME_ROLE_DENIED",
    "ASSUME_ROLE_FAILED",
    "BROKER_UNAVAILABLE",
    "CALLER_IDENTITY_MISMATCH",
    "NEGATIVE_PROBE_INCONCLUSIVE",
    "TRUST_POLICY_UNSAFE",
  ]).has(code) ? code : "VALIDATION_FAILED";
}

export function safeCollectionFailureCode(error: unknown): string {
  const code = error instanceof PilotServerError ? error.code : "COLLECTION_FAILED";
  return new Set([
    "ASSUME_ROLE_DENIED",
    "BROKER_UNAVAILABLE",
    "CALLER_IDENTITY_MISMATCH",
    "NEGATIVE_PROBE_INCONCLUSIVE",
    "PERMISSION_DENIED",
    "THROTTLED",
    "TRUST_POLICY_UNSAFE",
  ]).has(code)
    ? code
    : "COLLECTION_FAILED";
}
