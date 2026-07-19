import {
  beginLocalScheduleMutation,
  completeLocalScheduleMutation,
  failLocalScheduleMutation,
  getLocalScheduleMutation,
  listPendingLocalScheduleMutations,
  type BeginLocalScheduleMutationInput,
  type LocalScheduleMutation,
} from "../db/local-schedule-outbox-repository";
import { getConnection } from "../db/pilot-repository";
import type { AuthenticatedLocalSession } from "../db/auth-repository";
import { assertSessionCapability } from "./api-auth";
import type { LocalFixtureDescriptor, LocalFixtureSchedule } from "./local-ops-types";
import {
  getLocalFixtureSchedules,
  localFixtureScheduleId,
  PilotServerError,
  setLocalFixtureScheduleEnabled,
  upsertLocalFixtureSchedule,
} from "./pilot-server";

const IDEMPOTENCY_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

class PermanentLocalScheduleMutationError extends Error {
  public readonly failureCode: string;

  public constructor(failureCode: string, message: string) {
    super(message);
    this.name = "PermanentLocalScheduleMutationError";
    this.failureCode = failureCode;
  }
}

export async function assertLocalScheduleProvisioningScope(
  authenticated: AuthenticatedLocalSession,
  fixture: LocalFixtureDescriptor,
  options: { readonly allowInactive?: boolean } = {},
): Promise<{ readonly customerId: string | null }> {
  assertSessionCapability(authenticated, "sync:run", fixture.customerId);
  assertSessionCapability(authenticated, "connection:manage", fixture.customerId);
  const connection = await getConnection(fixture.connectionId);
  if (connection === null) {
    assertSessionCapability(authenticated, "customer:create");
    return { customerId: null };
  }
  if (
    connection.customerId !== fixture.customerId ||
    connection.sourceKind !== "simulated_fixture" ||
    connection.fixtureId !== fixture.fixtureId
  ) {
    throw Object.assign(new Error("The simulated schedule conflicts with this workspace connection"), {
      code: "INVALID_STATE",
    });
  }
  if (connection.status !== "active" && options.allowInactive !== true) {
    throw Object.assign(new Error("Only an active simulated connection can run scheduled collections"), {
      code: "INVALID_STATE",
    });
  }
  return { customerId: connection.customerId };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function localScheduleOperationId(orgId: string, idempotencyKey: string): Promise<string> {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw Object.assign(new Error("A valid schedule idempotency key is required"), {
      code: "INVALID_INPUT",
    });
  }
  return `schedop_${(await sha256Hex(`local-schedule-operation\u0000${orgId}\u0000${idempotencyKey}`)).slice(0, 48)}`;
}

function fixtureForMutation(
  mutation: LocalScheduleMutation,
  fixtures: readonly LocalFixtureDescriptor[],
): LocalFixtureDescriptor {
  const fixture = fixtures.find((candidate) =>
    candidate.tenantId === mutation.orgId &&
    candidate.fixtureId === mutation.fixtureId &&
    candidate.connectionId === mutation.connectionId);
  if (fixture === undefined) {
    throw new PermanentLocalScheduleMutationError(
      "FIXTURE_NOT_FOUND",
      "The pending schedule operation escaped the signed fixture catalog",
    );
  }
  if (
    mutation.operationKind === "upsert" &&
    !fixture.availableVersions.includes(mutation.command.version)
  ) {
    throw new PermanentLocalScheduleMutationError(
      "FIXTURE_VERSION_UNAVAILABLE",
      "The pending schedule fixture version is no longer available",
    );
  }
  return fixture;
}

async function applyLocalScheduleMutation(
  mutation: LocalScheduleMutation,
  fixtures: readonly LocalFixtureDescriptor[],
): Promise<LocalFixtureSchedule> {
  const fixture = fixtureForMutation(mutation, fixtures);
  if (await localFixtureScheduleId(fixture.tenantId, fixture.fixtureId) !== mutation.scheduleId) {
    throw new PermanentLocalScheduleMutationError(
      "SCHEDULE_IDENTITY_INVALID",
      "The pending schedule identity is invalid",
    );
  }
  const connection = await getConnection(fixture.connectionId);
  if (connection !== null && (
    connection.customerId !== fixture.customerId ||
    connection.sourceKind !== "simulated_fixture" ||
    connection.fixtureId !== fixture.fixtureId
  )) {
    throw new PermanentLocalScheduleMutationError(
      "CONNECTION_SCOPE_INVALID",
      "The pending schedule connection no longer matches its fixture scope",
    );
  }
  const safelyDisablesInactiveSchedule = mutation.operationKind === "toggle" &&
    mutation.command.enabled === false;
  if (
    connection !== null &&
    connection.status !== "active" &&
    !safelyDisablesInactiveSchedule
  ) {
    throw new PermanentLocalScheduleMutationError(
      "CONNECTION_NOT_ACTIVE",
      "The pending schedule connection is no longer active",
    );
  }
  if (mutation.operationKind === "toggle") {
    const existing = (await getLocalFixtureSchedules(fixture))
      .some((schedule) => schedule.scheduleId === mutation.scheduleId);
    if (!existing) {
      throw new PermanentLocalScheduleMutationError(
        "SCHEDULE_NOT_FOUND",
        "The pending schedule no longer exists in the collector",
      );
    }
  }
  const schedule = mutation.operationKind === "upsert"
    ? await upsertLocalFixtureSchedule({
        fixture,
        scheduleId: mutation.scheduleId,
        mutationId: mutation.operationId,
        mutationSequence: mutation.mutationSequence,
        version: mutation.command.version,
        everyMs: mutation.command.everyMs,
        enabled: mutation.command.enabled,
        firstRunAt: mutation.command.firstRunAt,
      })
    : await setLocalFixtureScheduleEnabled({
        fixture,
        scheduleId: mutation.scheduleId,
        mutationId: mutation.operationId,
        mutationSequence: mutation.mutationSequence,
        enabled: mutation.command.enabled,
      });
  await completeLocalScheduleMutation({
    orgId: mutation.orgId,
    operationId: mutation.operationId,
  });
  return schedule;
}

