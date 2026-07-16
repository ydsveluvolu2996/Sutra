import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DurableLocalJobQueue,
  DurableLocalScheduler,
  LocalJobIdempotencyConflictError,
  LocalJobLeaseLostError,
  LocalScheduleStaleMutationError,
} from "../src/durable-job-queue.js";
import {
  JsonFileLocalJobStateStore,
  LocalJobStateCapacityError,
} from "../src/local-job-state.js";

const TENANT_ID = "org_local_sutra";

test("file queue survives restart and enforces durable idempotency", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T10:00:00.000Z");
    const firstStore = new JsonFileLocalJobStateStore({ filePath });
    const firstQueue = new DurableLocalJobQueue({ store: firstStore, now: clock.now });
    const first = await firstQueue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "northstar:2026.07.0",
      payload: { fixtureId: "northstar-retail", version: "2026.07.0" },
      maxAttempts: 3,
    });
    assert.equal(first.created, true);
    assert.equal(first.job.status, "pending");

    const duplicate = await firstQueue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "northstar:2026.07.0",
      payload: { version: "2026.07.0", fixtureId: "northstar-retail" },
      maxAttempts: 3,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.jobId, first.job.jobId);

    await assert.rejects(
      firstQueue.enqueue({
        tenantId: TENANT_ID,
        kind: "fixture.inventory.collect",
        idempotencyKey: "northstar:2026.07.0",
        payload: { fixtureId: "bluepeak-finance", version: "2026.07.0" },
        maxAttempts: 3,
      }),
      LocalJobIdempotencyConflictError,
    );

    const restartedStore = new JsonFileLocalJobStateStore({ filePath });
    const restartedQueue = new DurableLocalJobQueue({
      store: restartedStore,
      now: clock.now,
    });
    assert.deepEqual(
      await restartedQueue.getJob(TENANT_ID, first.job.jobId),
      first.job,
    );
    assert.equal(await restartedQueue.getJob("org_other", first.job.jobId), null);

    const metadata = await lstat(filePath);
    assert.equal(metadata.mode & 0o777, 0o600);
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      readonly version: number;
    };
    assert.equal(raw.version, 1);
  });
});

test("leases, exponential retry, terminal failure, and settlement are enforced", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T11:00:00.000Z");
    const tokens = tokenFactory();
    const queue = new DurableLocalJobQueue({
      store: new JsonFileLocalJobStateStore({ filePath }),
      now: clock.now,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      leaseTokenFactory: tokens.next,
    });
    const enqueued = await queue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "retry-job",
      payload: { fixtureId: "northstar-retail" },
      maxAttempts: 3,
    });

    const firstLease = await queue.leaseNext({ workerId: "worker_a", leaseMs: 5_000 });
    assert.ok(firstLease?.lease);
    assert.equal(firstLease.jobId, enqueued.job.jobId);
    assert.equal(firstLease.attempts, 1);
    assert.equal(
      await queue.leaseNext({ workerId: "worker_b", leaseMs: 5_000 }),
      null,
    );
    const firstFailure = await queue.fail({
      tenantId: TENANT_ID,
      jobId: firstLease.jobId,
      leaseToken: firstLease.lease.token,
      code: "TRANSIENT",
      message: "temporary local failure",
    });
    assert.equal(firstFailure.status, "pending");
    assert.equal(
      Date.parse(firstFailure.availableAt) - clock.milliseconds,
      1_000,
    );
    assert.deepEqual(
      await queue.fail({
        tenantId: TENANT_ID,
        jobId: firstLease.jobId,
        leaseToken: firstLease.lease.token,
        code: "TRANSIENT",
        message: "temporary local failure",
      }),
      firstFailure,
    );
    assert.equal(await queue.leaseNext({ workerId: "worker_a", leaseMs: 5_000 }), null);

    clock.advance(1_000);
    const secondLease = await queue.leaseNext({ workerId: "worker_a", leaseMs: 5_000 });
    assert.ok(secondLease?.lease);
    assert.equal(secondLease.attempts, 2);
    const secondFailure = await queue.fail({
      tenantId: TENANT_ID,
      jobId: secondLease.jobId,
      leaseToken: secondLease.lease.token,
      code: "TRANSIENT",
      message: "temporary local failure",
    });
    assert.equal(Date.parse(secondFailure.availableAt) - clock.milliseconds, 2_000);

    clock.advance(1_999);
    assert.equal(await queue.leaseNext({ workerId: "worker_a", leaseMs: 5_000 }), null);
    clock.advance(1);
    const thirdLease = await queue.leaseNext({ workerId: "worker_a", leaseMs: 5_000 });
    assert.ok(thirdLease?.lease);
    assert.equal(thirdLease.attempts, 3);
    const terminal = await queue.fail({
      tenantId: TENANT_ID,
      jobId: thirdLease.jobId,
      leaseToken: thirdLease.lease.token,
      code: "TRANSIENT",
      message: "retry budget exhausted",
    });
    assert.equal(terminal.status, "dead_letter");
    assert.equal(terminal.completedAt, clock.now().toISOString());

    const completedEnqueue = await queue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "successful-job",
      payload: { fixtureId: "meridian-health" },
    });
    const successLease = await queue.leaseNext({ workerId: "worker_b", leaseMs: 5_000 });
    assert.ok(successLease?.lease);
    assert.equal(successLease.jobId, completedEnqueue.job.jobId);
    const completed = await queue.complete({
      tenantId: TENANT_ID,
      jobId: successLease.jobId,
      leaseToken: successLease.lease.token,
      result: { resourcesObserved: 13, coverage: "complete" },
    });
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.result, { coverage: "complete", resourcesObserved: 13 });
    assert.deepEqual(
      await queue.complete({
        tenantId: TENANT_ID,
        jobId: successLease.jobId,
        leaseToken: successLease.lease.token,
        result: { ignoredOnIdempotentReplay: true },
      }),
      completed,
    );
  });
});

