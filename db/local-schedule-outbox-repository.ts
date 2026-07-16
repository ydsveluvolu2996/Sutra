import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  appendAuditEvent,
  LOCAL_ORG_ID,
  PilotRepositoryError,
} from "./pilot-repository";
import { canonicalJson } from "../lib/canonical-json";
import type { JsonValue } from "../lib/pilot-types";

const OPERATION_ID = /^schedop_[a-f0-9]{48}$/u;
const SCHEDULE_ID = /^sched_[a-f0-9]{48}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CUSTOMER_ID = /^cust_[a-f0-9]{32}$/u;
const SCOPED_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;
const FIXTURE_VERSION = /^(?:2026\.07\.0|2026\.07\.1)$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export type LocalScheduleMutationStatus = "pending" | "completed" | "failed";
export type LocalScheduleMutationKind = "upsert" | "toggle";

export interface LocalScheduleUpsertCommand {
  readonly fixtureId: string;
  readonly version: "2026.07.0" | "2026.07.1";
  readonly everyMs: number;
  readonly enabled: boolean;
  readonly firstRunAt: string;
}

export interface LocalScheduleToggleCommand {
  readonly fixtureId: string;
  readonly enabled: boolean;
}

interface LocalScheduleMutationBase {
  readonly operationId: string;
  /** Monotonic durable outbox order, enforced by the collector per schedule. */
  readonly mutationSequence: number;
  readonly orgId: string;
  readonly actorId: string;
  readonly customerId: string | null;
  readonly scheduleId: string;
  readonly fixtureId: string;
  readonly connectionId: string;
  readonly commandSha256: string;
  readonly status: LocalScheduleMutationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly failureCode: string | null;
  readonly failedAt: string | null;
}

export type LocalScheduleMutation =
  | LocalScheduleMutationBase & {
    readonly operationKind: "upsert";
    readonly command: LocalScheduleUpsertCommand;
  }
  | LocalScheduleMutationBase & {
    readonly operationKind: "toggle";
    readonly command: LocalScheduleToggleCommand;
  };

interface BeginMutationBase {
  readonly operationId: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly customerId: string | null;
  readonly scheduleId: string;
  readonly fixtureId: string;
  readonly connectionId: string;
}

export type BeginLocalScheduleMutationInput =
  | BeginMutationBase & {
    readonly operationKind: "upsert";
    readonly command: LocalScheduleUpsertCommand;
  }
  | BeginMutationBase & {
    readonly operationKind: "toggle";
    readonly command: LocalScheduleToggleCommand;
  };

interface MutationRow {
  mutation_sequence: number;
  operation_id: string;
  org_id: string;
  actor_id: string;
  customer_id: string | null;
  schedule_id: string;
  fixture_id: string;
  connection_id: string;
  operation_kind: string;
  command_json: string;
  command_sha256: string;
  status: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  failure_code: string | null;
  failed_at: number | null;
}

interface ValidatedMutationInput {
  readonly operationId: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly customerId: string | null;
  readonly scheduleId: string;
  readonly fixtureId: string;
  readonly connectionId: string;
  readonly operationKind: LocalScheduleMutationKind;
  readonly command: LocalScheduleUpsertCommand | LocalScheduleToggleCommand;
  readonly commandJson: string;
  readonly commandSha256: string;
}

function database(): D1Database {
  return getRawDb();
}

async function readyDatabase(): Promise<D1Database> {
  const db = database();
  await ensureRuntimeSchema(db);
  return db;
}

function invalid(message: string): never {
  throw new PilotRepositoryError("INVALID_STATE", message);
}

function conflict(): never {
  throw new PilotRepositoryError(
    "CONFLICT",
    "The schedule operation identifier conflicts with a different pending command",
  );
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("The schedule mutation command must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalid("The schedule mutation command contains unsupported fields");
  }
  return record;
}

