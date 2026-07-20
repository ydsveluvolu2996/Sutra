import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildFixtureSnapshot,
  finalizePilotSnapshot,
  fixtureCallerIdentityArn,
  fixtureRoleSessionName,
  type PilotCoverageEntry,
  type PilotFinding,
  type PilotRelationship,
  type PilotResource,
  type PilotSnapshot,
} from "./fixture-inventory.js";
import {
  EncryptedFileConnectionRegistry,
  RegistryConnectionNotFoundError,
  RegistryError,
  RegistryStateError,
  type LocalAwsPartition,
  type RegisteredAwsConnection,
} from "./local-registry.js";
import {
  DurableLocalScheduler,
  DurableLocalJobQueue,
  LocalJobIdempotencyConflictError,
  LocalJobQueueError,
  LocalJobValidationError,
  LocalScheduleNotFoundError,
  LocalScheduleStaleMutationError,
} from "./durable-job-queue.js";
import {
  createLocalFixtureCollectionJobPayload,
  executeLocalFixtureCollectionJob,
  getLocalFixtureAccount,
  listLocalFixtureAccounts,
  LOCAL_FIXTURE_COLLECTION_JOB_KIND,
  LocalFixtureCatalogError,
  type LocalFixtureCollectionJobResult,
  type LocalFixtureVersion,
} from "./local-fixture-catalog.js";
import {
  JsonFileLocalJobStateStore,
  LocalJobStateError,
  type LocalJobRecord,
  type LocalScheduleRecord,
  type LocalJobStateStore,
} from "./local-job-state.js";
import { createWorkloadIdentityRoleBroker, parseIamRoleArn } from "./role-broker.js";
import { runSandboxIdentityPreflight } from "./aws-sandbox-preflight.js";
import {
  RequestAuthenticationError,
  RequestAuthenticator,
} from "./request-auth.js";
import {
  CollectorError,
  CURRENT_PERMISSION_PACK_VERSION,
  type AwsInventoryBatch,
  type AwsInventorySink,
  type InventoryCollectorCoverage,
  type NormalizedAwsEvidence,
  type NormalizedAwsResource,
  type OnboardingTrustVerification,
  type SafeJsonObject,
  type SafeJsonValue,
} from "./types.js";
import { isValidAwsRegionSelection } from "./aws-region-selection.js";

const HOST = "127.0.0.1";
const PORT = 8788;
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 12 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ACCOUNT_ID = /^\d{12}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_+=,.@:/-]{20,128}$/;
const CONNECTION_PATH = /^\/v1\/connections\/([A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})$/;
const CONNECTION_ACTION_PATH =
  /^\/v1\/connections\/([A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})\/(verify|activate|discard|sync|costs|utilization|security-events|disable|offboard)$/;
const LOCAL_JOB_RESULT_PATH = /^\/v1\/local\/jobs\/(job_[a-f0-9]{48})\/result$/;
const LOCAL_JOB_PUBLISHED_PATH = /^\/v1\/local\/jobs\/(job_[a-f0-9]{48})\/published$/;
const LOCAL_SCHEDULE_PATH = /^\/v1\/local\/schedules\/(sched_[a-f0-9]{48})$/;
const LOCAL_SCHEDULE_ENABLED_PATH =
  /^\/v1\/local\/schedules\/(sched_[a-f0-9]{48})\/enabled$/;
const LOCAL_SCHEDULE_ID = /^sched_[a-f0-9]{48}$/;
const LOCAL_SCHEDULE_MUTATION_ID = /^schedop_[a-f0-9]{48}$/;
const FIXTURE_PRINCIPAL = "arn:aws:iam::999988887777:role/SutraLocalCollector";
const DEFAULT_LOCAL_JOB_LIMIT = 50;
const MAX_LOCAL_JOB_LIMIT = 100;
const MAX_LOCAL_SCHEDULE_CATCH_UP = 5;
const LIVE_RESOURCE_LIMIT = 10_000;
const LIVE_EVIDENCE_LIMIT = 5_000;
const EVIDENCE_BUDGET_COLLECTOR_KEY = "sutra.evidence-budget";
const RESOURCE_BUDGET_COLLECTOR_KEY = "sutra.resource-budget";
const SNAPSHOT_BUDGET_COLLECTOR_KEY = "sutra.snapshot-budget";
const LIVE_SNAPSHOT_RESOURCE_BUDGET_BYTES = 4 * 1024 * 1024;
const LIVE_SNAPSHOT_RELATIONSHIP_BUDGET_BYTES = 1024 * 1024;
const LIVE_SNAPSHOT_FINDING_BUDGET_BYTES = 2 * 1024 * 1024;
export const LIVE_SNAPSHOT_RESPONSE_BUDGET_BYTES = 10 * 1024 * 1024;
const SECURITY_EVENT_OPERATION_DEADLINE_MS = 105_000;
const MIN_LOCAL_SCHEDULE_INTERVAL_MS = 1_000;
const MAX_LOCAL_SCHEDULE_INTERVAL_MS = 31_536_000_000;
const LOCAL_JOB_AVAILABLE_AT = new Date(0);

export type LocalFixtureJobExecutor = typeof executeLocalFixtureCollectionJob;

export interface LocalCollectorServerOptions {
  readonly sharedSecret: string;
  readonly registryEncryptionKey: string;
  readonly registryPath: string;
  readonly mode?: "fixture" | "live";
  readonly allowLiveAws?: boolean;
  readonly principalArn?: string;
  readonly now?: () => Date;
  readonly localJobStatePath?: string;
  readonly localJobStore?: LocalJobStateStore;
  readonly localJobWorkerEnabled?: boolean;
  readonly localJobWorkerId?: string;
  readonly localJobPollIntervalMs?: number;
  readonly localJobLeaseMs?: number;
  readonly localJobBaseBackoffMs?: number;
  readonly localJobMaxBackoffMs?: number;
  readonly localScheduleMaxCatchUpPerTick?: number;
  readonly localFixtureJobExecutor?: LocalFixtureJobExecutor;
}

interface ServerContext {
  readonly mode: "fixture" | "live";
  readonly principalArn: string;
  readonly sourceAccountId: string;
  readonly now: () => Date;
  readonly registry: EncryptedFileConnectionRegistry;
  readonly authenticator: RequestAuthenticator;
  readonly activeConnectionOperations: Set<string>;
  readonly lifecycleMutations: Set<string>;
  readonly localJobs: LocalJobsContext | null;
}

interface LocalJobsContext {
  readonly queue: DurableLocalJobQueue;
  readonly scheduler: DurableLocalScheduler;
  readonly worker: LocalFixtureJobWorker;
  readonly tenantIds: readonly string[];
}

interface ScopedJob {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
}

interface LocalFixtureJobInput {
  readonly tenantId: string;
  readonly fixtureId: string;
  readonly version: LocalFixtureVersion;
  readonly idempotencyKey: string;
}

interface LocalJobListQuery {
  readonly limit: number;
  readonly tenantId?: string;
  readonly customerId?: string;
  readonly reviewRequired?: boolean;
}

interface LocalJobResultQuery {
  readonly tenantId: string;
  readonly customerId: string;
}

interface LocalScheduleListQuery {
  readonly tenantId: string;
  readonly customerId: string;
}

interface LocalScheduleUpsertInput {
  readonly tenantId: string;
  readonly mutationId: string;
  readonly mutationSequence: number;
  readonly fixtureId: string;
  readonly version: LocalFixtureVersion;
  readonly everyMs: number;
  readonly enabled: boolean;
  readonly firstRunAt: Date;
}