test("expired leases are recovered with backoff and stale tokens cannot settle", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T12:00:00.000Z");
    const queue = new DurableLocalJobQueue({
      store: new JsonFileLocalJobStateStore({ filePath }),
      now: clock.now,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      leaseTokenFactory: tokenFactory().next,
    });
    const enqueued = await queue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "lease-recovery",
      payload: { fixtureId: "bluepeak-finance" },
      maxAttempts: 2,
    });
    const abandoned = await queue.leaseNext({ workerId: "worker_crashed", leaseMs: 1_000 });
    assert.ok(abandoned?.lease);
    clock.advance(1_000);

    assert.equal(await queue.recoverExpiredLeases(), 1);
    const recovered = await queue.getJob(TENANT_ID, enqueued.job.jobId);
    assert.equal(recovered?.status, "pending");
    assert.equal(recovered?.lastFailure?.code, "LEASE_EXPIRED");
    await assert.rejects(
      queue.complete({
        tenantId: TENANT_ID,
        jobId: abandoned.jobId,
        leaseToken: abandoned.lease.token,
      }),
      LocalJobLeaseLostError,
    );
    assert.equal(await queue.leaseNext({ workerId: "worker_new", leaseMs: 1_000 }), null);
    clock.advance(100);
    const reclaimed = await queue.leaseNext({ workerId: "worker_new", leaseMs: 1_000 });
    assert.ok(reclaimed?.lease);
    assert.equal(reclaimed.attempts, 2);
  });
});

