import { createHash, randomBytes } from "node:crypto";

import type {
  LocalJobDisposition,
  LocalJobRecord,
  LocalJobState,
  LocalJobStateStore,
  LocalJobStatus,
  LocalScheduleRecord,
} from "./local-job-state.js";
import type { SafeJsonObject, SafeJsonValue } from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/;
const FAILURE_CODE = /^[A-Z0-9][A-Z0-9._-]{0,127}$/;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 86_400_000;
const MAX_ATTEMPTS = 1_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 31_536_000_000;

export interface DurableLocalJobQueueOptions {
  readonly store: LocalJobStateStore;
  readonly now?: () => Date;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly leaseTokenFactory?: () => string;
}

export interface EnqueueLocalJobInput {
  readonly tenantId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: SafeJsonObject;
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
}

export interface EnqueueLocalJobResult {
  readonly created: boolean;
  readonly job: LocalJobRecord;
}

export interface LeaseNextLocalJobInput {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly kinds?: readonly string[];
}

export interface FailLocalJobInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly code: string;
  readonly message: string;
}

export interface ListLocalJobsOptions {
  readonly status?: LocalJobStatus;
  readonly kind?: string;
}

export class DurableLocalJobQueue {
  private readonly store: LocalJobStateStore;
  private readonly now: () => Date;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly leaseTokenFactory: () => string;

  public constructor(options: DurableLocalJobQueueOptions) {
    const baseBackoffMs = options.baseBackoffMs ?? 1_000;
    const maxBackoffMs = options.maxBackoffMs ?? 300_000;
    assertIntegerRange(baseBackoffMs, 1, MAX_LEASE_MS, "baseBackoffMs");
    assertIntegerRange(maxBackoffMs, baseBackoffMs, MAX_INTERVAL_MS, "maxBackoffMs");
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.leaseTokenFactory =
      options.leaseTokenFactory ?? (() => randomBytes(24).toString("base64url"));
  }

  public async enqueue(input: EnqueueLocalJobInput): Promise<EnqueueLocalJobResult> {
    const now = validNow(this.now());
    const normalized = normalizeEnqueueInput(input, now);
    return this.store.update((draft) => {
      const candidate = createJobRecord(normalized, now);
      const existing = draft.jobs[candidate.jobId];
      if (existing !== undefined) {
        if (
          existing.tenantId !== candidate.tenantId ||
          existing.idempotencyKey !== candidate.idempotencyKey ||
          existing.requestSha256 !== candidate.requestSha256
        ) {
          throw new LocalJobIdempotencyConflictError();
        }
        return { created: false, job: structuredClone(existing) };
      }
      draft.jobs[candidate.jobId] = candidate;
      return { created: true, job: structuredClone(candidate) };
    });
  }

  public async getJob(tenantId: string, jobId: string): Promise<LocalJobRecord | null> {
    assertIdentifier(tenantId, "tenantId");
    assertIdentifier(jobId, "jobId");
    const job = (await this.store.read()).jobs[jobId];
    return job === undefined || job.tenantId !== tenantId ? null : structuredClone(job);
  }

  public async listJobs(
    tenantId: string,
    options: ListLocalJobsOptions = {},
  ): Promise<readonly LocalJobRecord[]> {
    assertIdentifier(tenantId, "tenantId");
    if (options.kind !== undefined) assertIdentifier(options.kind, "kind");
    if (options.status !== undefined) assertJobStatus(options.status);
    const state = await this.store.read();
    return Object.values(state.jobs)
      .filter(
        (job) =>
          job.tenantId === tenantId &&
          (options.kind === undefined || job.kind === options.kind) &&
          (options.status === undefined || job.status === options.status),
      )
      .sort(compareJobs)
      .map((job) => structuredClone(job));
  }