export function createLocalCollectorServer(options: LocalCollectorServerOptions): Server {
  const mode = options.mode ?? "fixture";
  if (mode !== "fixture" && mode !== "live") {
    throw new Error("SUTRA_COLLECTOR_MODE must be fixture or live");
  }
  if (mode === "live" && options.allowLiveAws !== true) {
    throw new Error(
      "Live AWS access is disabled; an explicitly authorized sandbox requires SUTRA_ALLOW_LIVE_AWS=true",
    );
  }
  const principalArn = options.principalArn ?? (mode === "fixture" ? FIXTURE_PRINCIPAL : "");
  if (principalArn.length === 0) {
    throw new Error("SUTRA_COLLECTOR_PRINCIPAL_ARN is required in live mode");
  }
  const parsedPrincipal = parseIamRoleArn(principalArn);
  const now = options.now ?? (() => new Date());
  const localJobs =
    mode === "fixture"
      ? createLocalJobsContext(options, now)
      : null;
  const context: ServerContext = {
    mode,
    principalArn,
    sourceAccountId: parsedPrincipal.accountId,
    now,
    registry: new EncryptedFileConnectionRegistry({
      filePath: options.registryPath,
      encryptionKey: options.registryEncryptionKey,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    authenticator: new RequestAuthenticator({
      sharedSecret: options.sharedSecret,
      ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
    }),
    activeConnectionOperations: new Set(),
    lifecycleMutations: new Set(),
    localJobs,
  };

  const server = createServer((request, response) => {
    void dispatch(context, request, response);
  });
  server.requestTimeout = 190_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  if (localJobs !== null) {
    server.on("listening", () => localJobs.worker.start());
    server.on("close", () => localJobs.worker.stop());
  }
  return server;
}

export async function startLocalCollectorServer(): Promise<Server> {
  const principalArn = process.env.SUTRA_COLLECTOR_PRINCIPAL_ARN?.trim();
  const mode = collectorMode(process.env.SUTRA_COLLECTOR_MODE);
  const allowLiveAws = exactBooleanEnvironment("SUTRA_ALLOW_LIVE_AWS", false);
  if (mode === "live") {
    if (!allowLiveAws) {
      throw new Error(
        "Live AWS access is disabled; an explicitly authorized sandbox requires SUTRA_ALLOW_LIVE_AWS=true",
      );
    }
    if (principalArn === undefined || principalArn.length === 0) {
      throw new Error("SUTRA_COLLECTOR_PRINCIPAL_ARN is required in live mode");
    }
    await runSandboxIdentityPreflight(principalArn);
  }
  const server = createLocalCollectorServer({
    sharedSecret: requiredEnvironment("SUTRA_BROKER_SHARED_SECRET"),
    registryEncryptionKey: requiredEnvironment("SUTRA_REGISTRY_ENCRYPTION_KEY"),
    registryPath:
      process.env.SUTRA_REGISTRY_PATH?.trim() ||
      resolvePath(process.cwd(), ".sutra", "connections.enc.json"),
    localJobStatePath:
      process.env.SUTRA_LOCAL_JOBS_PATH?.trim() ||
      resolvePath(process.cwd(), ".sutra", "local-jobs.json"),
    mode,
    allowLiveAws,
    ...(principalArn === undefined || principalArn.length === 0 ? {} : { principalArn }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function createLocalJobsContext(
  options: LocalCollectorServerOptions,
  now: () => Date,
): LocalJobsContext {
  const store =
    options.localJobStore ??
    new JsonFileLocalJobStateStore({
      filePath:
        options.localJobStatePath ??
        resolvePath(process.cwd(), ".sutra", "local-jobs.json"),
    });
  const queue = new DurableLocalJobQueue({
    store,
    now,
    ...(options.localJobBaseBackoffMs === undefined
      ? {}
      : { baseBackoffMs: options.localJobBaseBackoffMs }),
    ...(options.localJobMaxBackoffMs === undefined
      ? {}
      : { maxBackoffMs: options.localJobMaxBackoffMs }),
  });
  const scheduler = new DurableLocalScheduler({
    store,
    now,
    maxCatchUpPerSchedule:
      options.localScheduleMaxCatchUpPerTick ?? MAX_LOCAL_SCHEDULE_CATCH_UP,
  });
  const tenantIds = [
    ...new Set(listLocalFixtureAccounts().map((fixture) => fixture.tenantId)),
  ].sort();
  const worker = new LocalFixtureJobWorker({
    queue,
    scheduler,
    now,
    enabled: options.localJobWorkerEnabled ?? true,
    workerId: options.localJobWorkerId ?? `collector-${process.pid}`,
    pollIntervalMs: options.localJobPollIntervalMs ?? 250,
    leaseMs: options.localJobLeaseMs ?? 30_000,
    execute: options.localFixtureJobExecutor ?? executeLocalFixtureCollectionJob,
  });
  return { queue, scheduler, worker, tenantIds };
}

class LocalFixtureJobWorker {
  private readonly queue: DurableLocalJobQueue;
  private readonly scheduler: DurableLocalScheduler;
  private readonly now: () => Date;
  private readonly enabled: boolean;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly execute: LocalFixtureJobExecutor;
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickRunning = false;

  public constructor(options: {
    readonly queue: DurableLocalJobQueue;
    readonly scheduler: DurableLocalScheduler;
    readonly now: () => Date;
    readonly enabled: boolean;
    readonly workerId: string;
    readonly pollIntervalMs: number;
    readonly leaseMs: number;
    readonly execute: LocalFixtureJobExecutor;
  }) {
    if (!IDENTIFIER.test(options.workerId)) {
      throw new Error("localJobWorkerId is invalid");
    }
    if (
      !Number.isInteger(options.pollIntervalMs) ||
      options.pollIntervalMs < 5 ||
      options.pollIntervalMs > 60_000
    ) {
      throw new Error("localJobPollIntervalMs must be between 5 and 60000");
    }
    if (
      !Number.isInteger(options.leaseMs) ||
      options.leaseMs < 1_000 ||
      options.leaseMs > 86_400_000
    ) {
      throw new Error("localJobLeaseMs must be between 1000 and 86400000");
    }
    this.queue = options.queue;
    this.scheduler = options.scheduler;
    this.now = options.now;
    this.enabled = options.enabled;
    this.workerId = options.workerId;
    this.pollIntervalMs = options.pollIntervalMs;
    this.leaseMs = options.leaseMs;
    this.execute = options.execute;
  }

  public start(): void {
    if (!this.enabled || this.timer !== undefined) return;
    this.scheduleTick();
    this.timer = setInterval(() => this.scheduleTick(), this.pollIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private scheduleTick(): void {
    if (this.tickRunning) return;
    this.tickRunning = true;
    void this.tick().finally(() => {
      this.tickRunning = false;
    });
  }

  private async tick(): Promise<void> {
    try {
      await this.scheduler.runDueSchedules();
    } catch {
      // Scheduler state is retried later, but existing queue work must still run.
    }
    try {
      await this.queue.recoverExpiredLeases();
      for (let processed = 0; processed < 25; processed += 1) {
        const job = await this.queue.leaseNext({
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          kinds: [LOCAL_FIXTURE_COLLECTION_JOB_KIND],
        });
        if (job === null || job.lease === undefined) return;
        try {
          const result = this.execute({
            jobId: job.jobId,
            tenantId: job.tenantId,
            payload: job.payload,
            now: this.now(),
          });
          await this.queue.complete({
            tenantId: job.tenantId,
            jobId: job.jobId,
            leaseToken: job.lease.token,
            result: fixtureResultToSafeObject(result),
          });
        } catch {
          await this.queue.fail({
            tenantId: job.tenantId,
            jobId: job.jobId,
            leaseToken: job.lease.token,
            code: "LOCAL_FIXTURE_COLLECTION_FAILED",
            message: "The local fixture inventory collection did not complete",
          });
        }
      }
    } catch {
      // A later tick retries queue state access. Never crash the collector process.
    }
  }
}

function fixtureResultToSafeObject(
  result: LocalFixtureCollectionJobResult,
): SafeJsonObject {
  return structuredClone(result) as unknown as SafeJsonObject;
}

async function dispatch(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const rawUrl = request.url ?? "";
  const path = safeRequestTarget(rawUrl);
  const nonce = responseNonce(request);
  try {
    const body = await readBody(request);
    context.authenticator.verify({
      method: request.method ?? "",
      path,
      headers: request.headers,
      body,
    });
    const result = await route(context, request.method ?? "", path, body);
    sendSigned(context, response, result.status, path, nonce, result.body);
  } catch (error: unknown) {
    const safe = safeHttpError(error);
    sendSigned(context, response, safe.status, path, nonce, {
      code: safe.code,
      message: safe.message,
    });
  }
}

async function route(
  context: ServerContext,
  method: string,
  path: string,
  body: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  if (method === "GET" && path === "/v1/health") {
    if (body.length !== 0) throw invalidRequest();
    return {
      status: 200,
      body: {
        ok: true,
        mode: context.mode,
        version: "0.2.0-pilot",
        principalArn: context.principalArn,
        sourceAccountId: context.sourceAccountId,
        message:
          context.mode === "fixture"
            ? "Fixture collector ready; no AWS API calls will be made."
            : "Live read-only AWS collector ready.",
      },
    };
  }

  if (method === "GET" && path === "/v1/local/fixtures") {
    requireEmptyBody(body);
    requireLocalJobs(context);
    return {
      status: 200,
      body: { fixtures: listLocalFixtureAccounts() },
    };
  }

  if (method === "GET" && requestPathname(path) === "/v1/local/jobs") {
    requireEmptyBody(body);
    const localJobs = requireLocalJobs(context);
    const query = parseLocalJobListQuery(path);
    const tenantIds = query.tenantId === undefined
      ? localJobs.tenantIds
      : localJobs.tenantIds.includes(query.tenantId)
        ? [query.tenantId]
        : [];
    const jobs = (
      await Promise.all(
        tenantIds.map((tenantId) =>
          localJobs.queue.listJobs(tenantId, {
            kind: LOCAL_FIXTURE_COLLECTION_JOB_KIND,
          }),
        ),
      )
    )
      .flat()
      .filter((job) =>
        (query.customerId === undefined || localJobScope(job).customerId === query.customerId) &&
        (query.reviewRequired !== true ||
          job.status === "pending" ||
          job.status === "leased" ||
          (job.status === "succeeded" && job.publication === undefined)))
      .sort(compareLocalJobs)
      .slice(0, query.limit)
      .map((job) => serializeLocalJob(job));
    return { status: 200, body: { jobs, count: jobs.length, limit: query.limit } };
  }

  if (method === "GET" && requestPathname(path) === "/v1/local/schedules") {
    requireEmptyBody(body);
    const localJobs = requireLocalJobs(context);
    const query = parseLocalScheduleListQuery(path);
    requireCatalogCustomer(query.tenantId, query.customerId);
    const schedules = (await localJobs.scheduler.listSchedules(query.tenantId))
      .filter((schedule) => localScheduleScope(schedule).customerId === query.customerId)
      .map((schedule) => serializeLocalSchedule(schedule));
    return { status: 200, body: { schedules, count: schedules.length } };
  }

  const localScheduleEnabledMatch = LOCAL_SCHEDULE_ENABLED_PATH.exec(path);
  if (method === "POST" && localScheduleEnabledMatch !== null) {
    const scheduleId = localScheduleEnabledMatch[1];
    if (scheduleId === undefined) throw invalidRequest();
    const localJobs = requireLocalJobs(context);
    const input = parseLocalScheduleEnabled(body);
    const current = (await localJobs.scheduler.listSchedules(input.tenantId))
      .find((candidate) => candidate.scheduleId === scheduleId);
    if (current === undefined) throw new LocalScheduleNotFoundError();
    const currentScope = localScheduleScope(current);
    if (scheduleId !== deterministicLocalFixtureScheduleId(input.tenantId, currentScope.fixtureId)) {
      throw invalidRequest();
    }
    const schedule = await localJobs.scheduler.setScheduleEnabled(
      input.tenantId,
      scheduleId,
      input.enabled,
      input.mutationId,
      input.mutationSequence,
      { resetNextRunAtWhenEnabling: context.now() },
    );
    return { status: 200, body: { schedule: serializeLocalSchedule(schedule) } };
  }

  const localScheduleMatch = LOCAL_SCHEDULE_PATH.exec(path);
  if (method === "PUT" && localScheduleMatch !== null) {
    const scheduleId = localScheduleMatch[1];
    if (scheduleId === undefined) throw invalidRequest();
    const localJobs = requireLocalJobs(context);
    const input = parseLocalScheduleUpsert(body);
    const fixture = getLocalFixtureAccount(input.fixtureId);
    if (
      fixture.tenantId !== input.tenantId ||
      scheduleId !== deterministicLocalFixtureScheduleId(input.tenantId, input.fixtureId)
    ) throw invalidRequest();
    const schedule = await localJobs.scheduler.upsertSchedule({
      tenantId: input.tenantId,
      scheduleId,
      mutationId: input.mutationId,
      mutationSequence: input.mutationSequence,
      kind: LOCAL_FIXTURE_COLLECTION_JOB_KIND,
      payload: createLocalFixtureCollectionJobPayload(input.fixtureId, input.version),
      everyMs: input.everyMs,
      firstRunAt: input.firstRunAt,
      enabled: input.enabled,
      maxAttempts: 5,
    });
    return { status: 200, body: { schedule: serializeLocalSchedule(schedule) } };
  }

  if (method === "POST" && path === "/v1/local/jobs/simulated-sync") {
    const localJobs = requireLocalJobs(context);
    const input = parseLocalFixtureJob(body);
    const fixture = getLocalFixtureAccount(input.fixtureId);
    if (fixture.tenantId !== input.tenantId) throw invalidRequest();
    const result = await localJobs.queue.enqueue({
      tenantId: input.tenantId,
      kind: LOCAL_FIXTURE_COLLECTION_JOB_KIND,
      idempotencyKey: input.idempotencyKey,
      payload: createLocalFixtureCollectionJobPayload(input.fixtureId, input.version),
      availableAt: LOCAL_JOB_AVAILABLE_AT,
      maxAttempts: 5,
    });
    return {
      status: result.created ? 202 : 200,
      body: { created: result.created, job: serializeLocalJob(result.job) },
    };
  }

  const localPublishedMatch = LOCAL_JOB_PUBLISHED_PATH.exec(path);
  if (method === "POST" && localPublishedMatch !== null) {
    const jobId = localPublishedMatch[1];
    if (jobId === undefined) throw invalidRequest();
    const input = parseLocalJobPublished(body);
    requireCatalogCustomer(input.tenantId, input.customerId);
    const localJobs = requireLocalJobs(context);
    const job = await findLocalJob(localJobs, jobId);
    if (job === null) {
      throw new LocalHttpError(404, "JOB_NOT_FOUND", "The local fixture job was not found");
    }
    const scope = localJobScope(job);
    if (job.tenantId !== input.tenantId || scope.customerId !== input.customerId) {
      throw new LocalHttpError(404, "JOB_NOT_FOUND", "The local fixture job was not found");
    }
    await localJobs.queue.acknowledgePublished({
      tenantId: input.tenantId,
      jobId,
      publicationId: input.publicationId,
      publishedAt: input.publishedAt,
    });
    return { status: 200, body: { acknowledged: true } };
  }

  const localResultMatch = LOCAL_JOB_RESULT_PATH.exec(requestPathname(path));
  if (method === "GET" && localResultMatch !== null) {
    requireEmptyBody(body);
    const query = parseLocalJobResultQuery(path);
    requireCatalogCustomer(query.tenantId, query.customerId);
    const jobId = localResultMatch[1];
    if (jobId === undefined) throw invalidRequest();
    const localJobs = requireLocalJobs(context);
    const job = await findLocalJob(localJobs, jobId);
    if (job === null) {
      throw new LocalHttpError(404, "JOB_NOT_FOUND", "The local fixture job was not found");
    }
    const jobScope = localJobScope(job);
    if (job.tenantId !== query.tenantId || jobScope.customerId !== query.customerId) {
      throw new LocalHttpError(404, "JOB_NOT_FOUND", "The local fixture job was not found");
    }
    if (job.status === "dead_letter") {
      throw new LocalHttpError(422, "JOB_FAILED", "The local fixture job exhausted its retries");
    }
    if (job.status !== "succeeded" || job.result === undefined) {
      throw new LocalHttpError(409, "JOB_NOT_READY", "The local fixture job is not complete");
    }
    return {
      status: 200,
      body: {
        job: serializeLocalJob(job),
        result: validatedLocalFixtureResult(job),
      },
    };
  }

  const connectionMatch = CONNECTION_PATH.exec(path);
  if (method === "PUT" && connectionMatch !== null) {
    const pathConnectionId = connectionMatch[1];
    if (pathConnectionId === undefined) throw invalidRequest();
    const input = parseRegistration(body, pathConnectionId);
    const operationKey = connectionOperationKey(input.tenantId, input.connectionId);
    if (
      context.activeConnectionOperations.has(operationKey) ||
      context.lifecycleMutations.has(operationKey)
    ) {
      throw new RegistryStateError();
    }
    await context.registry.upsert(input);
    return { status: 200, body: { registered: true } };
  }

  const actionMatch = CONNECTION_ACTION_PATH.exec(path);
  if (method === "POST" && actionMatch !== null) {
    const pathConnectionId = actionMatch[1];
    const action = actionMatch[2];
    if (pathConnectionId === undefined || action === undefined) throw invalidRequest();
    if (action === "disable" || action === "offboard") {
      const scope = parseConnectionLifecycleScope(body, pathConnectionId);
      await mutateConnectionLifecycle(context, scope, action);
      return {
        status: 200,
        body: action === "disable" ? { disabled: true } : { offboarded: true },
      };
    }
    if (action === "activate" || action === "discard") {
      const candidate = parseStagedRegistrationMutation(body, pathConnectionId);
      await mutateStagedRegistration(context, candidate, action);
      return {
        status: 200,
        body: action === "activate" ? { activated: true } : { discarded: true },
      };
    }
    if (action === "security-events") {
      const eventJob = parseSecurityEventJob(body, pathConnectionId, context.now());
      return { status: 200, body: await collectConnectionSecurityEvents(context, eventJob) };
    }
    const job = parseScopedJob(body, pathConnectionId);
    if (action === "verify") {
      return { status: 200, body: await verifyConnection(context, job) };
    }
    if (action === "costs") {
      return { status: 200, body: await collectConnectionCosts(context, job) };
    }
    if (action === "utilization") {
      return { status: 200, body: await collectConnectionUtilization(context, job) };
    }
    return { status: 200, body: await syncConnection(context, job) };
  }

  throw new LocalHttpError(404, "INVALID_REQUEST", "The collector endpoint does not exist");
}

async function collectConnectionCosts(context: ServerContext, job: ScopedJob): Promise<unknown> {
  const operationKey = connectionOperationKey(job.tenantId, job.connectionId);
  if (
    context.activeConnectionOperations.has(operationKey) ||
    context.lifecycleMutations.has(operationKey)
  ) {
    throw new LocalHttpError(409, "INVALID_REQUEST", "Another collection is already running for this connection");
  }
  context.activeConnectionOperations.add(operationKey);
  try {
    const connection = await requireCurrentActiveConnection(context.registry, job);
    if (context.mode !== "live") {
      const { collectAwsCosts } = await import("./cost-explorer-runner.js");
      return collectAwsCosts({
        accountId: connection.expectedAccountId,
        partition: connection.partition,
        credentials: {
          accessKeyId: "SIMULATED",
          secretAccessKey: "SIMULATED",
          sessionToken: "SIMULATED",
          expiration: new Date(0),
        },
        client: {
          getCostAndUsage: async () => {
            throw Object.assign(new Error("Live AWS is required"), { name: "AccessDeniedException" });
          },
          getCostForecast: async () => ({}),
        },
        now: context.now,
      });
    }
    const broker = createWorkloadIdentityRoleBroker({
      registry: context.registry,
      principalArn: context.principalArn,
      region: partitionControlRegion(connection.partition),
    });
    const session = await broker.assumeValidatedSession(
      { tenantId: job.tenantId },
      job.connectionId,
      job.jobId,
    );
    const { collectAwsCosts } = await import("./cost-explorer-runner.js");
    return collectAwsCosts({
      accountId: session.accountId,
      partition: session.partition,
      credentials: session.credentials,
      now: context.now,
    });
  } finally {
    context.activeConnectionOperations.delete(operationKey);
  }
}

const UTILIZATION_INSTANCE_LIMIT = 500;
const UTILIZATION_EC2_PAGES = 20;

function ec2InstancesFromResources(
  resources: readonly NormalizedAwsResource[] | readonly PilotResource[],
): { instanceId: string; region: string; instanceType: string | null; resourceKey: string }[] {
  const instances: { instanceId: string; region: string; instanceType: string | null; resourceKey: string }[] = [];
  for (const resource of resources as readonly PilotResource[]) {
    if (!/ec2.*instance/iu.test(resource.resourceType)) continue;
    const instanceType = resource.configuration?.instanceType;
    instances.push({
      instanceId: resource.nativeId,
      region: resource.region,
      instanceType: typeof instanceType === "string" && instanceType.length > 0 ? instanceType : null,
      resourceKey: resource.resourceKey,
    });
  }
  return instances;
}

/**
 * Utilization collection mirrors the cost runner: fixture mode returns
 * representative CloudWatch samples (no AWS calls); live mode assumes the
 * validated session and issues bounded read-only cloudwatch:GetMetricData /
 * cloudwatch:ListMetrics reads for the account's EC2 instances.
 */
async function collectConnectionUtilization(context: ServerContext, job: ScopedJob): Promise<unknown> {
  const operationKey = connectionOperationKey(job.tenantId, job.connectionId);
  if (
    context.activeConnectionOperations.has(operationKey) ||
    context.lifecycleMutations.has(operationKey)
  ) {
    throw new LocalHttpError(409, "INVALID_REQUEST", "Another collection is already running for this connection");
  }
  context.activeConnectionOperations.add(operationKey);
  try {
    const connection = await requireCurrentActiveConnection(context.registry, job);
    const { fixtureEc2Utilization, collectEc2Utilization } = await import("./cloudwatch-runner.js");
    if (context.mode !== "live") {
      const snapshot = buildFixtureSnapshot({ jobId: job.jobId, connection, now: context.now() });
      return fixtureEc2Utilization({
        accountId: connection.expectedAccountId,
        instances: ec2InstancesFromResources(snapshot.resources).slice(0, UTILIZATION_INSTANCE_LIMIT),
        now: context.now,
      });
    }
    const broker = createWorkloadIdentityRoleBroker({
      registry: context.registry,
      principalArn: context.principalArn,
      region: partitionControlRegion(connection.partition),
    });
    const session = await broker.assumeValidatedSession(
      { tenantId: job.tenantId },
      job.connectionId,
      job.jobId,
    );
    const { AwsEnabledRegionSelector, AwsSdkInventoryClientFactory } = await import("./inventory-runner.js");
    const regionSelector = new AwsEnabledRegionSelector({
      controlRegion: partitionControlRegion(connection.partition),
      requestedRegions: connection.enabledRegions,
    });
    const regions = await regionSelector.selectRegions({
      tenantId: job.tenantId,
      connectionId: job.connectionId,
      accountId: session.accountId,
      partition: session.partition,
      credentials: session.credentials,
    });
    const clients = new AwsSdkInventoryClientFactory();
    const instances: { instanceId: string; region: string; instanceType: string | null; resourceKey: string }[] = [];
    for (const region of regions) {
      const ec2 = clients.ec2(region, session.credentials);
      let token: string | undefined;
      for (let page = 0; page < UTILIZATION_EC2_PAGES; page += 1) {
        const output = await ec2.describeInstances(
          token === undefined ? { MaxResults: 1000 } : { MaxResults: 1000, NextToken: token },
        );
        for (const reservation of output.Reservations ?? []) {
          for (const instance of reservation.Instances ?? []) {
            if (instance.InstanceId === undefined) continue;
            instances.push({
              instanceId: instance.InstanceId,
              region,
              instanceType: instance.InstanceType ?? null,
              resourceKey: instance.InstanceId,
            });
          }
        }
        token = output.NextToken;
        if (token === undefined || token.length === 0 || instances.length >= UTILIZATION_INSTANCE_LIMIT) break;
      }
      if (instances.length >= UTILIZATION_INSTANCE_LIMIT) break;
    }
    return collectEc2Utilization({
      accountId: session.accountId,
      instances: instances.slice(0, UTILIZATION_INSTANCE_LIMIT),
      credentials: session.credentials,
      now: context.now,
    });
  } finally {
    context.activeConnectionOperations.delete(operationKey);
  }
}

interface ScopedSecurityEventJob extends ScopedJob {
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

async function collectConnectionSecurityEvents(
  context: ServerContext,
  job: ScopedSecurityEventJob,
): Promise<unknown> {
  const operationKey = connectionOperationKey(job.tenantId, job.connectionId);
  if (context.lifecycleMutations.has(operationKey)) {
    throw new LocalHttpError(409, "INVALID_REQUEST", "Another collection is already running for this connection");
  }
  return runTimedSecurityEventOperation({
    activeOperations: context.activeConnectionOperations,
    operationKey,
    deadlineMs: SECURITY_EVENT_OPERATION_DEADLINE_MS,
    operation: async (operationSignal) => {
      const connection = await requireCurrentActiveConnection(context.registry, job);
      if (context.mode !== "live") {
        throw new LocalHttpError(
          409,
          "INVALID_REQUEST",
          "Security-event collection requires explicit live AWS mode",
        );
      }
      const broker = createWorkloadIdentityRoleBroker({
        registry: context.registry,
        principalArn: context.principalArn,
        region: partitionControlRegion(connection.partition),
      });
      const session = await raceLocalAbort(
        broker.assumeValidatedSession(
          { tenantId: job.tenantId },
          job.connectionId,
          job.jobId,
        ),
        operationSignal,
      );
      const { AwsEnabledRegionSelector } = await import("./inventory-runner.js");
      const regionSelector = new AwsEnabledRegionSelector({
        controlRegion: partitionControlRegion(connection.partition),
        requestedRegions: connection.enabledRegions,
      });
      const regionSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(20_000)]);
      const regions = await raceLocalAbort(
        regionSelector.selectRegions({
          tenantId: job.tenantId,
          connectionId: job.connectionId,
          accountId: session.accountId,
          partition: session.partition,
          credentials: session.credentials,
        }, regionSignal),
        regionSignal,
      );
      const { collectCloudTrailSecurityEvents } = await import("./security-events-runner.js");
      return collectCloudTrailSecurityEvents({
        accountId: session.accountId,
        partition: session.partition,
        regions,
        credentials: session.credentials,
        windowStart: job.windowStart,
        windowEnd: job.windowEnd,
        now: context.now,
        abortSignal: operationSignal,
      });
    },
  });
}

export async function runTimedSecurityEventOperation<T>(input: {
  readonly activeOperations: Set<string>;
  readonly operationKey: string;
  readonly deadlineMs: number;
  readonly operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > SECURITY_EVENT_OPERATION_DEADLINE_MS) {
    throw new TypeError("Security-event operation deadline is invalid");
  }
  if (input.activeOperations.has(input.operationKey)) {
    throw new LocalHttpError(409, "INVALID_REQUEST", "Another collection is already running for this connection");
  }
  input.activeOperations.add(input.operationKey);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Security-event operation deadline exceeded")),
    input.deadlineMs,
  );
  timer.unref?.();
  try {
    return await raceLocalAbort(
      Promise.resolve().then(() => input.operation(controller.signal)),
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LocalHttpError(504, "COLLECTION_FAILED", "Security-event collection reached its deadline");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.activeOperations.delete(input.operationKey);
  }
}

function raceLocalAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function verifyConnection(context: ServerContext, job: ScopedJob): Promise<unknown> {
  const operationKey = connectionOperationKey(job.tenantId, job.connectionId);
  if (
    context.activeConnectionOperations.has(operationKey) ||
    context.lifecycleMutations.has(operationKey)
  ) {
    throw new RegistryStateError();
  }
  context.activeConnectionOperations.add(operationKey);
  try {
    const scope = { tenantId: job.tenantId };
    if (context.mode === "fixture") {
      const connection = await activeCandidate(context.registry, job);
      const callerIdentityArn = fixtureCallerIdentityArn(connection, job.jobId);
      const verification: OnboardingTrustVerification = {
        connectionId: connection.connectionId,
        accountId: connection.expectedAccountId,
        partition: connection.partition,
        roleArn: connection.roleArn,
        callerIdentityArn,
        roleSessionName: fixtureRoleSessionName(job.jobId),
        missingExternalIdDenied: true,
        wrongExternalIdDenied: true,
        trustPolicyAttested: true,
        permissionPolicyAttested: true,
        sessionPolicyApplied: true,
        permissionPackVersion: "standard-2026-07",
      };
      await context.registry.markOnboardingVerified(scope, job.connectionId, verification);
      return verificationResponse(verification);
    }

    const connection = await requireConnection(context.registry, job);
    const broker = createWorkloadIdentityRoleBroker({
      registry: context.registry,
      principalArn: context.principalArn,
      region: partitionControlRegion(connection.partition),
    });
    const verification = await broker.verifyOnboardingTrust(scope, job.connectionId, job.jobId);
    await context.registry.markOnboardingVerified(scope, job.connectionId, verification);
    return verificationResponse(verification);
  } finally {
    context.activeConnectionOperations.delete(operationKey);
  }
}

async function syncConnection(context: ServerContext, job: ScopedJob): Promise<PilotSnapshot> {
  const syncKey = connectionOperationKey(job.tenantId, job.connectionId);
  if (
    context.activeConnectionOperations.has(syncKey) ||
    context.lifecycleMutations.has(syncKey)
  ) {
    throw new LocalHttpError(409, "INVALID_REQUEST", "A sync is already running for this connection");
  }
  context.activeConnectionOperations.add(syncKey);
  try {
    const connection = await requireCurrentActiveConnection(context.registry, job);
    if (context.mode === "fixture") {
      return buildFixtureSnapshot({ jobId: job.jobId, connection, now: context.now() });
    }
    return await collectLiveSnapshot(context, connection, job);
  } finally {
    context.activeConnectionOperations.delete(syncKey);
  }
}

async function mutateConnectionLifecycle(
  context: ServerContext,
  scope: { readonly tenantId: string; readonly connectionId: string },
  action: "disable" | "offboard",
): Promise<void> {
  const operationKey = connectionOperationKey(scope.tenantId, scope.connectionId);
  if (
    context.activeConnectionOperations.has(operationKey) ||
    context.lifecycleMutations.has(operationKey)
  ) {
    throw new RegistryStateError();
  }
  context.lifecycleMutations.add(operationKey);
  try {
    if (action === "disable") {
      await context.registry.disable({ tenantId: scope.tenantId }, scope.connectionId);
    } else {
      await context.registry.offboard({ tenantId: scope.tenantId }, scope.connectionId);
    }
  } finally {
    context.lifecycleMutations.delete(operationKey);
  }
}

async function mutateStagedRegistration(
  context: ServerContext,
  candidate: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly roleArn: string;
  },
  action: "activate" | "discard",
): Promise<void> {
  const operationKey = connectionOperationKey(candidate.tenantId, candidate.connectionId);
  if (
    context.activeConnectionOperations.has(operationKey) ||
    context.lifecycleMutations.has(operationKey)
  ) {
    throw new RegistryStateError();
  }
  context.lifecycleMutations.add(operationKey);
  try {
    const scope = { tenantId: candidate.tenantId };
    if (action === "activate") {
      await context.registry.activateOnboarding(
        scope,
        candidate.connectionId,
        candidate.roleArn,
      );
    } else {
      await context.registry.discardStagedOnboarding(
        scope,
        candidate.connectionId,
        candidate.roleArn,
      );
    }
  } finally {
    context.lifecycleMutations.delete(operationKey);
  }
}

function connectionOperationKey(tenantId: string, connectionId: string): string {
  return `${tenantId}\u001f${connectionId}`;
}

async function collectLiveSnapshot(
  context: ServerContext,
  connection: RegisteredAwsConnection,
  job: ScopedJob,
): Promise<PilotSnapshot> {
  const {
    AwsEnabledRegionSelector,
    AwsSdkInventoryClientFactory,
    SingleAccountAwsInventoryRunner,
  } = await import("./inventory-runner.js");
  const broker = createWorkloadIdentityRoleBroker({
    registry: context.registry,
    principalArn: context.principalArn,
    region: partitionControlRegion(connection.partition),
  });
  const session = await broker.assumeValidatedSession(
    { tenantId: job.tenantId },
    job.connectionId,
    job.jobId,
  );
  const sink = new BoundedLiveInventorySink();
  const clients = new AwsSdkInventoryClientFactory();
  const runner = new SingleAccountAwsInventoryRunner({
    clients,
    sink,
    regionSelector: new AwsEnabledRegionSelector({
      controlRegion: partitionControlRegion(connection.partition),
      requestedRegions: connection.enabledRegions,
    }),
    maxConcurrency: 4,
    now: context.now,
  });
  const result = await runner.collect({
    tenantId: job.tenantId,
    connectionId: job.connectionId,
    jobId: job.jobId,
    accountId: session.accountId,
    partition: session.partition,
    roleSessionName: session.roleSessionName,
    credentials: session.credentials,
  });
  return normalizeLiveSnapshot(
    connection,
    job.jobId,
    session.roleSessionName,
    sink.resources,
    sink.evidence,
    result.coverage,
    result.collectorCoverage,
    context.now(),
    sink.evidenceTruncation,
    sink.resourceTruncation,
  );
}

export interface LiveEvidenceTruncation {
  readonly evidenceLimit: number;
  readonly retainedEvidence: number;
  readonly droppedEvidence: number;
  readonly nativeFindingsDropped: number;
  readonly otherEvidenceDropped: number;
}

export interface LiveResourceTruncation {
  readonly resourceLimit: number;
  readonly retainedResources: number;
  readonly droppedResources: number;
}

/**
 * The local live API returns an in-memory snapshot, so it must retain a hard
 * upper bound even when multiple regional native-finding adapters are busy.
 * Once the bound is crossed, one slot is reserved for explicit truncation
 * evidence in the normalized snapshot. Non-native posture evidence displaces
 * native findings first so a native-finding surge cannot hide base coverage.
 */
export class BoundedLiveInventorySink implements AwsInventorySink {
  public readonly resources: NormalizedAwsResource[] = [];
  public readonly evidence: NormalizedAwsEvidence[] = [];
  private droppedEvidence = 0;
  private nativeFindingsDropped = 0;
  private otherEvidenceDropped = 0;
  private droppedResources = 0;

  public constructor(
    private readonly evidenceLimit = LIVE_EVIDENCE_LIMIT,
    private readonly resourceLimit = LIVE_RESOURCE_LIMIT,
  ) {
    if (!Number.isSafeInteger(evidenceLimit) || evidenceLimit < 1) {
      throw new TypeError("The live evidence limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(resourceLimit) || resourceLimit < 1) {
      throw new TypeError("The live resource limit must be a positive safe integer");
    }
  }

  public get evidenceTruncation(): LiveEvidenceTruncation | null {
    if (this.droppedEvidence === 0) return null;
    return {
      evidenceLimit: this.evidenceLimit,
      retainedEvidence: this.evidence.length,
      droppedEvidence: this.droppedEvidence,
      nativeFindingsDropped: this.nativeFindingsDropped,
      otherEvidenceDropped: this.otherEvidenceDropped,
    };
  }

  public get resourceTruncation(): LiveResourceTruncation | null {
    if (this.droppedResources === 0) return null;
    return {
      resourceLimit: this.resourceLimit,
      retainedResources: this.resources.length,
      droppedResources: this.droppedResources,
    };
  }

  public async writeBatch(batch: AwsInventoryBatch): Promise<void> {
    this.resources.push(...batch.resources);
    this.resources.sort((left, right) => left.resourceKey.localeCompare(right.resourceKey));
    if (this.resources.length > this.resourceLimit) {
      this.droppedResources += this.resources.length - this.resourceLimit;
      this.resources.splice(this.resourceLimit);
    }
    for (const item of batch.evidence) {
      this.evidence.push(item);
      this.evidence.sort((left, right) => {
        const leftNative = left.evidenceType === "AWS_NATIVE_FINDING" ? 1 : 0;
        const rightNative = right.evidenceType === "AWS_NATIVE_FINDING" ? 1 : 0;
        return leftNative - rightNative || left.evidenceKey.localeCompare(right.evidenceKey);
      });
      if (
        this.droppedEvidence > 0 ||
        this.evidence.length > this.evidenceLimit
      ) {
        this.truncateEvidence();
      }
    }
  }

  private truncateEvidence(): void {
    const retainedLimit = this.evidenceLimit - 1;
    while (this.evidence.length > retainedLimit) {
      const nativeIndex = this.lastNativeFindingIndex();
      const dropped = this.evidence.splice(
        nativeIndex === -1 ? this.evidence.length - 1 : nativeIndex,
        1,
      )[0];
      if (dropped === undefined) return;
      this.droppedEvidence += 1;
      if (dropped.evidenceType === "AWS_NATIVE_FINDING") {
        this.nativeFindingsDropped += 1;
      } else {
        this.otherEvidenceDropped += 1;
      }
    }
  }

  private lastNativeFindingIndex(): number {
    for (let index = this.evidence.length - 1; index >= 0; index -= 1) {
      if (this.evidence[index]?.evidenceType === "AWS_NATIVE_FINDING") return index;
    }
    return -1;
  }
}

export function normalizeLiveSnapshot(
  connection: RegisteredAwsConnection,
  jobId: string,
  roleSessionName: string,
  normalized: readonly NormalizedAwsResource[],
  evidence: readonly NormalizedAwsEvidence[],
  coverage: "COMPLETE" | "PARTIAL",
  collectorCoverage: readonly InventoryCollectorCoverage[],
  completedAt: Date,
  evidenceTruncation: LiveEvidenceTruncation | null = null,
  resourceTruncation: LiveResourceTruncation | null = null,
): PilotSnapshot {
  const resourceCandidates = [...normalized]
    .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey))
    .map((source) => {
      const resourceKey = boundaryResourceKey(source);
      return { source, resource: liveResource(source, resourceKey) };
    });
  const resourceSelection = selectWithinJsonBudget(
    resourceCandidates,
    LIVE_SNAPSHOT_RESOURCE_BUDGET_BYTES,
    (candidate) => candidate.resource,
  );
  const selectedNormalized = resourceSelection.items.map((candidate) => candidate.source);
  const resources = resourceSelection.items.map((candidate) => candidate.resource);
  const keyMap = new Map<string, string>();
  for (const candidate of resourceSelection.items) {
    keyMap.set(candidate.source.resourceKey, candidate.resource.resourceKey);
  }
  const relationshipSelection = selectWithinJsonBudget(
    liveRelationships(selectedNormalized, keyMap),
    LIVE_SNAPSHOT_RELATIONSHIP_BUDGET_BYTES,
  );
  const baseFindings = liveFindings(
    resources,
    selectedNormalized,
    evidence,
    keyMap,
    completedAt.toISOString(),
    evidenceTruncation,
    resourceTruncation,
  );
  let findingSelection = selectWithinJsonBudget(
    [...baseFindings].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
    LIVE_SNAPSHOT_FINDING_BUDGET_BYTES,
  );
  const snapshotBudgetNeeded =
    resourceSelection.dropped > 0 ||
    relationshipSelection.dropped > 0 ||
    findingSelection.dropped > 0;
  if (snapshotBudgetNeeded) {
    let findingsDropped = findingSelection.dropped;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const budgetFinding = snapshotBudgetFinding(completedAt.toISOString(), {
        resourcesDropped: resourceSelection.dropped,
        relationshipsDropped: relationshipSelection.dropped,
        findingsDropped,
      });
      const preferred = selectWithinJsonBudget(
        [budgetFinding],
        LIVE_SNAPSHOT_FINDING_BUDGET_BYTES,
      );
      const remainingBytes = LIVE_SNAPSHOT_FINDING_BUDGET_BYTES - preferred.bytes;
      const regular = selectWithinJsonBudget(
        [...baseFindings].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
        remainingBytes,
      );
      const nextDropped = regular.dropped;
      findingSelection = {
        items: [...preferred.items, ...regular.items]
          .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
        dropped: nextDropped,
        bytes: preferred.bytes + regular.bytes,
      };
      if (nextDropped === findingsDropped) break;
      findingsDropped = nextDropped;
    }
  }

  const coverageEntries = normalizeCollectorCoverage(collectorCoverage);
  if (evidenceTruncation !== null) {
    coverageEntries.push({
      collectorKey: EVIDENCE_BUDGET_COLLECTOR_KEY,
      region: "global",
      status: "partial",
      itemsObserved: evidenceTruncation.retainedEvidence,
      pagesObserved: 0,
      errorCode: "EVIDENCE_BUDGET_EXCEEDED",
      message: "The bounded local collector omitted evidence and returned a partial snapshot.",
    });
  }
  if (resourceTruncation !== null) {
    coverageEntries.push({
      collectorKey: RESOURCE_BUDGET_COLLECTOR_KEY,
      region: "global",
      status: "partial",
      itemsObserved: resourceTruncation.retainedResources,
      pagesObserved: 0,
      errorCode: "RESOURCE_BUDGET_EXCEEDED",
      message: "The bounded local collector omitted resources and returned a partial snapshot.",
    });
  }
  if (snapshotBudgetNeeded) {
    coverageEntries.push({
      collectorKey: SNAPSHOT_BUDGET_COLLECTOR_KEY,
      region: "global",
      status: "partial",
      itemsObserved: resources.length,
      pagesObserved: 0,
      errorCode: "SNAPSHOT_BUDGET_EXCEEDED",
      message: "The signed local snapshot was reduced to its bounded byte budget.",
    });
  }
  const snapshot = finalizePilotSnapshot({
    schemaVersion: "sutra.inventory.v1",
    jobId,
    connectionId: connection.connectionId,
    accountId: connection.expectedAccountId,
    partition: connection.partition,
    roleSessionName,
    collectedAt: completedAt.toISOString(),
    coverageState:
      coverage === "COMPLETE" &&
        evidenceTruncation === null &&
        resourceTruncation === null &&
        !snapshotBudgetNeeded
        ? "complete"
        : "partial",
    coverage: coverageEntries,
    resources,
    relationships: relationshipSelection.items,
    findings: findingSelection.items,
  });
  const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (
    LIVE_SNAPSHOT_RESPONSE_BUDGET_BYTES >= RESPONSE_LIMIT ||
    serializedBytes > LIVE_SNAPSHOT_RESPONSE_BUDGET_BYTES
  ) {
    throw new Error("The live snapshot byte-budget invariant was violated");
  }
  return snapshot;
}

interface JsonBudgetSelection<T> {
  readonly items: T[];
  readonly dropped: number;
  readonly bytes: number;
}

function selectWithinJsonBudget<T>(
  values: readonly T[],
  maximumBytes: number,
  serializable: (value: T) => unknown = (value) => value,
): JsonBudgetSelection<T> {
  const items: T[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const value of values) {
    const itemBytes = Buffer.byteLength(JSON.stringify(serializable(value)), "utf8") + 1;
    if (bytes + itemBytes > maximumBytes) {
      dropped += 1;
      continue;
    }
    items.push(value);
    bytes += itemBytes;
  }
  return { items, dropped, bytes };
}

function snapshotBudgetFinding(
  evaluatedAt: string,
  details: {
    readonly resourcesDropped: number;
    readonly relationshipsDropped: number;
    readonly findingsDropped: number;
  },
): PilotFinding {
  return {
    fingerprint: sha256("SUTRA.COLLECTOR.SNAPSHOT_BUDGET:account:global").slice(0, 48),
    resourceKey: null,
    controlKey: "SUTRA.COLLECTOR.SNAPSHOT_BUDGET",
    controlVersion: "1.0.0",
    severity: "medium",
    status: "open",
    title: "AWS snapshot was reduced to the signed-response budget",
    summary: "Sutra retained a deterministic, relationship-safe subset of the collected AWS snapshot.",
    remediation: "Use the durable hosted ingestion architecture before relying on complete high-cardinality inventory coverage.",
    evidence: {
      resourceBytesBudget: LIVE_SNAPSHOT_RESOURCE_BUDGET_BYTES,
      relationshipBytesBudget: LIVE_SNAPSHOT_RELATIONSHIP_BUDGET_BYTES,
      findingBytesBudget: LIVE_SNAPSHOT_FINDING_BUDGET_BYTES,
      ...details,
    },
    evaluatedAt,
  };
}

function liveResource(resource: NormalizedAwsResource, resourceKey: string): PilotResource {
  const rawState = scalarString(resource.configuration.state) ?? scalarString(resource.configuration.status);
  const state = rawState?.toLowerCase().replace(/[^a-z0-9._:@#+=-]+/gu, "-") || "observed";
  const rawName =
    scalarString(resource.configuration.name) ??
    scalarString(resource.configuration.groupName) ??
    resource.resourceId;
  const unsigned = {
    resourceKey,
    service: resource.service,
    resourceType: resource.resourceType,
    nativeId: resource.resourceId.slice(0, 512),
    arn: resource.arn?.slice(0, 2_048) ?? null,
    name: rawName.slice(0, 512),
    region: resource.region,
    state: state.slice(0, 64),
    tags: resource.tags,
    configuration: resource.configuration,
    source: {
      api: resource.sourceApi ?? `${resource.service}:inventory`,
      accountId: resource.accountId,
      collectedAt: resource.observedAt,
    },
  };
  return { ...unsigned, contentSha256: sha256(JSON.stringify(unsigned)) };
}

function liveRelationships(
  normalized: readonly NormalizedAwsResource[],
  keyMap: ReadonlyMap<string, string>,
): PilotRelationship[] {
  const byNativeId = new Map<string, NormalizedAwsResource[]>();
  const index = (identifier: string, resource: NormalizedAwsResource) => {
    const list = byNativeId.get(identifier) ?? [];
    if (!list.includes(resource)) list.push(resource);
    byNativeId.set(identifier, list);
  };
  for (const resource of normalized) {
    index(resource.resourceId, resource);
    if (resource.arn !== undefined) index(resource.arn, resource);
    for (const alias of stringArray(resource.configuration.aliases)) index(alias, resource);
  }
  const result: PilotRelationship[] = [];
  const dedupe = new Set<string>();
  const link = (from: NormalizedAwsResource, nativeId: string, relationType: string, property: string) => {
    const candidate = (byNativeId.get(nativeId) ?? []).find(
      (item) => item.region === from.region || item.region === "global",
    );
    const fromKey = keyMap.get(from.resourceKey);
    const toKey = candidate === undefined ? undefined : keyMap.get(candidate.resourceKey);
    if (fromKey === undefined || toKey === undefined) return;
    const edgeKey = `${fromKey}\n${toKey}\n${relationType}`;
    if (dedupe.has(edgeKey)) return;
    dedupe.add(edgeKey);
    result.push({
      fromResourceKey: fromKey,
      toResourceKey: toKey,
      relationType,
      evidence: { property },
    });
  };
  for (const resource of normalized) {
    const config = resource.configuration;
    const vpcId = scalarString(config.vpcId);
    const subnetId = scalarString(config.subnetId);
    const instanceId = scalarString(config.instanceId);
    const kmsKeyId = scalarString(config.kmsKeyId);
    if (vpcId !== null) link(resource, vpcId, "contained_by", "vpcId");
    if (subnetId !== null) link(resource, subnetId, "runs_in", "subnetId");
    if (instanceId !== null) link(resource, instanceId, "attached_to", "instanceId");
    if (kmsKeyId !== null) link(resource, kmsKeyId, "encrypted_by", "kmsKeyId");
    for (const relatedSubnetId of stringArray(config.subnetIds)) {
      link(resource, relatedSubnetId, "runs_in", "subnetIds");
    }
    for (const relatedInstanceId of stringArray(config.instanceIds)) {
      link(resource, relatedInstanceId, "attached_to", "instanceIds");
    }
    for (const securityGroupId of stringArray(config.securityGroupIds)) {
      link(resource, securityGroupId, "protected_by", "securityGroupIds");
    }
  }
  return result.sort((left, right) =>
    `${left.fromResourceKey}\n${left.toResourceKey}\n${left.relationType}`.localeCompare(
      `${right.fromResourceKey}\n${right.toResourceKey}\n${right.relationType}`,
    ));
}

function liveFindings(
  resources: readonly PilotResource[],
  normalized: readonly NormalizedAwsResource[],
  evidence: readonly NormalizedAwsEvidence[],
  keyMap: ReadonlyMap<string, string>,
  evaluatedAt: string,
  evidenceTruncation: LiveEvidenceTruncation | null,
  resourceTruncation: LiveResourceTruncation | null,
): PilotFinding[] {
  const result: PilotFinding[] = [];
  const fingerprints = new Set<string>();
  const byKey = new Map(resources.map((resource) => [resource.resourceKey, resource]));
  const add = (
    resourceKey: string | null,
    controlKey: string,
    severity: PilotFinding["severity"],
    title: string,
    summary: string,
    remediation: string,
    details: SafeJsonObject,
    accountSignalScope?: string,
  ) => {
    if (result.length >= 5_000) return;
    const fingerprint = sha256(
      `${controlKey}:${resourceKey ?? `account:${accountSignalScope ?? "global"}`}`,
    ).slice(0, 48);
    if (fingerprints.has(fingerprint)) return;
    fingerprints.add(fingerprint);
    result.push({
      fingerprint,
      resourceKey,
      controlKey,
      controlVersion: "1.0.0",
      severity,
      status: "open",
      title,
      summary,
      remediation,
      evidence: details,
      evaluatedAt,
    });
  };

  if (evidenceTruncation !== null) {
    add(
      null,
      "SUTRA.COLLECTOR.EVIDENCE_BUDGET",
      "medium",
      "AWS evidence collection was truncated",
      "The local collector reached its bounded evidence budget. This snapshot remains usable, but its AWS evidence coverage is incomplete.",
      "Treat this snapshot as partial and use a durable production sink before relying on it for complete AWS-native finding coverage.",
      {
        evidenceLimit: evidenceTruncation.evidenceLimit,
        retainedEvidence: evidenceTruncation.retainedEvidence,
        droppedEvidence: evidenceTruncation.droppedEvidence,
        nativeFindingsDropped: evidenceTruncation.nativeFindingsDropped,
        otherEvidenceDropped: evidenceTruncation.otherEvidenceDropped,
      },
      EVIDENCE_BUDGET_COLLECTOR_KEY,
    );
  }

  if (resourceTruncation !== null) {
    add(
      null,
      "SUTRA.COLLECTOR.RESOURCE_BUDGET",
      "medium",
      "AWS resource collection was truncated",
      "The local collector reached its bounded resource budget. This snapshot remains usable, but its AWS inventory coverage is incomplete.",
      "Use the durable hosted ingestion architecture before relying on complete high-cardinality resource coverage.",
      {
        resourceLimit: resourceTruncation.resourceLimit,
        retainedResources: resourceTruncation.retainedResources,
        droppedResources: resourceTruncation.droppedResources,
      },
      RESOURCE_BUDGET_COLLECTOR_KEY,
    );
  }

  for (const source of normalized) {
    const resourceKey = keyMap.get(source.resourceKey);
    if (resourceKey === undefined || !byKey.has(resourceKey)) continue;
    const config = source.configuration;
    if (source.resourceType === "aws.ec2.instance") {
      if (typeof config.publicIpAddress === "string") {
        add(resourceKey, "SUTRA.AWS.EC2.PUBLIC_IP", "medium", "EC2 instance has a public IP",
          "A public IP is assigned. Route, NACL, security-group, service-listener, and attachment evidence is still required to prove internet reachability.",
          "Confirm the full network path, then place the workload behind an approved entry point and remove the public IP where possible.",
          { publicIpPresent: true, internetReachabilityProven: false });
      }
      if (config.metadataHttpTokens !== "required") {
        add(resourceKey, "SUTRA.AWS.EC2.IMDSV2_REQUIRED", "high", "EC2 metadata does not require IMDSv2",
          "The instance metadata configuration permits the legacy tokenless protocol.",
          "Set HttpTokens to required after validating workload compatibility.",
          { metadataHttpTokens: scalarString(config.metadataHttpTokens) ?? "unknown" });
      }
    }
    if (
      source.resourceType === "aws.ec2.subnet" &&
      config.mapPublicIpOnLaunch === true
    ) {
      add(
        resourceKey,
        "SUTRA.AWS.EC2.SUBNET_AUTO_PUBLIC_IP",
        "medium",
        "Subnet auto-assigns public IPv4 addresses",
        "MapPublicIpOnLaunch is enabled, so newly launched instances can receive public IPv4 addresses unless the launch request overrides the subnet default.",
        "Disable MapPublicIpOnLaunch and explicitly expose only approved entry points.",
        { mapPublicIpOnLaunch: true },
      );
    }
    if (source.resourceType === "aws.rds.db-instance") {
      if (config.storageEncrypted === false) {
        add(resourceKey, "SUTRA.AWS.RDS.STORAGE_ENCRYPTED", "high", "RDS storage is not encrypted",
          "StorageEncrypted is false for this database instance.",
          "Restore the database from an encrypted snapshot using an approved KMS key.",
          { storageEncrypted: false });
      }
      if (config.publiclyAccessible === true) {
        add(resourceKey, "SUTRA.AWS.RDS.PUBLIC_ACCESS", "high", "RDS public-access mode is enabled",
          "PubliclyAccessible is true. Subnet routing, NACL, and security-group evidence is still required to prove an external connection path.",
          "Confirm the full network path, move the database to private subnets, and restrict access to application security groups.",
          { publiclyAccessible: true, internetReachabilityProven: false });
      }
    }
    if (source.resourceType === "aws.ec2.security-group" && isPublicSshIngressCandidate(config.ingress)) {
      add(resourceKey, "SUTRA.AWS.EC2.SSH_PUBLIC", "high", "Security group allows public SSH ingress",
        "The security-group rule permits SSH from a public IPv4 or IPv6 CIDR. Route, NACL, attachment, and public-address evidence is still required to prove internet reachability.",
        "Restrict SSH to managed administration paths or use Systems Manager Session Manager, then verify the attached network path.",
        { port: 22, publicCidr: true, internetReachabilityProven: false });
    }
  }

  for (const item of evidence) {
    const resourceKey = evidenceResourceKey(item, normalized, keyMap);
    const accountSignalScope =
      resourceKey === null
        ? `${item.region}:${item.service}:${item.evidenceType}:${item.subjectId}`
        : undefined;
    const findingEvidence =
      accountSignalScope === undefined ? item.data : { ...item.data, region: item.region };
    if (item.evidenceType === "AWS_NATIVE_FINDING") {
      if (result.length >= 5_000) continue;
      const fingerprint = sha256(`aws-native:${item.evidenceKey}`).slice(0, 48);
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      const nativeService = scalarString(item.data.nativeService) ?? "AWS security service";
      result.push({
        fingerprint,
        resourceKey,
        controlKey: nativeFindingControlKey(item.service),
        controlVersion: "aws-native-v1",
        severity: nativeFindingSeverity(item.data.normalizedSeverity),
        status: nativeFindingStatus(item.data.normalizedStatus),
        title: (scalarString(item.data.title) ?? `${nativeService} finding`).slice(0, 180),
        summary: (scalarString(item.data.summary) ??
          `${nativeService} reported an AWS-native security finding.`).slice(0, 1_200),
        remediation: (scalarString(item.data.remediation) ??
          `Review the finding in ${nativeService} and follow the customer-approved response runbook.`).slice(0, 2_000),
        evidence: findingEvidence,
        evaluatedAt,
      });
      continue;
    }
    if (item.evidenceType === "S3_PUBLIC_ACCESS_BLOCK" && item.status === "NOT_CONFIGURED") {
      add(resourceKey, "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK", "high", "S3 Public Access Block is not fully configured",
        "The bucket is missing one or more public-access guardrails.",
        "Enable all four S3 Public Access Block settings and review bucket policies and ACLs.", findingEvidence,
        accountSignalScope);
    }
    if (item.evidenceType === "CLOUDTRAIL_LOGGING_STATUS" && item.status === "DISABLED") {
      add(resourceKey, "SUTRA.AWS.CLOUDTRAIL.LOGGING", "critical", "CloudTrail regional logging coverage is absent",
        `No applicable logging trail was observed for ${item.region}. Event-selector coverage was not evaluated.`,
        "Create or start an applicable regional or multi-Region trail, then separately verify its event selectors and delivery health.", findingEvidence,
        accountSignalScope);
    }
    if (item.evidenceType === "GUARDDUTY_ENABLEMENT" && item.status === "DISABLED") {
      add(resourceKey, "SUTRA.AWS.GUARDDUTY.ENABLED", "high", "GuardDuty is not enabled",
        "No enabled detector was observed in this Region.",
        "Enable GuardDuty through AWS Organizations for governed Regions.", findingEvidence,
        accountSignalScope);
    }
    if (item.evidenceType === "SECURITY_HUB_ENABLEMENT" && item.status === "DISABLED") {
      add(resourceKey, "SUTRA.AWS.SECURITYHUB.ENABLED", "medium", "Security Hub is not enabled",
        "AWS-native findings are not being aggregated in this Region.",
        "Enable Security Hub and the standards required by the customer baseline.", findingEvidence,
        accountSignalScope);
    }
    if (item.evidenceType === "IAM_ACCOUNT_PASSWORD_POLICY" && item.status === "NOT_CONFIGURED") {
      add(resourceKey, "SUTRA.AWS.IAM.PASSWORD_POLICY", "medium", "IAM password policy is not configured",
        "No account password policy was returned.",
        "Prefer federation and configure a strong policy for any remaining IAM users.", findingEvidence,
        accountSignalScope);
    }
  }
  return result;
}

export function normalizeCollectorCoverage(
  coverage: readonly InventoryCollectorCoverage[],
): PilotCoverageEntry[] {
  return coverage.map((entry) => ({
    collectorKey: entry.collectorKey,
    region: entry.region,
    status:
      entry.status === "SUCCEEDED"
        ? "succeeded"
        : entry.status === "FAILED"
          ? "failed"
          : "partial",
    itemsObserved: entry.itemsObserved,
    pagesObserved: entry.pagesObserved,
    ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
    ...(entry.message === undefined ? {} : { message: entry.message }),
  }));
}

function parseRegistration(body: string, pathConnectionId: string) {
  const record = exactJson(body, [
    "tenantId", "connectionId", "accountId", "partition", "roleArn", "externalId", "enabledRegions",
  ]);
  if (
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || record.connectionId !== pathConnectionId ||
    !IDENTIFIER.test(record.connectionId) ||
    typeof record.accountId !== "string" || !ACCOUNT_ID.test(record.accountId) ||
    (record.partition !== "aws" && record.partition !== "aws-us-gov" && record.partition !== "aws-cn") ||
    typeof record.roleArn !== "string" ||
    typeof record.externalId !== "string" || !EXTERNAL_ID.test(record.externalId) ||
    !isValidAwsRegionSelection(record.enabledRegions, record.partition)
  ) {
    throw invalidRequest();
  }
  let role;
  try {
    role = parseIamRoleArn(record.roleArn);
  } catch {
    throw invalidRequest();
  }
  if (role.accountId !== record.accountId || role.partition !== record.partition) throw invalidRequest();
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    expectedAccountId: record.accountId,
    partition: record.partition as LocalAwsPartition,
    roleArn: record.roleArn,
    externalId: record.externalId,
    enabledRegions: record.enabledRegions as string[],
    sessionNamePrefix: "sutra-",
  };
}

function parseScopedJob(body: string, pathConnectionId: string): ScopedJob {
  const record = exactJson(body, ["tenantId", "connectionId", "jobId"]);
  if (
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || record.connectionId !== pathConnectionId || !IDENTIFIER.test(record.connectionId) ||
    typeof record.jobId !== "string" || !IDENTIFIER.test(record.jobId)
  ) {
    throw invalidRequest();
  }
  return { tenantId: record.tenantId, connectionId: record.connectionId, jobId: record.jobId };
}

function parseSecurityEventJob(
  body: string,
  pathConnectionId: string,
  now: Date,
): ScopedSecurityEventJob {
  const record = exactJson(body, [
    "tenantId", "connectionId", "jobId", "windowStart", "windowEnd",
  ]);
  if (
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || record.connectionId !== pathConnectionId ||
    !IDENTIFIER.test(record.connectionId) ||
    typeof record.jobId !== "string" || !IDENTIFIER.test(record.jobId) ||
    typeof record.windowStart !== "string" || typeof record.windowEnd !== "string"
  ) throw invalidRequest();
  const windowStart = canonicalIsoDate(record.windowStart);
  const windowEnd = canonicalIsoDate(record.windowEnd);
  if (
    windowStart === null || windowEnd === null ||
    windowStart.getTime() >= windowEnd.getTime() ||
    windowEnd.getTime() - windowStart.getTime() > 24 * 60 * 60 * 1_000 ||
    windowEnd.getTime() > now.getTime() + 60_000
  ) throw invalidRequest();
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    jobId: record.jobId,
    windowStart,
    windowEnd,
  };
}

function parseConnectionLifecycleScope(
  body: string,
  pathConnectionId: string,
): { readonly tenantId: string; readonly connectionId: string } {
  const record = exactJson(body, ["tenantId", "connectionId"]);
  if (
    typeof record.tenantId !== "string" ||
    !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" ||
    record.connectionId !== pathConnectionId ||
    !IDENTIFIER.test(record.connectionId)
  ) {
    throw invalidRequest();
  }
  return { tenantId: record.tenantId, connectionId: record.connectionId };
}

function parseStagedRegistrationMutation(
  body: string,
  pathConnectionId: string,
): {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly roleArn: string;
} {
  const record = exactJson(body, ["tenantId", "connectionId", "roleArn"]);
  if (
    typeof record.tenantId !== "string" ||
    !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" ||
    record.connectionId !== pathConnectionId ||
    !IDENTIFIER.test(record.connectionId) ||
    typeof record.roleArn !== "string"
  ) {
    throw invalidRequest();
  }
  try {
    parseIamRoleArn(record.roleArn);
  } catch {
    throw invalidRequest();
  }
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    roleArn: record.roleArn,
  };
}

async function activeCandidate(
  registry: EncryptedFileConnectionRegistry,
  job: ScopedJob,
): Promise<RegisteredAwsConnection> {
  const connection = await requireConnection(registry, job);
  if (
    connection.status !== "PENDING" &&
    connection.status !== "VERIFIED" &&
    connection.status !== "DEGRADED" &&
    connection.status !== "ACTIVE"
  ) {
    throw new RegistryStateError();
  }
  return connection;
}

async function requireConnection(
  registry: EncryptedFileConnectionRegistry,
  job: ScopedJob,
): Promise<RegisteredAwsConnection> {
  const connection = await registry.getRegistered({ tenantId: job.tenantId }, job.connectionId);
  if (connection === null) throw new RegistryConnectionNotFoundError();
  return connection;
}

async function requireCurrentActiveConnection(
  registry: EncryptedFileConnectionRegistry,
  job: ScopedJob,
): Promise<RegisteredAwsConnection> {
  const connection = await requireConnection(registry, job);
  if (
    connection.status !== "ACTIVE" ||
    connection.permissionPackVersion !== CURRENT_PERMISSION_PACK_VERSION
  ) {
    throw new RegistryStateError();
  }
  return connection;
}

function verificationResponse(verification: OnboardingTrustVerification): unknown {
  return {
    verified: true,
    accountId: verification.accountId,
    callerIdentityArn: verification.callerIdentityArn,
    missingExternalIdDenied: true,
    wrongExternalIdDenied: true,
    trustPolicyAttested: true,
    permissionPolicyAttested: true,
    sessionPolicyApplied: true,
    permissionPackVersion: verification.permissionPackVersion,
  };
}

function requireLocalJobs(context: ServerContext): LocalJobsContext {
  if (context.localJobs === null) {
    throw new LocalHttpError(
      404,
      "INVALID_REQUEST",
      "The collector endpoint does not exist",
    );
  }
  return context.localJobs;
}

function requireEmptyBody(body: string): void {
  if (body.length !== 0) throw invalidRequest();
}

function requestPathname(target: string): string {
  try {
    return new URL(target, "http://127.0.0.1").pathname;
  } catch {
    return "/invalid";
  }
}

function parseLocalJobListQuery(target: string): LocalJobListQuery {
  let parsed: URL;
  try {
    parsed = new URL(target, "http://127.0.0.1");
  } catch {
    throw invalidRequest();
  }
  if (parsed.pathname !== "/v1/local/jobs") throw invalidRequest();
  if (parsed.search.length === 0) return { limit: DEFAULT_LOCAL_JOB_LIMIT };
  const allowedKeys = new Set(["limit", "tenantId", "customerId", "reviewRequired"]);
  const keys = [...parsed.searchParams.keys()];
  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    [...allowedKeys].some((key) => parsed.searchParams.getAll(key).length > 1)
  ) {
    throw invalidRequest();
  }
  const rawLimit = parsed.searchParams.get("limit") ?? String(DEFAULT_LOCAL_JOB_LIMIT);
  const tenantId = parsed.searchParams.get("tenantId");
  const customerId = parsed.searchParams.get("customerId");
  const rawReviewRequired = parsed.searchParams.get("reviewRequired");
  if (
    !/^[1-9]\d{0,2}$/u.test(rawLimit) ||
    ((tenantId === null) !== (customerId === null)) ||
    (tenantId !== null && !IDENTIFIER.test(tenantId)) ||
    (customerId !== null && !IDENTIFIER.test(customerId)) ||
    (rawReviewRequired !== null && rawReviewRequired !== "true")
  ) throw invalidRequest();
  const limit = Number(rawLimit);
  if (limit > MAX_LOCAL_JOB_LIMIT) throw invalidRequest();
  return {
    limit,
    ...(tenantId === null || customerId === null ? {} : { tenantId, customerId }),
    ...(rawReviewRequired === "true" ? { reviewRequired: true } : {}),
  };
}

function parseLocalScheduleListQuery(target: string): LocalScheduleListQuery {
  let parsed: URL;
  try {
    parsed = new URL(target, "http://127.0.0.1");
  } catch {
    throw invalidRequest();
  }
  if (parsed.pathname !== "/v1/local/schedules") throw invalidRequest();
  const allowedKeys = new Set(["tenantId", "customerId"]);
  const keys = [...parsed.searchParams.keys()];
  if (
    keys.length !== allowedKeys.size ||
    keys.some((key) => !allowedKeys.has(key)) ||
    [...allowedKeys].some((key) => parsed.searchParams.getAll(key).length !== 1)
  ) {
    throw invalidRequest();
  }
  const tenantId = parsed.searchParams.get("tenantId");
  const customerId = parsed.searchParams.get("customerId");
  if (
    tenantId === null ||
    customerId === null ||
    !IDENTIFIER.test(tenantId) ||
    !IDENTIFIER.test(customerId)
  ) {
    throw invalidRequest();
  }
  return { tenantId, customerId };
}

function parseLocalJobResultQuery(target: string): LocalJobResultQuery {
  let parsed: URL;
  try {
    parsed = new URL(target, "http://127.0.0.1");
  } catch {
    throw invalidRequest();
  }
  const keys = [...parsed.searchParams.keys()];
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "tenantId" && key !== "customerId") ||
    parsed.searchParams.getAll("tenantId").length !== 1 ||
    parsed.searchParams.getAll("customerId").length !== 1
  ) throw invalidRequest();
  const tenantId = parsed.searchParams.get("tenantId");
  const customerId = parsed.searchParams.get("customerId");
  if (
    tenantId === null || customerId === null ||
    !IDENTIFIER.test(tenantId) || !IDENTIFIER.test(customerId)
  ) throw invalidRequest();
  return { tenantId, customerId };
}