test("recurring schedules atomically bound stale catch-up and persist across restart", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T13:00:00.000Z");
    const firstStore = new JsonFileLocalJobStateStore({ filePath });
    const scheduler = new DurableLocalScheduler({
      store: firstStore,
      now: clock.now,
      maxCatchUpPerSchedule: 2,
    });
    const configured = await scheduler.upsertSchedule({
      tenantId: TENANT_ID,
      scheduleId: "hourly-fixture-sync",
      mutationId: `schedop_${"a".repeat(48)}`,
      mutationSequence: 1,
      kind: "fixture.inventory.collect",
      payload: { fixtureId: "northstar-retail", version: "2026.07.1" },
      everyMs: 60_000,
      firstRunAt: clock.now(),
      maxAttempts: 4,
    });
    assert.deepEqual(await scheduler.upsertSchedule({
      tenantId: TENANT_ID,
      scheduleId: "hourly-fixture-sync",
      mutationId: `schedop_${"a".repeat(48)}`,
      mutationSequence: 1,
      kind: "fixture.inventory.collect",
      payload: { version: "2026.07.1", fixtureId: "northstar-retail" },
      everyMs: 60_000,
      firstRunAt: clock.now(),
      maxAttempts: 4,
    }), configured);
    await assert.rejects(
      scheduler.upsertSchedule({
        tenantId: TENANT_ID,
        scheduleId: "hourly-fixture-sync",
        mutationId: `schedop_${"a".repeat(48)}`,
        mutationSequence: 1,
        kind: "fixture.inventory.collect",
        payload: { fixtureId: "northstar-retail", version: "2026.07.1" },
        everyMs: 120_000,
        firstRunAt: clock.now(),
        maxAttempts: 4,
      }),
      LocalJobIdempotencyConflictError,
    );

    const firstTick = await scheduler.runDueSchedules();
    assert.equal(firstTick.occurrencesProcessed, 1);
    assert.equal(firstTick.occurrencesSkipped, 0);
    assert.equal(firstTick.jobsCreated, 1);
    assert.equal((await scheduler.runDueSchedules()).jobsCreated, 0);

    clock.advance(180_000);
    const catchUp = await scheduler.runDueSchedules();
    assert.equal(catchUp.occurrencesProcessed, 2);
    assert.equal(catchUp.occurrencesSkipped, 1);
    assert.equal(catchUp.jobsCreated, 2);
    assert.equal((await scheduler.runDueSchedules()).jobsCreated, 0);

    const restartedStore = new JsonFileLocalJobStateStore({ filePath });
    const restartedQueue = new DurableLocalJobQueue({
      store: restartedStore,
      now: clock.now,
    });
    const jobs = await restartedQueue.listJobs(TENANT_ID);
    assert.equal(jobs.length, 3);
    assert.equal(new Set(jobs.map((job) => job.jobId)).size, 3);
    assert.ok(jobs.every((job) => job.maxAttempts === 4));

    const restartedScheduler = new DurableLocalScheduler({
      store: restartedStore,
      now: clock.now,
    });
    const [persisted] = await restartedScheduler.listSchedules(TENANT_ID);
    assert.ok(persisted);
    assert.equal(persisted.nextRunAt, "2026-07-15T13:04:00.000Z");
    assert.equal(persisted.missedOccurrences, 1);
    assert.equal(persisted.lastMissedAt, "2026-07-15T13:03:00.000Z");
    await restartedScheduler.setScheduleEnabled(
      TENANT_ID,
      persisted.scheduleId,
      false,
      `schedop_${"b".repeat(48)}`,
      2,
    );
    await assert.rejects(
      restartedScheduler.setScheduleEnabled(
        TENANT_ID,
        persisted.scheduleId,
        true,
        `schedop_${"e".repeat(48)}`,
        1,
      ),
      LocalScheduleStaleMutationError,
    );
    assert.equal((await restartedScheduler.listSchedules(TENANT_ID))[0]?.enabled, false);
    clock.advance(60_000);
    assert.equal((await restartedScheduler.runDueSchedules()).jobsCreated, 0);
  });
});

test("schedule capacity advances safely without blocking existing queue work", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T13:30:00.000Z");
    const store = new JsonFileLocalJobStateStore({ filePath });
    const scheduler = new DurableLocalScheduler({
      store,
      now: clock.now,
      maxCatchUpPerSchedule: 5,
      maxJobs: 1,
    });
    await scheduler.upsertSchedule({
      tenantId: TENANT_ID,
      scheduleId: "capacity-fixture-sync",
      mutationId: `schedop_${"c".repeat(48)}`,
      mutationSequence: 1,
      kind: "fixture.inventory.collect",
      payload: { fixtureId: "northstar-retail", version: "2026.07.1" },
      everyMs: 60_000,
      firstRunAt: clock.now(),
    });
    assert.equal((await scheduler.runDueSchedules()).jobsCreated, 1);

    clock.advance(180_000);
    const bounded = await scheduler.runDueSchedules();
    assert.equal(bounded.jobsCreated, 0);
    assert.equal(bounded.occurrencesProcessed, 3);
    assert.equal(bounded.occurrencesSkipped, 3);
    const [degraded] = await scheduler.listSchedules(TENANT_ID);
    assert.equal(degraded?.capacitySkippedOccurrences, 3);
    assert.equal(degraded?.capacityBlockedAt, clock.now().toISOString());
    assert.equal((await scheduler.runDueSchedules()).occurrencesProcessed, 0);

    const queue = new DurableLocalJobQueue({ store, now: clock.now });
    assert.equal((await queue.listJobs(TENANT_ID)).length, 1);
  });
});

