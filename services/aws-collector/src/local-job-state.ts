import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { SafeJsonObject, SafeJsonValue } from "./types.js";

const STATE_FILE_LIMIT = 16 * 1024 * 1024;
const MIN_STATE_FILE_LIMIT = 4 * 1024;
const STATE_WRITE_TARGET_RATIO = 0.9;
const MAX_JOBS = 100_000;
const MAX_SCHEDULES = 10_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type LocalJobStatus = "pending" | "leased" | "succeeded" | "dead_letter";

export interface LocalJobLease {
  readonly workerId: string;
  readonly token: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface LocalJobFailure {
  readonly code: string;
  readonly message: string;
  readonly failedAt: string;
  readonly retryAt?: string;
}

export interface LocalJobDisposition {
  readonly leaseTokenSha256: string;
  readonly outcome: "succeeded" | "retry" | "dead_letter";
  readonly recordedAt: string;
}

export interface LocalJobPublicationReceipt {
  readonly publicationId: string;
  readonly publishedAt: string;
}

export interface LocalJobRecord {
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly payload: SafeJsonObject;
  readonly status: LocalJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lease?: LocalJobLease;
  readonly lastFailure?: LocalJobFailure;
  readonly lastDisposition?: LocalJobDisposition;
  readonly result?: SafeJsonObject;
  readonly completedAt?: string;
  readonly publication?: LocalJobPublicationReceipt;
}

export interface LocalScheduleRecord {
  readonly scheduleId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly payload: SafeJsonObject;
  readonly everyMs: number;
  readonly nextRunAt: string;
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly lastMutationId?: string;
  readonly lastMutationSha256?: string;
  readonly lastMutationSequence?: number;
  readonly capacitySkippedOccurrences?: number;
  readonly capacityBlockedAt?: string;
  readonly missedOccurrences?: number;
  readonly lastMissedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalJobState {
  readonly version: 1;
  readonly jobs: Record<string, LocalJobRecord>;
  readonly schedules: Record<string, LocalScheduleRecord>;
}

/**
 * Queue/scheduler persistence boundary. Implementations must serialize update()
 * calls atomically; queue logic never depends directly on a database or file API.
 */
export interface LocalJobStateStore {
  read(): Promise<LocalJobState>;
  update<Result>(
    mutator: (draft: LocalJobState) => Result | Promise<Result>,
    options?: LocalJobStateUpdateOptions,
  ): Promise<Result>;
}

export interface LocalJobStateUpdateOptions {
  /** Admission keeps headroom; operational transitions may consume the reserve. */
  readonly mode?: "admission" | "operational";
}

export interface JsonFileLocalJobStateStoreOptions {
  readonly filePath: string;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  /** Test/embedding override; production remains capped at 16 MiB. */
  readonly stateFileLimitBytes?: number;
}

/**
 * Durable local JSON state with process serialization, a cross-process lock, and
 * atomic rename publication. Job payloads must contain no credentials or secrets.
 */
export class JsonFileLocalJobStateStore implements LocalJobStateStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly stateFileLimitBytes: number;
  private readonly stateWriteTargetBytes: number;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(options: JsonFileLocalJobStateStoreOptions) {
    if (
      options.filePath.length === 0 ||
      options.filePath.includes("\u0000") ||
      options.filePath.endsWith("/")
    ) {
      throw new LocalJobStateConfigurationError("The local job state path is invalid");
    }
    const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    const staleLockMs = options.staleLockMs ?? 300_000;
    const stateFileLimitBytes = options.stateFileLimitBytes ?? STATE_FILE_LIMIT;
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 100 || lockTimeoutMs > 60_000) {
      throw new LocalJobStateConfigurationError("lockTimeoutMs must be between 100 and 60000");
    }
    if (!Number.isInteger(staleLockMs) || staleLockMs < 10_000 || staleLockMs > 3_600_000) {
      throw new LocalJobStateConfigurationError("staleLockMs must be between 10000 and 3600000");
    }
    if (
      !Number.isInteger(stateFileLimitBytes) ||
      stateFileLimitBytes < MIN_STATE_FILE_LIMIT ||
      stateFileLimitBytes > STATE_FILE_LIMIT
    ) {
      throw new LocalJobStateConfigurationError(
        `stateFileLimitBytes must be between ${MIN_STATE_FILE_LIMIT} and ${STATE_FILE_LIMIT}`,
      );
    }
    this.filePath = options.filePath;
    this.lockPath = `${options.filePath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.stateFileLimitBytes = stateFileLimitBytes;
    this.stateWriteTargetBytes = Math.floor(
      stateFileLimitBytes * STATE_WRITE_TARGET_RATIO,
    );
  }

  public async read(): Promise<LocalJobState> {
    await this.writeTail;
    return structuredClone(await this.readState());
  }

  public async update<Result>(
    mutator: (draft: LocalJobState) => Result | Promise<Result>,
    options: LocalJobStateUpdateOptions = {},
  ): Promise<Result> {
    const operation = this.writeTail.then(() =>
      this.withFileLock(async () => {
        const previous = await this.readState();
        const draft = structuredClone(previous);
        const result = await mutator(draft);
        const validated = parseState(draft);
        if (JSON.stringify(previous) !== JSON.stringify(validated)) {
          await this.writeState(
            validated,
            options.mode === "operational"
              ? this.stateFileLimitBytes
              : this.stateWriteTargetBytes,
            terminalJobsChangedByMutation(previous, validated),
          );
        }
        return structuredClone(result);
      }),
    );
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async readState(): Promise<LocalJobState> {
    try {
      // Check and read through one handle: an lstat on the path followed by a
      // readFile of the same path lets the file be swapped between the two.
      // O_NOFOLLOW makes open itself refuse a symlink, and fstat on the handle
      // describes exactly the file the read below will see.
      const handle = await open(
        this.filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let raw: string;
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > this.stateFileLimitBytes) {
          throw new LocalJobStateIntegrityError();
        }
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      if (Buffer.byteLength(raw, "utf8") > this.stateFileLimitBytes) {
        throw new LocalJobStateIntegrityError();
      }
      return parseState(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      if (isMissingFile(error)) return emptyState();
      if (error instanceof LocalJobStateError) throw error;
      throw new LocalJobStateIntegrityError();
    }
  }

  private async writeState(
    state: LocalJobState,
    maximumBytes: number,
    protectedTerminalJobIds: ReadonlySet<string>,
  ): Promise<void> {
    const serialized = serializeStateWithinLimit(
      state,
      maximumBytes,
      protectedTerminalJobIds,
    );
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async withFileLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    let handle;
    while (handle === undefined) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          "utf8",
        );
        await handle.sync();
      } catch (error: unknown) {
        if (!isFileExists(error)) throw new LocalJobStateIntegrityError();
        await this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new LocalJobStateLockTimeoutError();
        }
        await delay(10);
      }
    }

    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const metadata = await lstat(this.lockPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new LocalJobStateIntegrityError();
      }
      if (Date.now() - metadata.mtimeMs > this.staleLockMs) {
        await rm(this.lockPath, { force: true });
      }
    } catch (error: unknown) {
      if (isMissingFile(error)) return;
      if (error instanceof LocalJobStateError) throw error;
      throw new LocalJobStateIntegrityError();
    }
  }
}

/** Useful for deterministic unit tests or an explicitly non-durable embedding. */
export class MemoryLocalJobStateStore implements LocalJobStateStore {
  private state: LocalJobState = emptyState();
  private writeTail: Promise<void> = Promise.resolve();

  public async read(): Promise<LocalJobState> {
    await this.writeTail;
    return structuredClone(this.state);
  }

  public async update<Result>(
    mutator: (draft: LocalJobState) => Result | Promise<Result>,
    _options: LocalJobStateUpdateOptions = {},
  ): Promise<Result> {
    void _options;
    const operation = this.writeTail.then(async () => {
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      this.state = parseState(draft);
      return structuredClone(result);
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

export class LocalJobStateError extends Error {}

export class LocalJobStateConfigurationError extends LocalJobStateError {
  public constructor(message: string) {
    super(message);
    this.name = "LocalJobStateConfigurationError";
  }
}

export class LocalJobStateIntegrityError extends LocalJobStateError {
  public constructor() {
    super("The durable local job state failed validation");
    this.name = "LocalJobStateIntegrityError";
  }
}

export class LocalJobStateLockTimeoutError extends LocalJobStateError {
  public constructor() {
    super("Timed out acquiring the durable local job state lock");
    this.name = "LocalJobStateLockTimeoutError";
  }
}

export class LocalJobStateCapacityError extends LocalJobStateError {
  public constructor() {
    super("The durable local job state has reached its safe byte capacity");
    this.name = "LocalJobStateCapacityError";
  }
}

function terminalJobsChangedByMutation(
  previous: LocalJobState,
  next: LocalJobState,
): ReadonlySet<string> {
  const protectedJobIds = new Set<string>();
  for (const job of Object.values(next.jobs)) {
    if (!isTerminalJob(job)) continue;
    const previousJob = previous.jobs[job.jobId];
    if (previousJob === undefined || JSON.stringify(previousJob) !== JSON.stringify(job)) {
      protectedJobIds.add(job.jobId);
    }
  }
  return protectedJobIds;
}

function serializeStateWithinLimit(
  state: LocalJobState,
  maximumBytes: number,
  protectedTerminalJobIds: ReadonlySet<string>,
): string {
  let serialized = JSON.stringify(state);
  let serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes <= maximumBytes) return serialized;

  const candidates = Object.values(state.jobs)
    .filter((job) => isPrunableTerminalJob(job) && !protectedTerminalJobIds.has(job.jobId))
    .sort(compareOldestTerminalJobs);
  let remainingJobCount = Object.keys(state.jobs).length;
  for (const job of candidates) {
    const entryBytes =
      Buffer.byteLength(JSON.stringify(job.jobId), "utf8") +
      1 +
      Buffer.byteLength(JSON.stringify(job), "utf8");
    delete state.jobs[job.jobId];
    serializedBytes -= entryBytes + (remainingJobCount > 1 ? 1 : 0);
    remainingJobCount -= 1;
    if (serializedBytes <= maximumBytes) break;
  }

  serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new LocalJobStateCapacityError();
  }
  return serialized;
}

function isTerminalJob(job: LocalJobRecord): boolean {
  return job.status === "succeeded" || job.status === "dead_letter";
}

function isPrunableTerminalJob(job: LocalJobRecord): boolean {
  return job.status === "dead_letter" ||
    (job.status === "succeeded" && job.publication !== undefined);
}

function compareOldestTerminalJobs(
  left: LocalJobRecord,
  right: LocalJobRecord,
): number {
  return (
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
    left.jobId.localeCompare(right.jobId)
  );
}

function emptyState(): LocalJobState {
  return { version: 1, jobs: {}, schedules: {} };
}

function parseState(value: unknown): LocalJobState {
  if (!isRecord(value) || value.version !== 1) throw new LocalJobStateIntegrityError();
  if (!isRecord(value.jobs) || !isRecord(value.schedules)) {
    throw new LocalJobStateIntegrityError();
  }
  const jobEntries = Object.entries(value.jobs);
  const scheduleEntries = Object.entries(value.schedules);
  if (jobEntries.length > MAX_JOBS || scheduleEntries.length > MAX_SCHEDULES) {
    throw new LocalJobStateIntegrityError();
  }

  const jobs: Record<string, LocalJobRecord> = {};
  for (const [key, candidate] of jobEntries) {
    const job = parseJob(candidate);
    if (
      key !== job.jobId ||
      job.jobId !== deterministicJobId(job.tenantId, job.kind, job.idempotencyKey) ||
      jobs[key] !== undefined
    ) {
      throw new LocalJobStateIntegrityError();
    }
    jobs[key] = job;
  }
  const schedules: Record<string, LocalScheduleRecord> = {};
  for (const [key, candidate] of scheduleEntries) {
    if (!SHA256.test(key)) throw new LocalJobStateIntegrityError();
    const schedule = parseSchedule(candidate);
    if (key !== scheduleStateKey(schedule.tenantId, schedule.scheduleId)) {
      throw new LocalJobStateIntegrityError();
    }
    schedules[key] = schedule;
  }
  return { version: 1, jobs, schedules };
}

function parseJob(value: unknown): LocalJobRecord {
  if (!isRecord(value)) throw new LocalJobStateIntegrityError();
  const status = value.status;
  if (
    status !== "pending" &&
    status !== "leased" &&
    status !== "succeeded" &&
    status !== "dead_letter"
  ) {
    throw new LocalJobStateIntegrityError();
  }
  assertIdentifier(value.jobId);
  assertIdentifier(value.tenantId);
  assertIdentifier(value.kind);
  if (
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.length === 0 ||
    value.idempotencyKey.length > 512 ||
    value.idempotencyKey.includes("\u0000") ||
    typeof value.requestSha256 !== "string" ||
    !SHA256.test(value.requestSha256) ||
    !isSafeJsonObject(value.payload) ||
    !isIntegerInRange(value.attempts, 0, 1_000) ||
    !isIntegerInRange(value.maxAttempts, 1, 1_000)
  ) {
    throw new LocalJobStateIntegrityError();
  }
  assertTimestamp(value.availableAt);
  assertTimestamp(value.createdAt);
  assertTimestamp(value.updatedAt);
  const lease = value.lease === undefined ? undefined : parseLease(value.lease);
  if ((status === "leased") !== (lease !== undefined)) {
    throw new LocalJobStateIntegrityError();
  }
  const lastFailure =
    value.lastFailure === undefined ? undefined : parseFailure(value.lastFailure);
  const lastDisposition =
    value.lastDisposition === undefined
      ? undefined
      : parseDisposition(value.lastDisposition);
  const result = value.result === undefined ? undefined : parseSafeObject(value.result);
  const completedAt =
    value.completedAt === undefined ? undefined : parseTimestamp(value.completedAt);
  const publication = value.publication === undefined
    ? undefined
    : parsePublicationReceipt(value.publication);
  if ((status === "succeeded" || status === "dead_letter") !== (completedAt !== undefined)) {
    throw new LocalJobStateIntegrityError();
  }
  if (status === "succeeded" && result === undefined) {
    throw new LocalJobStateIntegrityError();
  }
  if (publication !== undefined && status !== "succeeded") {
    throw new LocalJobStateIntegrityError();
  }
  return {
    jobId: value.jobId,
    tenantId: value.tenantId,
    kind: value.kind,
    idempotencyKey: value.idempotencyKey,
    requestSha256: value.requestSha256,
    payload: structuredClone(value.payload),
    status,
    attempts: value.attempts,
    maxAttempts: value.maxAttempts,
    availableAt: value.availableAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(lease === undefined ? {} : { lease }),
    ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(lastDisposition === undefined ? {} : { lastDisposition }),
    ...(result === undefined ? {} : { result }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(publication === undefined ? {} : { publication }),
  };
}

function parsePublicationReceipt(value: unknown): LocalJobPublicationReceipt {
  if (!isRecord(value)) throw new LocalJobStateIntegrityError();
  assertIdentifier(value.publicationId);
  assertTimestamp(value.publishedAt);
  return { publicationId: value.publicationId, publishedAt: value.publishedAt };
}

function parseSchedule(value: unknown): LocalScheduleRecord {
  if (!isRecord(value)) throw new LocalJobStateIntegrityError();
  assertIdentifier(value.scheduleId);
  assertIdentifier(value.tenantId);
  assertIdentifier(value.kind);
  if (
    !isSafeJsonObject(value.payload) ||
    !isIntegerInRange(value.everyMs, 1_000, 31_536_000_000) ||
    typeof value.enabled !== "boolean" ||
    !isIntegerInRange(value.maxAttempts, 1, 1_000)
  ) {
    throw new LocalJobStateIntegrityError();
  }
  assertTimestamp(value.nextRunAt);
  assertTimestamp(value.createdAt);
  assertTimestamp(value.updatedAt);
  const lastMutationId = value.lastMutationId;
  const lastMutationSha256 = value.lastMutationSha256;
  const lastMutationSequence = value.lastMutationSequence;
  const capacitySkippedOccurrences = value.capacitySkippedOccurrences;
  const capacityBlockedAt = value.capacityBlockedAt;
  const missedOccurrences = value.missedOccurrences;
  const lastMissedAt = value.lastMissedAt;
  if (
    (lastMutationId === undefined) !== (lastMutationSha256 === undefined) ||
    (lastMutationId !== undefined && (
      typeof lastMutationId !== "string" ||
      !/^schedop_[a-f0-9]{48}$/u.test(lastMutationId) ||
      typeof lastMutationSha256 !== "string" ||
      !SHA256.test(lastMutationSha256)
    ))
  ) {
    throw new LocalJobStateIntegrityError();
  }
  if (
    lastMutationSequence !== undefined &&
    (!isIntegerInRange(lastMutationSequence, 1, Number.MAX_SAFE_INTEGER) ||
      lastMutationId === undefined)
  ) {
    throw new LocalJobStateIntegrityError();
  }
  if (
    (capacitySkippedOccurrences !== undefined &&
      !isIntegerInRange(capacitySkippedOccurrences, 0, Number.MAX_SAFE_INTEGER)) ||
    (capacityBlockedAt !== undefined && typeof capacityBlockedAt !== "string")
  ) {
    throw new LocalJobStateIntegrityError();
  }
  if (capacityBlockedAt !== undefined) assertTimestamp(capacityBlockedAt);
  if (
    (missedOccurrences !== undefined &&
      !isIntegerInRange(missedOccurrences, 0, Number.MAX_SAFE_INTEGER)) ||
    (lastMissedAt !== undefined && typeof lastMissedAt !== "string") ||
    ((missedOccurrences ?? 0) > 0) !== (lastMissedAt !== undefined)
  ) {
    throw new LocalJobStateIntegrityError();
  }
  if (lastMissedAt !== undefined) assertTimestamp(lastMissedAt);
  return {
    scheduleId: value.scheduleId,
    tenantId: value.tenantId,
    kind: value.kind,
    payload: structuredClone(value.payload),
    everyMs: value.everyMs,
    nextRunAt: value.nextRunAt,
    enabled: value.enabled,
    maxAttempts: value.maxAttempts,
    ...(typeof lastMutationId === "string" && typeof lastMutationSha256 === "string"
      ? { lastMutationId, lastMutationSha256 }
      : {}),
    ...(typeof lastMutationSequence === "number" ? { lastMutationSequence } : {}),
    ...(typeof capacitySkippedOccurrences === "number" ? { capacitySkippedOccurrences } : {}),
    ...(typeof capacityBlockedAt === "string" ? { capacityBlockedAt } : {}),
    ...(typeof missedOccurrences === "number" ? { missedOccurrences } : {}),
    ...(typeof lastMissedAt === "string" ? { lastMissedAt } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseLease(value: unknown): LocalJobLease {
  if (!isRecord(value)) throw new LocalJobStateIntegrityError();
  assertIdentifier(value.workerId);
  if (
    typeof value.token !== "string" ||
    value.token.length < 20 ||
    value.token.length > 256 ||
    value.token.includes("\u0000")
  ) {
    throw new LocalJobStateIntegrityError();
  }
  assertTimestamp(value.acquiredAt);
  assertTimestamp(value.expiresAt);
  return {
    workerId: value.workerId,
    token: value.token,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
  };
}

function parseFailure(value: unknown): LocalJobFailure {
  if (!isRecord(value)) throw new LocalJobStateIntegrityError();
  assertIdentifier(value.code);
  if (typeof value.message !== "string" || value.message.length > 1_000) {
    throw new LocalJobStateIntegrityError();
  }
  assertTimestamp(value.failedAt);
  const retryAt = value.retryAt === undefined ? undefined : parseTimestamp(value.retryAt);
  return {
    code: value.code,
    message: value.message,
    failedAt: value.failedAt,
    ...(retryAt === undefined ? {} : { retryAt }),
  };
}

function parseDisposition(value: unknown): LocalJobDisposition {
  if (!isRecord(value)) throw new LocalJobStateIntegrityError();
  if (
    typeof value.leaseTokenSha256 !== "string" ||
    !SHA256.test(value.leaseTokenSha256) ||
    (value.outcome !== "succeeded" &&
      value.outcome !== "retry" &&
      value.outcome !== "dead_letter")
  ) {
    throw new LocalJobStateIntegrityError();
  }
  assertTimestamp(value.recordedAt);
  return {
    leaseTokenSha256: value.leaseTokenSha256,
    outcome: value.outcome,
    recordedAt: value.recordedAt,
  };
}

function parseSafeObject(value: unknown): SafeJsonObject {
  if (!isSafeJsonObject(value)) throw new LocalJobStateIntegrityError();
  return structuredClone(value);
}

function parseTimestamp(value: unknown): string {
  assertTimestamp(value);
  return value;
}

function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new LocalJobStateIntegrityError();
  }
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new LocalJobStateIntegrityError();
  }
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isSafeJsonObject(value: unknown): value is SafeJsonObject {
  return isSafeJsonValue(value, 0) && !Array.isArray(value) && value !== null;
}

function isSafeJsonValue(value: unknown, depth: number): value is SafeJsonValue {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= 10_000 && value.every((item) => isSafeJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 10_000 &&
    entries.every(
      ([key, item]) =>
        key.length <= 256 &&
        key !== "__proto__" &&
        key !== "prototype" &&
        key !== "constructor" &&
        isSafeJsonValue(item, depth + 1),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function deterministicJobId(tenantId: string, kind: string, idempotencyKey: string): string {
  return `job_${sha256(`${tenantId}\u0000${kind}\u0000${idempotencyKey}`).slice(0, 48)}`;
}

function scheduleStateKey(tenantId: string, scheduleId: string): string {
  return sha256(`${tenantId}\u0000${scheduleId}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isFileExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