function parseLocalScheduleUpsert(body: string): LocalScheduleUpsertInput {
  const record = exactJson(body, [
    "tenantId",
    "mutationId",
    "mutationSequence",
    "fixtureId",
    "version",
    "everyMs",
    "enabled",
    "firstRunAt",
  ]);
  if (
    typeof record.tenantId !== "string" ||
    !IDENTIFIER.test(record.tenantId) ||
    typeof record.mutationId !== "string" ||
    !LOCAL_SCHEDULE_MUTATION_ID.test(record.mutationId) ||
    !Number.isSafeInteger(record.mutationSequence) ||
    (record.mutationSequence as number) < 1 ||
    typeof record.fixtureId !== "string" ||
    !IDENTIFIER.test(record.fixtureId) ||
    (record.version !== "2026.07.0" && record.version !== "2026.07.1") ||
    typeof record.everyMs !== "number" ||
    !Number.isInteger(record.everyMs) ||
    record.everyMs < MIN_LOCAL_SCHEDULE_INTERVAL_MS ||
    record.everyMs > MAX_LOCAL_SCHEDULE_INTERVAL_MS ||
    typeof record.enabled !== "boolean" ||
    typeof record.firstRunAt !== "string"
  ) {
    throw invalidRequest();
  }
  const firstRunAt = canonicalIsoDate(record.firstRunAt);
  if (firstRunAt === null) throw invalidRequest();
  return {
    tenantId: record.tenantId,
    mutationId: record.mutationId,
    mutationSequence: record.mutationSequence as number,
    fixtureId: record.fixtureId,
    version: record.version,
    everyMs: record.everyMs,
    enabled: record.enabled,
    firstRunAt,
  };
}