test("manual terminal evidence also uses bounded retention", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T13:55:00.000Z");
    const store = new JsonFileLocalJobStateStore({ filePath });
    const queue = new DurableLocalJobQueue({
      store,
      now: clock.now,
      leaseTokenFactory: tokenFactory().next,
    });
    const scheduler = new DurableLocalScheduler({
      store,
      now: clock.now,
      maxRetainedTerminalManualJobs: 1,
    });
    const completedJobIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await queue.enqueue({
        tenantId: TENANT_ID,
        kind: "fixture.inventory.collect",
        idempotencyKey: `manual-retention-${index}`,
        payload: { fixtureId: "northstar-retail", version: "2026.07.1" },
      });
      const leased = await queue.leaseNext({ workerId: "manual_retention_worker", leaseMs: 5_000 });
      assert.ok(leased?.lease);
      completedJobIds.push(leased.jobId);
      await queue.complete({
        tenantId: TENANT_ID,
        jobId: leased.jobId,
        leaseToken: leased.lease.token,
        result: { completed: true },
      });
      await queue.acknowledgePublished({
        tenantId: TENANT_ID,
        jobId: leased.jobId,
        publicationId: `snapshot_manual_${index}`,
        publishedAt: clock.now(),
      });
      clock.advance(1_000);
    }
    await scheduler.runDueSchedules();
    const retained = await queue.listJobs(TENANT_ID);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.jobId, completedJobIds[1]);
  });
});

test("scheduled terminal evidence uses bounded retention while queue work continues", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T13:45:00.000Z");
    const store = new JsonFileLocalJobStateStore({ filePath });
    const scheduler = new DurableLocalScheduler({
      store,
      now: clock.now,
      maxRetainedTerminalScheduleJobs: 1,
    });
    const queue = new DurableLocalJobQueue({
      store,
      now: clock.now,
      leaseTokenFactory: tokenFactory().next,
    });
    await scheduler.upsertSchedule({
      tenantId: TENANT_ID,
      scheduleId: "retained-fixture-sync",
      mutationId: `schedop_${"d".repeat(48)}`,
      mutationSequence: 1,
      kind: "fixture.inventory.collect",
      payload: { fixtureId: "northstar-retail", version: "2026.07.1" },
      everyMs: 60_000,
      firstRunAt: clock.now(),
    });

    const completedJobIds: string[] = [];
    for (let occurrence = 0; occurrence < 2; occurrence += 1) {
      await scheduler.runDueSchedules();
      const leased = await queue.leaseNext({ workerId: "retention_worker", leaseMs: 5_000 });
      assert.ok(leased?.lease);
      completedJobIds.push(leased.jobId);
      await queue.complete({
        tenantId: TENANT_ID,
        jobId: leased.jobId,
        leaseToken: leased.lease.token,
        result: { completed: true },
      });
      await queue.acknowledgePublished({
        tenantId: TENANT_ID,
        jobId: leased.jobId,
        publicationId: `snapshot_scheduled_${occurrence}`,
        publishedAt: clock.now(),
      });
      clock.advance(60_000);
    }

    const next = await scheduler.runDueSchedules();
    assert.equal(next.jobsCreated, 1);
    const retained = await queue.listJobs(TENANT_ID);
    assert.equal(retained.length, 2);
    assert.equal(retained.some((job) => job.jobId === completedJobIds[0]), false);
    assert.equal(retained.some((job) => job.jobId === completedJobIds[1]), true);
  });
});