  public async leaseNext(
    input: LeaseNextLocalJobInput,
  ): Promise<LocalJobRecord | null> {
    assertIdentifier(input.workerId, "workerId");
    assertIntegerRange(input.leaseMs, MIN_LEASE_MS, MAX_LEASE_MS, "leaseMs");
    const kinds = normalizeKinds(input.kinds);
    const now = validNow(this.now());
    const token = this.leaseTokenFactory();
    assertLeaseToken(token);

    return this.store.update((draft) => {
      recoverExpiredLeases(
        draft,
        now,
        this.baseBackoffMs,
        this.maxBackoffMs,
      );
      const next = Object.values(draft.jobs)
        .filter(
          (job) =>
            job.status === "pending" &&
            Date.parse(job.availableAt) <= now.getTime() &&
            (kinds === null || kinds.has(job.kind)),
        )
        .sort(compareRunnableJobs)[0];
      if (next === undefined) return null;

      const timestamp = now.toISOString();
      const leased: LocalJobRecord = {
        ...next,
        status: "leased",
        attempts: next.attempts + 1,
        updatedAt: timestamp,
        lease: {
          workerId: input.workerId,
          token,
          acquiredAt: timestamp,
          expiresAt: new Date(now.getTime() + input.leaseMs).toISOString(),
        },
      };
      draft.jobs[next.jobId] = leased;
      return structuredClone(leased);
    });
  }

  public async heartbeat(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly leaseMs: number;
  }): Promise<LocalJobRecord> {
    assertIdentifier(input.tenantId, "tenantId");
    assertIdentifier(input.jobId, "jobId");
    assertLeaseToken(input.leaseToken);
    assertIntegerRange(input.leaseMs, MIN_LEASE_MS, MAX_LEASE_MS, "leaseMs");
    const now = validNow(this.now());
    return this.store.update((draft) => {
      const job = scopedJob(draft, input.tenantId, input.jobId);
      const lease = activeLease(job, input.leaseToken, now);
      const updated: LocalJobRecord = {
        ...job,
        updatedAt: now.toISOString(),
        lease: {
          ...lease,
          expiresAt: new Date(now.getTime() + input.leaseMs).toISOString(),
        },
      };
      draft.jobs[job.jobId] = updated;
      return structuredClone(updated);
    });
  }

  public async complete(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly result?: SafeJsonObject;
  }): Promise<LocalJobRecord> {
    assertIdentifier(input.tenantId, "tenantId");
    assertIdentifier(input.jobId, "jobId");
    assertLeaseToken(input.leaseToken);
    const result = cloneSafeObject(input.result ?? {});
    const now = validNow(this.now());
    const tokenSha256 = sha256(input.leaseToken);

    return this.store.update((draft) => {
      const job = scopedJob(draft, input.tenantId, input.jobId);
      if (
        job.status === "succeeded" &&
        job.lastDisposition?.leaseTokenSha256 === tokenSha256 &&
        job.lastDisposition.outcome === "succeeded"
      ) {
        return structuredClone(job);
      }
      activeLease(job, input.leaseToken, now);
      const timestamp = now.toISOString();
      const completed: LocalJobRecord = {
        ...withoutLease(job),
        status: "succeeded",
        updatedAt: timestamp,
        completedAt: timestamp,
        result,
        lastDisposition: disposition(tokenSha256, "succeeded", timestamp),
      };
      draft.jobs[job.jobId] = completed;
      return structuredClone(completed);
    });
  }

  public async fail(input: FailLocalJobInput): Promise<LocalJobRecord> {
    assertIdentifier(input.tenantId, "tenantId");
    assertIdentifier(input.jobId, "jobId");
    assertLeaseToken(input.leaseToken);
    if (!FAILURE_CODE.test(input.code)) {
      throw new LocalJobValidationError("failure code is invalid");
    }
    if (input.message.length > 1_000 || input.message.includes("\u0000")) {
      throw new LocalJobValidationError("failure message is invalid");
    }
    const now = validNow(this.now());
    const tokenSha256 = sha256(input.leaseToken);

    return this.store.update((draft) => {
      const job = scopedJob(draft, input.tenantId, input.jobId);
      if (
        job.status !== "leased" &&
        job.lastDisposition?.leaseTokenSha256 === tokenSha256 &&
        (job.lastDisposition.outcome === "retry" ||
          job.lastDisposition.outcome === "dead_letter")
      ) {
        return structuredClone(job);
      }
      activeLease(job, input.leaseToken, now);
      const timestamp = now.toISOString();
      const terminal = job.attempts >= job.maxAttempts;
      const retryAt = terminal
        ? undefined
        : new Date(
            now.getTime() +
              retryDelay(job.attempts, this.baseBackoffMs, this.maxBackoffMs),
          ).toISOString();
      const failed: LocalJobRecord = {
        ...withoutLease(job),
        status: terminal ? "dead_letter" : "pending",
        availableAt: retryAt ?? job.availableAt,
        updatedAt: timestamp,
        lastFailure: {
          code: input.code,
          message: input.message,
          failedAt: timestamp,
          ...(retryAt === undefined ? {} : { retryAt }),
        },
        lastDisposition: disposition(
          tokenSha256,
          terminal ? "dead_letter" : "retry",
          timestamp,
        ),
        ...(terminal ? { completedAt: timestamp } : {}),
      };
      draft.jobs[job.jobId] = failed;
      return structuredClone(failed);
    });
  }

  public async recoverExpiredLeases(): Promise<number> {
    const now = validNow(this.now());
    return this.store.update((draft) =>
      recoverExpiredLeases(
        draft,
        now,
        this.baseBackoffMs,
        this.maxBackoffMs,
      ),
    );
  }
}