function parseLocalScheduleEnabled(body: string): {
  readonly tenantId: string;
  readonly enabled: boolean;
  readonly mutationId: string;
  readonly mutationSequence: number;
} {
  const record = exactJson(body, [
    "tenantId",
    "enabled",
    "mutationId",
    "mutationSequence",
  ]);
  if (
    typeof record.tenantId !== "string" ||
    !IDENTIFIER.test(record.tenantId) ||
    typeof record.enabled !== "boolean" ||
    typeof record.mutationId !== "string" ||
    !LOCAL_SCHEDULE_MUTATION_ID.test(record.mutationId) ||
    !Number.isSafeInteger(record.mutationSequence) ||
    (record.mutationSequence as number) < 1
  ) {
    throw invalidRequest();
  }
  return {
    tenantId: record.tenantId,
    enabled: record.enabled,
    mutationId: record.mutationId,
    mutationSequence: record.mutationSequence as number,
  };
}

function parseLocalJobPublished(body: string): {
  readonly tenantId: string;
  readonly customerId: string;
  readonly publicationId: string;
  readonly publishedAt: Date;
} {
  const record = exactJson(body, [
    "tenantId",
    "customerId",
    "publicationId",
    "publishedAt",
  ]);
  if (
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.customerId !== "string" || !IDENTIFIER.test(record.customerId) ||
    typeof record.publicationId !== "string" || !IDENTIFIER.test(record.publicationId) ||
    typeof record.publishedAt !== "string"
  ) throw invalidRequest();
  const publishedAt = canonicalIsoDate(record.publishedAt);
  if (publishedAt === null) throw invalidRequest();
  return {
    tenantId: record.tenantId,
    customerId: record.customerId,
    publicationId: record.publicationId,
    publishedAt,
  };
}