test("file state prunes oldest terminal evidence before crossing its byte boundary", async () => {
  await withTemporaryState(async (filePath) => {
    const stateFileLimitBytes = 24_000;
    const clock = new TestClock("2026-07-15T13:58:00.000Z");
    const store = new JsonFileLocalJobStateStore({ filePath, stateFileLimitBytes });
    const queue = new DurableLocalJobQueue({
      store,
      now: clock.now,
      leaseTokenFactory: tokenFactory().next,
    });
    const completedJobIds: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      await queue.enqueue({
        tenantId: TENANT_ID,
        kind: "fixture.inventory.collect",
        idempotencyKey: `byte-retention-${index}`,
        payload: { fixtureId: "northstar-retail", version: "2026.07.1" },
      });
      const leased = await queue.leaseNext({ workerId: "byte_retention_worker", leaseMs: 5_000 });
      assert.ok(leased?.lease);
      const completed = await queue.complete({
        tenantId: TENANT_ID,
        jobId: leased.jobId,
        leaseToken: leased.lease.token,
        result: { evidence: "界".repeat(2_400), sequence: index },
      });
      await queue.acknowledgePublished({
        tenantId: TENANT_ID,
        jobId: completed.jobId,
        publicationId: `snapshot_byte_${index}`,
        publishedAt: clock.now(),
      });
      completedJobIds.push(completed.jobId);
      assert.equal((await queue.getJob(TENANT_ID, completed.jobId))?.jobId, completed.jobId);
      clock.advance(1_000);
    }

    const retained = await queue.listJobs(TENANT_ID);
    assert.ok(retained.length < completedJobIds.length);
    assert.equal(retained.some((job) => job.jobId === completedJobIds[0]), false);
    assert.equal(retained.some((job) => job.jobId === completedJobIds.at(-1)), true);
    assert.ok((await lstat(filePath)).size <= stateFileLimitBytes);
    assert.deepEqual(
      await new JsonFileLocalJobStateStore({ filePath, stateFileLimitBytes }).read(),
      await store.read(),
    );
  });
});

test("oversized active state is refused without replacing the last valid file", async () => {
  await withTemporaryState(async (filePath) => {
    const stateFileLimitBytes = 8_000;
    const store = new JsonFileLocalJobStateStore({ filePath, stateFileLimitBytes });
    const queue = new DurableLocalJobQueue({ store });
    await queue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "last-valid-state",
      payload: { fixtureId: "northstar-retail" },
    });
    const lastValidState = await readFile(filePath, "utf8");

    await assert.rejects(
      queue.enqueue({
        tenantId: TENANT_ID,
        kind: "fixture.inventory.collect",
        idempotencyKey: "oversized-active-state",
        payload: { fixtureId: "northstar-retail", evidence: "x".repeat(12_000) },
      }),
      LocalJobStateCapacityError,
    );

    assert.equal(await readFile(filePath, "utf8"), lastValidState);
    await queue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "write-after-capacity-rejection",
      payload: { fixtureId: "bluepeak-finance" },
    });
    const restartedQueue = new DurableLocalJobQueue({
      store: new JsonFileLocalJobStateStore({ filePath, stateFileLimitBytes }),
    });
    const jobs = await restartedQueue.listJobs(TENANT_ID);
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      jobs.map((job) => job.idempotencyKey).sort(),
      ["last-valid-state", "write-after-capacity-rejection"],
    );
  });
});