function scheduleMatchesMutationCommand(
  schedule: LocalFixtureSchedule,
  mutation: LocalScheduleMutation,
): boolean {
  return mutation.operationKind === "upsert"
    ? schedule.version === mutation.command.version &&
        schedule.everyMs === mutation.command.everyMs &&
        schedule.enabled === mutation.command.enabled
    : schedule.enabled === mutation.command.enabled;
}

function requireMatchingCompletedSchedule(
  schedule: LocalFixtureSchedule | undefined,
  mutation: LocalScheduleMutation,
): LocalFixtureSchedule {
  if (schedule === undefined) {
    throw Object.assign(new Error("The completed schedule operation has no collector state"), {
      code: "INVALID_STATE",
    });
  }
  if (!scheduleMatchesMutationCommand(schedule, mutation)) {
    throw Object.assign(new Error("The completed schedule operation was superseded by a newer change"), {
      code: "CONFLICT",
    });
  }
  return schedule;
}

let mutationReconciliationTail: Promise<ReadonlyMap<string, LocalFixtureSchedule>> =
  Promise.resolve(new Map());

/**
 * Replays pending commands in durable sequence order. Collector mutation IDs
 * make exact replay idempotent, while the sequence prevents a delayed older
 * command from overwriting newer state in another process.
 */
export function reconcileLocalScheduleMutations(
  fixtures: readonly LocalFixtureDescriptor[],
): Promise<ReadonlyMap<string, LocalFixtureSchedule>> {
  const task = mutationReconciliationTail
    .catch(() => new Map<string, LocalFixtureSchedule>())
    .then(async () => {
      const applied = new Map<string, LocalFixtureSchedule>();
      for (;;) {
        const pending = await listPendingLocalScheduleMutations({
          orgId: fixtures[0]?.tenantId ?? "org_local_sutra",
          limit: 100,
        });
        if (pending.length === 0) return applied;
        for (const mutation of pending) {
          try {
            applied.set(mutation.operationId, await applyLocalScheduleMutation(mutation, fixtures));
          } catch (error) {
            const failureCode = error instanceof PermanentLocalScheduleMutationError
              ? error.failureCode
              : error instanceof PilotServerError && error.code === "SCHEDULE_NOT_FOUND"
                ? "SCHEDULE_NOT_FOUND"
                : error instanceof PilotServerError && error.code === "STALE_SCHEDULE_MUTATION"
                  ? "SUPERSEDED_BY_NEWER_MUTATION"
                : null;
            if (failureCode === null) throw error;
            const current = await getLocalScheduleMutation(
              mutation.orgId,
              mutation.operationId,
            );
            if (current?.status !== "pending") continue;
            await failLocalScheduleMutation({
              orgId: mutation.orgId,
              operationId: mutation.operationId,
              failureCode,
            });
          }
        }
        if (pending.length < 100) return applied;
      }
    });
  mutationReconciliationTail = task;
  return task;
}

async function persistAndApplyLocalScheduleMutationSerialized(
  input: BeginLocalScheduleMutationInput,
  fixtures: readonly LocalFixtureDescriptor[],
): Promise<LocalFixtureSchedule> {
  const mutation = await beginLocalScheduleMutation(input);
  if (mutation.status === "failed") {
    throw Object.assign(new Error("The schedule operation was permanently rejected"), {
      code: "INVALID_STATE",
    });
  }
  if (mutation.status === "completed") {
    const fixture = fixtureForMutation(mutation, fixtures);
    const current = (await getLocalFixtureSchedules(fixture))
      .find((schedule) => schedule.scheduleId === mutation.scheduleId);
    return requireMatchingCompletedSchedule(current, mutation);
  }
  const applied = await reconcileLocalScheduleMutations(fixtures);
  const schedule = applied.get(mutation.operationId);
  if (schedule === undefined) {
    const terminal = await getLocalScheduleMutation(mutation.orgId, mutation.operationId);
    if (terminal?.status === "failed") {
      throw Object.assign(new Error("The schedule operation could not be applied safely"), {
        code: "INVALID_STATE",
      });
    }
    if (terminal?.status === "completed") {
      const fixture = fixtureForMutation(terminal, fixtures);
      const current = (await getLocalFixtureSchedules(fixture))
        .find((candidate) => candidate.scheduleId === terminal.scheduleId);
      return requireMatchingCompletedSchedule(current, terminal);
    }
    throw Object.assign(new Error("The durable schedule operation did not complete"), {
      code: "PERSISTENCE_FAILED",
    });
  }
  return schedule;
}

let mutationSubmissionTail: Promise<void> = Promise.resolve();

export function persistAndApplyLocalScheduleMutation(
  input: BeginLocalScheduleMutationInput,
  fixtures: readonly LocalFixtureDescriptor[],
): Promise<LocalFixtureSchedule> {
  const task = mutationSubmissionTail
    .catch(() => undefined)
    .then(() => persistAndApplyLocalScheduleMutationSerialized(input, fixtures));
  mutationSubmissionTail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}