function parseLocalFixtureJob(body: string): LocalFixtureJobInput {
  const record = exactJson(body, [
    "tenantId",
    "fixtureId",
    "version",
    "idempotencyKey",
  ]);
  if (
    typeof record.tenantId !== "string" ||
    !IDENTIFIER.test(record.tenantId) ||
    typeof record.fixtureId !== "string" ||
    !IDENTIFIER.test(record.fixtureId) ||
    typeof record.version !== "string" ||
    typeof record.idempotencyKey !== "string" ||
    !IDENTIFIER.test(record.idempotencyKey) ||
    record.idempotencyKey.startsWith("schedule:")
  ) {
    throw invalidRequest();
  }
  if (record.version !== "2026.07.0" && record.version !== "2026.07.1") {
    throw invalidRequest();
  }
  return {
    tenantId: record.tenantId,
    fixtureId: record.fixtureId,
    version: record.version,
    idempotencyKey: record.idempotencyKey,
  };
}

async function findLocalJob(
  localJobs: LocalJobsContext,
  jobId: string,
): Promise<LocalJobRecord | null> {
  for (const tenantId of localJobs.tenantIds) {
    const job = await localJobs.queue.getJob(tenantId, jobId);
    if (job !== null && job.kind === LOCAL_FIXTURE_COLLECTION_JOB_KIND) return job;
  }
  return null;
}