function scopedId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) invalid(`The schedule mutation ${label} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    invalid("The schedule mutation first-run timestamp is invalid");
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    invalid("The schedule mutation first-run timestamp is not canonical UTC");
  }
  return value;
}

function parseCommand(
  operationKind: LocalScheduleMutationKind,
  fixtureId: string,
  value: unknown,
): LocalScheduleUpsertCommand | LocalScheduleToggleCommand {
  if (operationKind === "upsert") {
    const command = exactRecord(value, ["fixtureId", "version", "everyMs", "enabled", "firstRunAt"]);
    if (
      command.fixtureId !== fixtureId ||
      typeof command.fixtureId !== "string" ||
      !SCOPED_ID.test(command.fixtureId) ||
      typeof command.version !== "string" ||
      !FIXTURE_VERSION.test(command.version) ||
      !Number.isSafeInteger(command.everyMs) ||
      (command.everyMs as number) < 1_000 ||
      (command.everyMs as number) > 31_536_000_000 ||
      typeof command.enabled !== "boolean"
    ) {
      invalid("The schedule upsert command is invalid");
    }
    return {
      fixtureId: command.fixtureId,
      version: command.version as LocalScheduleUpsertCommand["version"],
      everyMs: command.everyMs as number,
      enabled: command.enabled,
      firstRunAt: canonicalTimestamp(command.firstRunAt),
    };
  }

  const command = exactRecord(value, ["fixtureId", "enabled"]);
  if (
    command.fixtureId !== fixtureId ||
    typeof command.fixtureId !== "string" ||
    !SCOPED_ID.test(command.fixtureId) ||
    typeof command.enabled !== "boolean"
  ) {
    invalid("The schedule toggle command is invalid");
  }
  return { fixtureId: command.fixtureId, enabled: command.enabled };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function validateInput(input: BeginLocalScheduleMutationInput): Promise<ValidatedMutationInput> {
  const operationId = scopedId(input.operationId, OPERATION_ID, "operation identifier");
  const orgId = scopedId(input.orgId, SCOPED_ID, "organization identifier");
  if (orgId !== LOCAL_ORG_ID) {
    invalid("The schedule mutation organization is outside this local workspace");
  }
  const actorId = scopedId(input.actorId, SCOPED_ID, "actor identifier");
  const customerId = input.customerId === null
    ? null
    : scopedId(input.customerId, CUSTOMER_ID, "customer identifier");
  const scheduleId = scopedId(input.scheduleId, SCHEDULE_ID, "schedule identifier");
  const fixtureId = scopedId(input.fixtureId, SCOPED_ID, "fixture identifier");
  const connectionId = scopedId(input.connectionId, CONNECTION_ID, "connection identifier");
  const command = parseCommand(input.operationKind, fixtureId, input.command);
  const commandJson = canonicalJson(command);
  return {
    operationId,
    orgId,
    actorId,
    customerId,
    scheduleId,
    fixtureId,
    connectionId,
    operationKind: input.operationKind,
    command,
    commandJson,
    commandSha256: await sha256Hex(commandJson),
  };
}

const MUTATION_COLUMNS = `mutation_sequence, operation_id, org_id, actor_id, customer_id,
  schedule_id, fixture_id, connection_id, operation_kind, command_json,
  command_sha256, status, created_at, updated_at, completed_at, failure_code,
  failed_at`;

async function findMutationRow(
  db: D1Database,
  operationId: string,
): Promise<MutationRow | null> {
  return db.prepare(
    `SELECT ${MUTATION_COLUMNS}
       FROM local_schedule_mutation_outbox
      WHERE operation_id = ?
      LIMIT 1`,
  ).bind(operationId).first<MutationRow>();
}

function parseStoredCommand(row: MutationRow): LocalScheduleUpsertCommand | LocalScheduleToggleCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(row.command_json) as unknown;
  } catch {
    invalid("The stored schedule mutation command is corrupt");
  }
  if (row.operation_kind !== "upsert" && row.operation_kind !== "toggle") {
    invalid("The stored schedule mutation kind is corrupt");
  }
  const command = parseCommand(row.operation_kind, row.fixture_id, raw);
  if (canonicalJson(command) !== row.command_json) {
    invalid("The stored schedule mutation command is not canonical");
  }
  return command;
}

async function toMutation(row: MutationRow): Promise<LocalScheduleMutation> {
  if (
    !Number.isSafeInteger(row.mutation_sequence) ||
    row.mutation_sequence < 1 ||
    !OPERATION_ID.test(row.operation_id) ||
    !SCOPED_ID.test(row.org_id) ||
    !SCOPED_ID.test(row.actor_id) ||
    (row.customer_id !== null && !CUSTOMER_ID.test(row.customer_id)) ||
    !SCHEDULE_ID.test(row.schedule_id) ||
    !SCOPED_ID.test(row.fixture_id) ||
    !CONNECTION_ID.test(row.connection_id) ||
    (row.status !== "pending" && row.status !== "completed" && row.status !== "failed") ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.updated_at) ||
    row.updated_at < row.created_at ||
    (row.completed_at !== null && (!Number.isSafeInteger(row.completed_at) || row.completed_at < row.created_at)) ||
    (row.failed_at !== null && (!Number.isSafeInteger(row.failed_at) || row.failed_at < row.created_at)) ||
    ((row.status === "completed") !== (row.completed_at !== null)) ||
    ((row.status === "failed") !== (row.failed_at !== null)) ||
    ((row.status === "failed") !== (row.failure_code !== null)) ||
    (row.failure_code !== null && !FAILURE_CODE.test(row.failure_code))
  ) {
    invalid("The stored schedule mutation state is corrupt");
  }
  const command = parseStoredCommand(row);
  if (await sha256Hex(row.command_json) !== row.command_sha256) {
    invalid("The stored schedule mutation digest is corrupt");
  }
  const base: LocalScheduleMutationBase = {
    operationId: row.operation_id,
    mutationSequence: row.mutation_sequence,
    orgId: row.org_id,
    actorId: row.actor_id,
    customerId: row.customer_id,
    scheduleId: row.schedule_id,
    fixtureId: row.fixture_id,
    connectionId: row.connection_id,
    commandSha256: row.command_sha256,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    failureCode: row.failure_code,
    failedAt: row.failed_at === null ? null : new Date(row.failed_at).toISOString(),
  };
  return row.operation_kind === "upsert"
    ? { ...base, operationKind: "upsert", command: command as LocalScheduleUpsertCommand }
    : { ...base, operationKind: "toggle", command: command as LocalScheduleToggleCommand };
}

function assertSameMutation(row: MutationRow, input: ValidatedMutationInput): void {
  const scopeDiffers =
    row.org_id !== input.orgId ||
    row.actor_id !== input.actorId ||
    row.customer_id !== input.customerId ||
    row.schedule_id !== input.scheduleId ||
    row.fixture_id !== input.fixtureId ||
    row.connection_id !== input.connectionId ||
    row.operation_kind !== input.operationKind;
  if (scopeDiffers) conflict();
  if (
    row.command_json === input.commandJson &&
    row.command_sha256 === input.commandSha256
  ) return;

  // firstRunAt is generated by the server, not supplied by the caller. The
  // INSERT OR IGNORE winner owns it so concurrent retries of the same user
  // command converge on the one durable timestamp instead of returning 409.
  if (row.operation_kind === "upsert" && input.operationKind === "upsert") {
    const stored = parseStoredCommand(row) as LocalScheduleUpsertCommand;
    const candidate = input.command as LocalScheduleUpsertCommand;
    if (
      stored.fixtureId === candidate.fixtureId &&
      stored.version === candidate.version &&
      stored.everyMs === candidate.everyMs &&
      stored.enabled === candidate.enabled
    ) return;
  }
  conflict();
}

/**
 * Persist a collector command before it crosses the local process boundary.
 * Retrying the same operation is idempotent; any changed scope or command is
 * rejected so an idempotency key can never be repurposed.
 */
export async function beginLocalScheduleMutation(
  input: BeginLocalScheduleMutationInput,
): Promise<LocalScheduleMutation> {
  const validated = await validateInput(input);
  const db = await readyDatabase();
  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await db.prepare(
      `INSERT OR IGNORE INTO local_schedule_mutation_outbox
        (operation_id, mutation_sequence, org_id, actor_id, customer_id, schedule_id, fixture_id,
         connection_id, operation_kind, command_json, command_sha256, status,
         created_at, updated_at, completed_at, failure_code, failed_at)
       SELECT ?, COALESCE(MAX(mutation_sequence), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'pending', ?, ?, NULL, NULL, NULL
         FROM local_schedule_mutation_outbox`,
    ).bind(
      validated.operationId,
      validated.orgId,
      validated.actorId,
      validated.customerId,
      validated.scheduleId,
      validated.fixtureId,
      validated.connectionId,
      validated.operationKind,
      validated.commandJson,
      validated.commandSha256,
      now,
      now,
    ).run();
    const stored = await findMutationRow(db, validated.operationId);
    if (stored !== null) {
      assertSameMutation(stored, validated);
      return toMutation(stored);
    }
  }
  throw new PilotRepositoryError(
    "PERSISTENCE_FAILED",
    "The schedule operation could not reserve a durable mutation sequence",
  );
}

export async function getLocalScheduleMutation(
  orgId: string,
  operationId: string,
): Promise<LocalScheduleMutation | null> {
  scopedId(orgId, SCOPED_ID, "organization identifier");
  if (orgId !== LOCAL_ORG_ID) invalid("The schedule mutation organization is outside this local workspace");
  scopedId(operationId, OPERATION_ID, "operation identifier");
  const row = await findMutationRow(await readyDatabase(), operationId);
  if (row === null || row.org_id !== orgId) return null;
  return toMutation(row);
}

/** Return pending work in the immutable order assigned by the durable outbox. */
export async function listPendingLocalScheduleMutations(input: {
  readonly orgId: string;
  readonly limit?: number;
}): Promise<readonly LocalScheduleMutation[]> {
  const orgId = scopedId(input.orgId, SCOPED_ID, "organization identifier");
  if (orgId !== LOCAL_ORG_ID) invalid("The schedule mutation organization is outside this local workspace");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    invalid("The pending schedule mutation limit is invalid");
  }
  const result = await (await readyDatabase()).prepare(
    `SELECT ${MUTATION_COLUMNS}
      FROM local_schedule_mutation_outbox
      WHERE org_id = ? AND status = 'pending'
      ORDER BY mutation_sequence ASC
      LIMIT ?`,
  ).bind(orgId, limit).all<MutationRow>();
  return Promise.all((result.results ?? []).map(toMutation));
}

/**
 * Append the mutation's immutable audit evidence, then mark it complete. If a
 * crash occurs between those steps, replay sees the same request id, verifies
 * the existing event, and safely finishes the pending row.
 */
export async function completeLocalScheduleMutation(input: {
  readonly orgId: string;
  readonly operationId: string;
}): Promise<LocalScheduleMutation> {
  const orgId = scopedId(input.orgId, SCOPED_ID, "organization identifier");
  if (orgId !== LOCAL_ORG_ID) invalid("The schedule mutation organization is outside this local workspace");
  const operationId = scopedId(input.operationId, OPERATION_ID, "operation identifier");
  const db = await readyDatabase();
  const row = await findMutationRow(db, operationId);
  if (row === null || row.org_id !== orgId) {
    throw new PilotRepositoryError("NOT_FOUND", "The pending schedule operation was not found");
  }
  const mutation = await toMutation(row);
  if (mutation.status === "failed") {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "A failed schedule operation cannot be completed",
    );
  }
  const operation = mutation.operationKind === "upsert"
    ? "upserted"
    : mutation.command.enabled ? "enabled" : "disabled";
  await appendAuditEvent({
    requestId: mutation.operationId,
    actorId: mutation.actorId,
    action: `fixture.schedule.${operation}`,
    targetType: "local_fixture_schedule",
    targetId: mutation.scheduleId,
    customerId: mutation.customerId,
    outcome: "allowed",
    metadata: {
      fixtureId: mutation.fixtureId,
      connectionId: mutation.connectionId,
      mutationSequence: mutation.mutationSequence,
      operationKind: mutation.operationKind,
      command: mutation.command as unknown as JsonValue,
    },
  });

  const now = Date.now();
  await db.prepare(
    `UPDATE local_schedule_mutation_outbox
        SET status = 'completed', updated_at = ?, completed_at = ?
      WHERE operation_id = ? AND org_id = ? AND status = 'pending'`,
  ).bind(now, now, mutation.operationId, mutation.orgId).run();
  const completed = await findMutationRow(db, mutation.operationId);
  if (completed === null || completed.org_id !== mutation.orgId || completed.status !== "completed") {
    throw new PilotRepositoryError(
      "PERSISTENCE_FAILED",
      "The audited schedule operation could not be finalized",
    );
  }
  return toMutation(completed);
}

/**
 * Dead-letter a permanently unreplayable command without blocking newer work.
 * The failed audit is written first with the operation id as its idempotency
 * key. A crash before the terminal row update can therefore replay safely.
 */
export async function failLocalScheduleMutation(input: {
  readonly orgId: string;
  readonly operationId: string;
  readonly failureCode: string;
}): Promise<LocalScheduleMutation> {
  const orgId = scopedId(input.orgId, SCOPED_ID, "organization identifier");
  if (orgId !== LOCAL_ORG_ID) invalid("The schedule mutation organization is outside this local workspace");
  const operationId = scopedId(input.operationId, OPERATION_ID, "operation identifier");
  const failureCode = scopedId(input.failureCode, FAILURE_CODE, "failure code");
  const db = await readyDatabase();
  const row = await findMutationRow(db, operationId);
  if (row === null || row.org_id !== orgId) {
    throw new PilotRepositoryError("NOT_FOUND", "The pending schedule operation was not found");
  }
  const mutation = await toMutation(row);
  if (mutation.status === "completed") {
    throw new PilotRepositoryError(
      "INVALID_STATE",
      "A completed schedule operation cannot be failed",
    );
  }
  if (mutation.status === "failed" && mutation.failureCode !== failureCode) {
    throw new PilotRepositoryError(
      "CONFLICT",
      "The schedule operation was already failed with a different reason",
    );
  }

  await appendAuditEvent({
    requestId: mutation.operationId,
    actorId: mutation.actorId,
    action: "fixture.schedule.failed",
    targetType: "local_fixture_schedule",
    targetId: mutation.scheduleId,
    customerId: mutation.customerId,
    outcome: "failed",
    metadata: {
      fixtureId: mutation.fixtureId,
      connectionId: mutation.connectionId,
      mutationSequence: mutation.mutationSequence,
      operationKind: mutation.operationKind,
      command: mutation.command as unknown as JsonValue,
      failureCode,
    },
  });

  const now = Date.now();
  await db.prepare(
    `UPDATE local_schedule_mutation_outbox
        SET status = 'failed', updated_at = ?, failed_at = ?, failure_code = ?
      WHERE operation_id = ? AND org_id = ? AND status = 'pending'`,
  ).bind(now, now, failureCode, mutation.operationId, mutation.orgId).run();
  const failed = await findMutationRow(db, mutation.operationId);
  if (
    failed === null ||
    failed.org_id !== mutation.orgId ||
    failed.status !== "failed" ||
    failed.failure_code !== failureCode
  ) {
    throw new PilotRepositoryError(
      "PERSISTENCE_FAILED",
      "The audited schedule operation could not be dead-lettered",
    );
  }
  return toMutation(failed);
}