export interface DurableLocalSchedulerOptions {
  readonly store: LocalJobStateStore;
  readonly now?: () => Date;
  readonly maxCatchUpPerSchedule?: number;
}

export interface UpsertLocalScheduleInput {
  readonly tenantId: string;
  readonly scheduleId: string;
  readonly kind: string;
  readonly payload: SafeJsonObject;
  readonly everyMs: number;
  readonly firstRunAt?: Date;
  readonly enabled?: boolean;
  readonly maxAttempts?: number;
}

export interface LocalSchedulerTickResult {
  readonly occurrencesProcessed: number;
  readonly jobsCreated: number;
  readonly jobs: readonly LocalJobRecord[];
}

export class DurableLocalScheduler {
  private readonly store: LocalJobStateStore;
  private readonly now: () => Date;
  private readonly maxCatchUpPerSchedule: number;

  public constructor(options: DurableLocalSchedulerOptions) {
    const maxCatchUp = options.maxCatchUpPerSchedule ?? 100;
    assertIntegerRange(maxCatchUp, 1, 10_000, "maxCatchUpPerSchedule");
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.maxCatchUpPerSchedule = maxCatchUp;
  }

  public async upsertSchedule(
    input: UpsertLocalScheduleInput,
  ): Promise<LocalScheduleRecord> {
    assertIdentifier(input.tenantId, "tenantId");
    assertIdentifier(input.scheduleId, "scheduleId");
    assertIdentifier(input.kind, "kind");
    assertIntegerRange(input.everyMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, "everyMs");
    const maxAttempts = input.maxAttempts ?? 5;
    assertIntegerRange(maxAttempts, 1, MAX_ATTEMPTS, "maxAttempts");
    const payload = cloneSafeObject(input.payload);
    const now = validNow(this.now());
    const suppliedFirstRun =
      input.firstRunAt === undefined ? undefined : validNow(input.firstRunAt).toISOString();
    const key = scheduleStateKey(input.tenantId, input.scheduleId);

    return this.store.update((draft) => {
      const previous = draft.schedules[key];
      const timestamp = now.toISOString();
      const schedule: LocalScheduleRecord = {
        tenantId: input.tenantId,
        scheduleId: input.scheduleId,
        kind: input.kind,
        payload,
        everyMs: input.everyMs,
        nextRunAt: suppliedFirstRun ?? previous?.nextRunAt ?? timestamp,
        enabled: input.enabled ?? previous?.enabled ?? true,
        maxAttempts,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      draft.schedules[key] = schedule;
      return structuredClone(schedule);
    });
  }

  public async setScheduleEnabled(
    tenantId: string,
    scheduleId: string,
    enabled: boolean,
  ): Promise<LocalScheduleRecord> {
    assertIdentifier(tenantId, "tenantId");
    assertIdentifier(scheduleId, "scheduleId");
    const now = validNow(this.now());
    const key = scheduleStateKey(tenantId, scheduleId);
    return this.store.update((draft) => {
      const previous = draft.schedules[key];
      if (
        previous === undefined ||
        previous.tenantId !== tenantId ||
        previous.scheduleId !== scheduleId
      ) {
        throw new LocalScheduleNotFoundError();
      }
      const updated = { ...previous, enabled, updatedAt: now.toISOString() };
      draft.schedules[key] = updated;
      return structuredClone(updated);
    });
  }

  public async listSchedules(tenantId: string): Promise<readonly LocalScheduleRecord[]> {
    assertIdentifier(tenantId, "tenantId");
    return Object.values((await this.store.read()).schedules)
      .filter((schedule) => schedule.tenantId === tenantId)
      .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId))
      .map((schedule) => structuredClone(schedule));
  }

  public async runDueSchedules(): Promise<LocalSchedulerTickResult> {
    const now = validNow(this.now());
    return this.store.update((draft) => {
      const createdJobs: LocalJobRecord[] = [];
      let occurrencesProcessed = 0;
      const schedules = Object.entries(draft.schedules).sort(([, left], [, right]) =>
        left.scheduleId.localeCompare(right.scheduleId),
      );

      for (const [key, schedule] of schedules) {
        if (!schedule.enabled) continue;
        let nextRunTime = Date.parse(schedule.nextRunAt);
        let scheduleOccurrences = 0;
        while (
          nextRunTime <= now.getTime() &&
          scheduleOccurrences < this.maxCatchUpPerSchedule
        ) {
          const occurrence = new Date(nextRunTime).toISOString();
          const normalized: NormalizedEnqueueInput = {
            tenantId: schedule.tenantId,
            kind: schedule.kind,
            idempotencyKey: `schedule:${schedule.scheduleId}:${occurrence}`,
            payload: structuredClone(schedule.payload),
            availableAt: occurrence,
            maxAttempts: schedule.maxAttempts,
          };
          const candidate = createJobRecord(normalized, now);
          const existing = draft.jobs[candidate.jobId];
          if (existing === undefined) {
            draft.jobs[candidate.jobId] = candidate;
            createdJobs.push(structuredClone(candidate));
          } else if (existing.requestSha256 !== candidate.requestSha256) {
            throw new LocalJobIdempotencyConflictError();
          }
          nextRunTime += schedule.everyMs;
          scheduleOccurrences += 1;
          occurrencesProcessed += 1;
        }
        if (scheduleOccurrences > 0) {
          draft.schedules[key] = {
            ...schedule,
            nextRunAt: new Date(nextRunTime).toISOString(),
            updatedAt: now.toISOString(),
          };
        }
      }

      return {
        occurrencesProcessed,
        jobsCreated: createdJobs.length,
        jobs: createdJobs,
      };
    });
  }
}