function compareLocalJobs(left: LocalJobRecord, right: LocalJobRecord): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.jobId.localeCompare(right.jobId)
  );
}

function requireCatalogCustomer(tenantId: string, customerId: string): void {
  if (
    !listLocalFixtureAccounts().some(
      (fixture) => fixture.tenantId === tenantId && fixture.customerId === customerId,
    )
  ) {
    throw invalidRequest();
  }
}

function localJobScope(job: LocalJobRecord): {
  readonly fixtureId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly version: LocalFixtureVersion;
} {
  const payload = job.payload;
  const keys = Object.keys(payload).sort().join(",");
  if (
    job.kind !== LOCAL_FIXTURE_COLLECTION_JOB_KIND ||
    keys !== "connectionId,customerId,fixtureId,version" ||
    typeof payload.fixtureId !== "string" ||
    typeof payload.customerId !== "string" ||
    typeof payload.connectionId !== "string" ||
    (payload.version !== "2026.07.0" && payload.version !== "2026.07.1")
  ) {
    throw new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture job failed validation",
    );
  }
  const fixture = getLocalFixtureAccount(payload.fixtureId);
  if (
    fixture.tenantId !== job.tenantId ||
    fixture.customerId !== payload.customerId ||
    fixture.connectionId !== payload.connectionId
  ) {
    throw new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture job failed validation",
    );
  }
  return {
    fixtureId: payload.fixtureId,
    customerId: payload.customerId,
    connectionId: payload.connectionId,
    version: payload.version,
  };
}