test("a queue saturated at the admission target can still lease, publish, and recover", async () => {
  await withTemporaryState(async (filePath) => {
    const stateFileLimitBytes = 8_000;
    const store = new JsonFileLocalJobStateStore({ filePath, stateFileLimitBytes });
    const queue = new DurableLocalJobQueue({
      store,
      leaseTokenFactory: tokenFactory().next,
    });
    let accepted = 0;
    for (let index = 0; index < 100; index += 1) {
      try {
        await queue.enqueue({
          tenantId: TENANT_ID,
          kind: "fixture.inventory.collect",
          idempotencyKey: `saturated-pending-${index}`,
          payload: { evidence: "x".repeat(80), fixtureId: "northstar-retail" },
        });
        accepted += 1;
      } catch (error) {
        assert.ok(error instanceof LocalJobStateCapacityError);
        break;
      }
    }
    assert.ok(accepted > 1 && accepted < 100);
    assert.ok((await lstat(filePath)).size <= Math.floor(stateFileLimitBytes * 0.9));

    const leased = await queue.leaseNext({ workerId: "saturated_queue_worker", leaseMs: 5_000 });
    assert.ok(leased?.lease);
    assert.ok((await lstat(filePath)).size <= stateFileLimitBytes);
    const completed = await queue.complete({
      tenantId: TENANT_ID,
      jobId: leased.jobId,
      leaseToken: leased.lease.token,
      result: { drained: true },
    });
    await queue.acknowledgePublished({
      tenantId: TENANT_ID,
      jobId: completed.jobId,
      publicationId: "snapshot_capacity_drain",
      publishedAt: new Date(),
    });
    await queue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "admitted-after-drain",
      payload: { fixtureId: "bluepeak-finance" },
    });
    assert.ok((await queue.listJobs(TENANT_ID)).some(
      (job) => job.idempotencyKey === "admitted-after-drain",
    ));
  });
});

test("idempotent terminal replay does not compact its legacy receipt away", async () => {
  await withTemporaryState(async (filePath) => {
    const stateFileLimitBytes = 12_000;
    const store = new JsonFileLocalJobStateStore({ filePath, stateFileLimitBytes });
    const queue = new DurableLocalJobQueue({
      store,
      leaseTokenFactory: tokenFactory().next,
    });
    const enqueued = await queue.enqueue({
      tenantId: TENANT_ID,
      kind: "fixture.inventory.collect",
      idempotencyKey: "legacy-terminal-replay",
      payload: { fixtureId: "northstar-retail" },
    });
    const leased = await queue.leaseNext({ workerId: "legacy_replay_worker", leaseMs: 5_000 });
    assert.ok(leased?.lease);
    const completed = await queue.complete({
      tenantId: TENANT_ID,
      jobId: enqueued.job.jobId,
      leaseToken: leased.lease.token,
      result: { completed: true },
    });

    const validState = await readFile(filePath, "utf8");
    const legacySize = Math.floor(stateFileLimitBytes * 0.95);
    assert.ok(Buffer.byteLength(validState, "utf8") < legacySize);
    await writeFile(
      filePath,
      validState + " ".repeat(legacySize - Buffer.byteLength(validState, "utf8")),
      "utf8",
    );

    assert.deepEqual(
      await queue.complete({
        tenantId: TENANT_ID,
        jobId: completed.jobId,
        leaseToken: leased.lease.token,
        result: { ignoredOnIdempotentReplay: true },
      }),
      completed,
    );
    assert.equal((await lstat(filePath)).size, legacySize);
    assert.equal((await queue.getJob(TENANT_ID, completed.jobId))?.jobId, completed.jobId);
  });
});

test("two file-store instances serialize concurrent writers without losing jobs", async () => {
  await withTemporaryState(async (filePath) => {
    const now = () => new Date("2026-07-15T14:00:00.000Z");
    const first = new DurableLocalJobQueue({
      store: new JsonFileLocalJobStateStore({ filePath }),
      now,
    });
    const second = new DurableLocalJobQueue({
      store: new JsonFileLocalJobStateStore({ filePath }),
      now,
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).enqueue({
          tenantId: TENANT_ID,
          kind: "fixture.inventory.collect",
          idempotencyKey: `concurrent-${index}`,
          payload: { index },
        }),
      ),
    );
    assert.equal((await first.listJobs(TENANT_ID)).length, 20);
  });
});

class TestClock {
  public milliseconds: number;

  public constructor(timestamp: string) {
    this.milliseconds = Date.parse(timestamp);
  }

  public readonly now = (): Date => new Date(this.milliseconds);

  public advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

function tokenFactory(): { readonly next: () => string } {
  let sequence = 0;
  return {
    next: () => `lease-token-${String(++sequence).padStart(32, "0")}`,
  };
}

async function withTemporaryState(
  operation: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sutra-local-jobs-"));
  try {
    await operation(join(directory, "jobs.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