export class LocalJobQueueError extends Error {}

export class LocalJobValidationError extends LocalJobQueueError {
  public constructor(message: string) {
    super(message);
    this.name = "LocalJobValidationError";
  }
}

export class LocalJobIdempotencyConflictError extends LocalJobQueueError {
  public constructor() {
    super("The idempotency key is already bound to a different local job request");
    this.name = "LocalJobIdempotencyConflictError";
  }
}

export class LocalJobNotFoundError extends LocalJobQueueError {
  public constructor() {
    super("The scoped local job was not found");
    this.name = "LocalJobNotFoundError";
  }
}

export class LocalJobLeaseLostError extends LocalJobQueueError {
  public constructor() {
    super("The local job lease is missing, expired, or owned by another worker");
    this.name = "LocalJobLeaseLostError";
  }
}

export class LocalScheduleNotFoundError extends LocalJobQueueError {
  public constructor() {
    super("The scoped local schedule was not found");
    this.name = "LocalScheduleNotFoundError";
  }
}

interface NormalizedEnqueueInput {
  readonly tenantId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: SafeJsonObject;
  readonly availableAt: string;
  readonly maxAttempts: number;
}

function normalizeEnqueueInput(
  input: EnqueueLocalJobInput,
  now: Date,
): NormalizedEnqueueInput {
  assertIdentifier(input.tenantId, "tenantId");
  assertIdentifier(input.kind, "kind");
  if (
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey.length > 512 ||
    input.idempotencyKey.includes("\u0000")
  ) {
    throw new LocalJobValidationError("idempotencyKey is invalid");
  }
  const maxAttempts = input.maxAttempts ?? 5;
  assertIntegerRange(maxAttempts, 1, MAX_ATTEMPTS, "maxAttempts");
  return {
    tenantId: input.tenantId,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    payload: cloneSafeObject(input.payload),
    availableAt: (input.availableAt === undefined ? now : validNow(input.availableAt)).toISOString(),
    maxAttempts,
  };
}