function serializeLocalJob(job: LocalJobRecord): SafeJsonObject {
  const scope = localJobScope(job);
  const provenance = localJobProvenance(job);
  return {
    jobId: job.jobId,
    tenantId: job.tenantId,
    kind: job.kind,
    fixtureId: scope.fixtureId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    version: scope.version,
    triggerKind: provenance.triggerKind,
    scheduleId: provenance.scheduleId,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null,
    lastFailure:
      job.lastFailure === undefined
        ? null
        : {
            code: job.lastFailure.code,
            message: job.lastFailure.message,
            failedAt: job.lastFailure.failedAt,
            retryAt: job.lastFailure.retryAt ?? null,
          },
  };
}

function localJobProvenance(job: LocalJobRecord): {
  readonly triggerKind: "manual" | "scheduled";
  readonly scheduleId: string | null;
} {
  if (!job.idempotencyKey.startsWith("schedule:")) {
    return { triggerKind: "manual", scheduleId: null };
  }
  const match = /^schedule:(sched_[a-f0-9]{48}):(.+)$/u.exec(job.idempotencyKey);
  const scheduleId = match?.[1];
  const occurrence = match?.[2];
  if (
    scheduleId === undefined ||
    occurrence === undefined ||
    canonicalIsoDate(occurrence) === null
  ) {
    throw new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture job failed validation",
    );
  }
  return { triggerKind: "scheduled", scheduleId };
}

function localScheduleScope(schedule: LocalScheduleRecord): {
  readonly fixtureId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly version: LocalFixtureVersion;
} {
  const payload = schedule.payload;
  const keys = Object.keys(payload).sort().join(",");
  if (
    !LOCAL_SCHEDULE_ID.test(schedule.scheduleId) ||
    schedule.kind !== LOCAL_FIXTURE_COLLECTION_JOB_KIND ||
    keys !== "connectionId,customerId,fixtureId,version" ||
    typeof payload.fixtureId !== "string" ||
    typeof payload.customerId !== "string" ||
    typeof payload.connectionId !== "string" ||
    (payload.version !== "2026.07.0" && payload.version !== "2026.07.1")
  ) {
    throw new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture schedule failed validation",
    );
  }
  const fixture = getLocalFixtureAccount(payload.fixtureId);
  if (
    fixture.tenantId !== schedule.tenantId ||
    fixture.customerId !== payload.customerId ||
    fixture.connectionId !== payload.connectionId
  ) {
    throw new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture schedule failed validation",
    );
  }
  return {
    fixtureId: payload.fixtureId,
    customerId: payload.customerId,
    connectionId: payload.connectionId,
    version: payload.version,
  };
}

