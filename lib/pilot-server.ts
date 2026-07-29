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

interface PilotRuntimeEnv {
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_CONNECTION_ENCRYPTION_KEY?: string;
  readonly SUTRA_CONNECTION_KEY_VERSION?: string;
  readonly SUTRA_BROKER_SHARED_SECRET?: string;
  readonly SUTRA_BROKER_URL?: string;
}

export type PilotActor = AuthorizedPilotActor;

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

export function requirePilotActor(
  request: Request,
  capability: Capability = "workspace:read",
  customerId?: string,
): Promise<PilotActor> {
  return authorizePilotRequest(request, capability, customerId);
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
    BROKER_REQUEST_FAILED: "The AWS collector rejected the request",
  };
  return messages[code] ?? messages.BROKER_REQUEST_FAILED;
}

/**
 * Starts an agentless scan in the collector.
 *
 * The Worker cannot execute one itself: workerd holds no AWS SDK and no AWS
 * credentials, by design. The collector owns the SDK, the role broker and the
 * workload identity, so this hands over the approved plan and the resolved settings
 * and gets back a 202 — the scan outlives any HTTP request, so the poll below is how
 * its outcome is learned.
 */
export async function startAgentlessScan(input: {
  readonly runId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly region: string;
  readonly plan: unknown;
  readonly settings: unknown;
}): Promise<{ readonly runId: string; readonly phase: string; readonly startedAt: string }> {
  return brokerFetch(
    `/v1/agentless/scans/${input.runId}/execute`,
    "POST",
    {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      region: input.region,
      plan: input.plan,
      settings: input.settings,
    },
  );
}

/** Polls a scan. An untracked run is a 404 from the collector, which is NOT "clean". */
export async function readAgentlessRun(input: {
  readonly runId: string;
  readonly tenantId: string;
  readonly connectionId: string;
}): Promise<unknown> {
  const query = new URLSearchParams({
    tenantId: input.tenantId,
    connectionId: input.connectionId,
  });
  return brokerFetch(`/v1/agentless/scans/${input.runId}?${query.toString()}`, "GET");
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
  readonly permissionPackVersion: "standard-2026-07.3";
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
}): Promise<PilotSnapshotPayload> {
  const payload = { tenantId: input.tenantId, connectionId: input.connectionId, jobId: input.jobId };
  return parsePilotSnapshot(
    await brokerFetch<unknown>(
      `/v1/connections/${input.connectionId}/sync`,
      "POST",
      payload,
      LIVE_AWS_BROKER_TIMEOUT_MS,
    ),
    {
      jobId: input.jobId,
      connectionId: input.connectionId,
      accountId: input.accountId,
      partition: input.partition,
    },
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