function createJobRecord(input: NormalizedEnqueueInput, now: Date): LocalJobRecord {
  const timestamp = now.toISOString();
  const requestSha256 = sha256(
    canonicalJson({
      tenantId: input.tenantId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      availableAt: input.availableAt,
      maxAttempts: input.maxAttempts,
    }),
  );
  return {
    jobId: `job_${sha256(`${input.tenantId}\u0000${input.kind}\u0000${input.idempotencyKey}`).slice(0, 48)}`,
    tenantId: input.tenantId,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    requestSha256,
    payload: structuredClone(input.payload),
    status: "pending",
    attempts: 0,
    maxAttempts: input.maxAttempts,
    availableAt: input.availableAt,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function recoverExpiredLeases(
  state: LocalJobState,
  now: Date,
  baseBackoffMs: number,
  maxBackoffMs: number,
): number {
  let recovered = 0;
  const timestamp = now.toISOString();
  for (const job of Object.values(state.jobs)) {
    const lease = job.lease;
    if (
      job.status !== "leased" ||
      lease === undefined ||
      Date.parse(lease.expiresAt) > now.getTime()
    ) {
      continue;
    }
    const tokenSha256 = sha256(lease.token);
    const terminal = job.attempts >= job.maxAttempts;
    const retryAt = terminal
      ? undefined
      : new Date(
          now.getTime() + retryDelay(job.attempts, baseBackoffMs, maxBackoffMs),
        ).toISOString();
    state.jobs[job.jobId] = {
      ...withoutLease(job),
      status: terminal ? "dead_letter" : "pending",
      availableAt: retryAt ?? job.availableAt,
      updatedAt: timestamp,
      lastFailure: {
        code: "LEASE_EXPIRED",
        message: "The worker lease expired before the job was settled",
        failedAt: timestamp,
        ...(retryAt === undefined ? {} : { retryAt }),
      },
      lastDisposition: disposition(
        tokenSha256,
        terminal ? "dead_letter" : "retry",
        timestamp,
      ),
      ...(terminal ? { completedAt: timestamp } : {}),
    };
    recovered += 1;
  }
  return recovered;
}

function scopedJob(
  state: LocalJobState,
  tenantId: string,
  jobId: string,
): LocalJobRecord {
  const job = state.jobs[jobId];
  if (job === undefined || job.tenantId !== tenantId) throw new LocalJobNotFoundError();
  return job;
}

function activeLease(
  job: LocalJobRecord,
  token: string,
  now: Date,
): NonNullable<LocalJobRecord["lease"]> {
  const lease = job.lease;
  if (
    job.status !== "leased" ||
    lease === undefined ||
    lease.token !== token ||
    Date.parse(lease.expiresAt) <= now.getTime()
  ) {
    throw new LocalJobLeaseLostError();
  }
  return lease;
}

function withoutLease(job: LocalJobRecord): Omit<LocalJobRecord, "lease"> {
  const { lease, ...without } = job;
  void lease;
  return without;
}

function disposition(
  leaseTokenSha256: string,
  outcome: LocalJobDisposition["outcome"],
  recordedAt: string,
): LocalJobDisposition {
  return { leaseTokenSha256, outcome, recordedAt };
}

function retryDelay(attempts: number, baseBackoffMs: number, maxBackoffMs: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent);
}

function normalizeKinds(kinds: readonly string[] | undefined): ReadonlySet<string> | null {
  if (kinds === undefined) return null;
  if (kinds.length === 0 || kinds.length > 1_000) {
    throw new LocalJobValidationError("kinds must contain between 1 and 1000 values");
  }
  for (const kind of kinds) assertIdentifier(kind, "kind");
  return new Set(kinds);
}

function scheduleStateKey(tenantId: string, scheduleId: string): string {
  return sha256(`${tenantId}\u0000${scheduleId}`);
}

function compareRunnableJobs(left: LocalJobRecord, right: LocalJobRecord): number {
  return (
    Date.parse(left.availableAt) - Date.parse(right.availableAt) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.jobId.localeCompare(right.jobId)
  );
}

function compareJobs(left: LocalJobRecord, right: LocalJobRecord): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.jobId.localeCompare(right.jobId)
  );
}