function serializeLocalSchedule(schedule: LocalScheduleRecord): SafeJsonObject {
  const scope = localScheduleScope(schedule);
  return {
    scheduleId: schedule.scheduleId,
    tenantId: schedule.tenantId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    fixtureId: scope.fixtureId,
    version: scope.version,
    everyMs: schedule.everyMs,
    nextRunAt: schedule.nextRunAt,
    enabled: schedule.enabled,
    maxAttempts: schedule.maxAttempts,
    capacityState: schedule.capacityBlockedAt === undefined ? "healthy" : "degraded",
    capacitySkippedOccurrences: schedule.capacitySkippedOccurrences ?? 0,
    capacityBlockedAt: schedule.capacityBlockedAt ?? null,
    missedOccurrences: schedule.missedOccurrences ?? 0,
    lastMissedAt: schedule.lastMissedAt ?? null,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function validatedLocalFixtureResult(job: LocalJobRecord): SafeJsonObject {
  const scope = localJobScope(job);
  const result = job.result;
  if (
    result === undefined ||
    Object.keys(result).sort().join(",") !==
      "connectionId,customerId,fixtureId,jobId,snapshot,tenantId,version" ||
    result.jobId !== job.jobId ||
    result.tenantId !== job.tenantId ||
    result.customerId !== scope.customerId ||
    result.connectionId !== scope.connectionId ||
    result.fixtureId !== scope.fixtureId ||
    result.version !== scope.version ||
    !isPlainRecord(result.snapshot)
  ) {
    throw new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture result failed validation",
    );
  }
  const snapshot = result.snapshot;
  const fixture = getLocalFixtureAccount(scope.fixtureId);
  if (
    snapshot.schemaVersion !== "sutra.inventory.v1" ||
    snapshot.jobId !== job.jobId ||
    snapshot.connectionId !== scope.connectionId ||
    snapshot.accountId !== fixture.accountId ||
    typeof snapshot.snapshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(snapshot.snapshotSha256) ||
    !Array.isArray(snapshot.resources) ||
    !Array.isArray(snapshot.relationships) ||
    !Array.isArray(snapshot.findings) ||
    containsSensitiveCredentialKey(result)
  ) {
    throw new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture result failed validation",
    );
  }
  return structuredClone(result);
}

function containsSensitiveCredentialKey(value: SafeJsonValue): boolean {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveCredentialKey(item));
  if (!isPlainRecord(value)) return false;
  const forbidden = new Set([
    "accesskeyid",
    "credentials",
    "externalid",
    "rolearn",
    "secretaccesskey",
    "sessiontoken",
  ]);
  return Object.entries(value).some(
    ([key, item]) => forbidden.has(key.toLowerCase()) || containsSensitiveCredentialKey(item),
  );
}

function isPlainRecord(value: unknown): value is SafeJsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactJson(body: string, keys: readonly string[]): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw invalidRequest();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalidRequest();
  return record;
}

function canonicalIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : date;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > BODY_LIMIT) {
      throw new LocalHttpError(413, "INVALID_REQUEST", "The collector request body is too large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > BODY_LIMIT) {
      throw new LocalHttpError(413, "INVALID_REQUEST", "The collector request body is too large");
    }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.length > 0 && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) {
    throw invalidRequest();
  }
  return body;
}

function sendSigned(
  context: ServerContext,
  response: ServerResponse,
  status: number,
  path: string,
  nonce: string,
  payload: unknown,
): void {
  let body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > RESPONSE_LIMIT) {
    status = 502;
    body = JSON.stringify({ code: "COLLECTION_FAILED", message: "The normalized inventory exceeded the pilot response limit" });
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-length", Buffer.byteLength(body, "utf8"));
  response.setHeader(
    "x-sutra-response-signature",
    context.authenticator.responseSignature(status, path, nonce, body),
  );
  response.end(body);
}

class LocalHttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LocalHttpError";
    this.status = status;
    this.code = code;
  }
}

function safeHttpError(error: unknown): LocalHttpError {
  if (error instanceof LocalHttpError) return error;
  if (error instanceof RequestAuthenticationError) {
    return new LocalHttpError(401, "INVALID_REQUEST", "Collector request authentication failed");
  }
  if (error instanceof RegistryConnectionNotFoundError) {
    return new LocalHttpError(404, "CONNECTION_NOT_FOUND", "The scoped connection was not found");
  }
  if (error instanceof RegistryStateError) {
    return new LocalHttpError(409, "INVALID_REQUEST", "The connection state does not allow this operation");
  }
  if (error instanceof RegistryError) {
    return new LocalHttpError(500, "COLLECTION_FAILED", "The encrypted connection registry could not complete the operation");
  }
  if (error instanceof LocalJobIdempotencyConflictError) {
    return new LocalHttpError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key is already bound to another local fixture request",
    );
  }
  if (error instanceof LocalScheduleNotFoundError) {
    return new LocalHttpError(
      404,
      "SCHEDULE_NOT_FOUND",
      "The scoped local fixture schedule was not found",
    );
  }
  if (error instanceof LocalScheduleStaleMutationError) {
    return new LocalHttpError(
      409,
      "STALE_SCHEDULE_MUTATION",
      "The local fixture schedule mutation was superseded by a newer operation",
    );
  }
  if (
    error instanceof LocalJobValidationError ||
    error instanceof LocalFixtureCatalogError
  ) {
    return invalidRequest();
  }
  if (error instanceof LocalJobStateError || error instanceof LocalJobQueueError) {
    return new LocalHttpError(
      500,
      "COLLECTION_FAILED",
      "The durable local fixture queue could not complete the operation",
    );
  }
  if (error instanceof CollectorError) {
    const mapped = new Map<string, string>([
      ["ASSUME_ROLE_FAILED", "ASSUME_ROLE_FAILED"],
      ["CALLER_IDENTITY_MISMATCH", "CALLER_IDENTITY_MISMATCH"],
      ["NEGATIVE_PROBE_INCONCLUSIVE", "NEGATIVE_PROBE_INCONCLUSIVE"],
      ["TRUST_POLICY_UNSAFE", "TRUST_POLICY_UNSAFE"],
      ["CONNECTION_NOT_FOUND", "CONNECTION_NOT_FOUND"],
    ]).get(error.code);
    return new LocalHttpError(
      error.code === "CONNECTION_NOT_FOUND" ? 404 : 400,
      mapped ?? "COLLECTION_FAILED",
      collectorMessage(mapped),
    );
  }
  const name = errorName(error);
  if (/throttl|requestlimit|toomanyrequest/iu.test(name)) {
    return new LocalHttpError(429, "THROTTLED", "AWS throttled the read-only inventory request");
  }
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) {
    return new LocalHttpError(403, "PERMISSION_DENIED", "The customer role is missing a required read-only permission");
  }
  return new LocalHttpError(502, "COLLECTION_FAILED", "The AWS inventory collection did not complete");
}

function collectorMessage(code: string | undefined): string {
  const messages: Record<string, string> = {
    ASSUME_ROLE_FAILED: "AWS rejected the customer role session",
    CALLER_IDENTITY_MISMATCH: "The assumed identity did not match the registered role and account",
    NEGATIVE_PROBE_INCONCLUSIVE: "The ExternalId trust-policy probes were inconclusive",
    TRUST_POLICY_UNSAFE: "The role trust policy did not require the registered ExternalId",
    CONNECTION_NOT_FOUND: "The scoped connection was not found",
  };
  return code === undefined ? "The AWS inventory collection did not complete" : messages[code] ?? "The AWS inventory collection did not complete";
}

function invalidRequest(): LocalHttpError {
  return new LocalHttpError(400, "INVALID_REQUEST", "The collector request is invalid");
}

function safeRequestTarget(rawUrl: string): string {
  try {
    if (
      rawUrl.length === 0 ||
      rawUrl.length > 2_048 ||
      !rawUrl.startsWith("/") ||
      rawUrl.includes("#") ||
      rawUrl.includes("%")
    ) {
      return "/invalid";
    }
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    if (parsed.hash.length > 0 || parsed.username.length > 0 || parsed.password.length > 0) {
      return "/invalid";
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/invalid";
  }
}

function responseNonce(request: IncomingMessage): string {
  const nonce = request.headers["x-sutra-nonce"];
  return typeof nonce === "string" && nonce.length <= 128 ? nonce : "unauthenticated";
}

function boundaryResourceKey(resource: NormalizedAwsResource): string {
  if (resource.resourceKey.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9._:@/#+=-]*$/u.test(resource.resourceKey)) {
    return resource.resourceKey;
  }
  return `${resource.provider}:${resource.accountId}:${resource.region}:${resource.service}:${sha256(resource.resourceKey).slice(0, 40)}`;
}

function evidenceResourceKey(
  evidence: NormalizedAwsEvidence,
  normalized: readonly NormalizedAwsResource[],
  keyMap: ReadonlyMap<string, string>,
): string | null {
  const candidateIds = new Set([
    evidence.subjectId,
    ...stringArray(evidence.data.resourceIds),
  ]);
  const match = normalized.find(
    (resource) =>
      resource.accountId === evidence.accountId &&
      (resource.region === evidence.region || evidence.region === "global") &&
      (
        evidence.evidenceType === "AWS_NATIVE_FINDING"
          ? candidateIds.has(resource.resourceId) ||
            (resource.arn !== undefined && candidateIds.has(resource.arn))
          : resource.service === evidence.service &&
            (candidateIds.has(resource.resourceId) || resource.resourceType === "aws.iam.account")
      ),
  );
  return match === undefined ? null : keyMap.get(match.resourceKey) ?? null;
}

function nativeFindingControlKey(service: string): string {
  if (service === "guardduty") return "AWS.NATIVE.GUARDDUTY.FINDING";
  if (service === "securityhub") return "AWS.NATIVE.SECURITYHUB.FINDING";
  if (service === "inspector2") return "AWS.NATIVE.INSPECTOR2.FINDING";
  return "AWS.NATIVE.SECURITY.FINDING";
}

function nativeFindingSeverity(value: SafeJsonValue | undefined): PilotFinding["severity"] {
  return value === "critical" || value === "high" || value === "medium" ||
    value === "low" || value === "informational"
    ? value
    : "informational";
}

function nativeFindingStatus(value: SafeJsonValue | undefined): PilotFinding["status"] {
  return value === "open" || value === "acknowledged" || value === "resolved" ||
    value === "suppressed"
    ? value
    : "open";
}

export function isPublicSshIngressCandidate(value: SafeJsonValue | undefined): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!isJsonObject(item)) return false;
    const protocol = item.protocol;
    const from = item.fromPort;
    const to = item.toPort;
    const publicSource =
      stringArray(item.ipv4Cidrs).includes("0.0.0.0/0") ||
      stringArray(item.ipv6Cidrs).includes("::/0");
    if (!publicSource) return false;
    if (protocol === "-1") return true;
    if (protocol !== "tcp" && protocol !== "6") return false;
    return typeof from === "number" && typeof to === "number" && from <= 22 && to >= 22;
  });
}

function scalarString(value: SafeJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: SafeJsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isJsonObject(value: SafeJsonValue): value is SafeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicLocalFixtureScheduleId(
  tenantId: string,
  fixtureId: string,
): string {
  return `sched_${sha256(`local-fixture-schedule\u0000${tenantId}\u0000${fixtureId}`).slice(0, 48)}`;
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "UnknownError";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactBooleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function partitionControlRegion(partition: LocalAwsPartition): string {
  if (partition === "aws-us-gov") return "us-gov-west-1";
  if (partition === "aws-cn") return "cn-north-1";
  return "us-east-1";
}

function collectorMode(value: string | undefined): "fixture" | "live" {
  const normalized = value?.trim() || "fixture";
  if (normalized !== "fixture" && normalized !== "live") {
    throw new Error("SUTRA_COLLECTOR_MODE must be fixture or live");
  }
  return normalized;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalCollectorServer()
    .then((server) => {
      process.stdout.write(`Sutra AWS collector listening on http://${HOST}:${PORT}\n`);
      const shutdown = () => server.close(() => process.exit(0));
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch(() => {
      process.stderr.write("Sutra AWS collector could not start. Check the local pilot configuration.\n");
      process.exitCode = 1;
    });
}