function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value)) throw new LocalJobValidationError(`${field} is invalid`);
}

function assertLeaseToken(token: string): void {
  if (token.length < 20 || token.length > 256 || token.includes("\u0000")) {
    throw new LocalJobValidationError("lease token is invalid");
  }
}

function assertIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LocalJobValidationError(`${field} must be between ${minimum} and ${maximum}`);
  }
}

function assertJobStatus(status: string): asserts status is LocalJobStatus {
  if (
    status !== "pending" &&
    status !== "leased" &&
    status !== "succeeded" &&
    status !== "dead_letter"
  ) {
    throw new LocalJobValidationError("status is invalid");
  }
}

function validNow(value: Date): Date {
  const copy = new Date(value.getTime());
  if (!Number.isFinite(copy.getTime())) throw new LocalJobValidationError("date is invalid");
  return copy;
}

function cloneSafeObject(value: unknown): SafeJsonObject {
  const normalized = normalizeSafeValue(value, 0);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new LocalJobValidationError("payload must be a JSON object");
  }
  return normalized as SafeJsonObject;
}

function normalizeSafeValue(value: unknown, depth: number): SafeJsonValue {
  if (depth > 32) throw new LocalJobValidationError("JSON payload is too deeply nested");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new LocalJobValidationError("JSON array is too large");
    return value.map((item) => normalizeSafeValue(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) {
    throw new LocalJobValidationError("payload contains a non-JSON value");
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LocalJobValidationError("payload must contain only plain JSON objects");
  }
  const entries = Object.entries(value);
  if (entries.length > 10_000) throw new LocalJobValidationError("JSON object is too large");
  const normalized: Record<string, SafeJsonValue> = {};
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (
      key.length > 256 ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    ) {
      throw new LocalJobValidationError("payload contains an unsafe object key");
    }
    normalized[key] = normalizeSafeValue(item, depth + 1);
  }
  return normalized;
}

function canonicalJson(value: SafeJsonValue): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
