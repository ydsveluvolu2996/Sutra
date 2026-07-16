import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DurableLocalJobQueue,
  DurableLocalScheduler,
  LocalJobIdempotencyConflictError,
  LocalJobLeaseLostError,
} from "../src/durable-job-queue.js";
import { JsonFileLocalJobStateStore } from "../src/local-job-state.js";

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

test("recurring schedules atomically catch up occurrences and persist across restart", async () => {
  await withTemporaryState(async (filePath) => {
    const clock = new TestClock("2026-07-15T13:00:00.000Z");
    const firstStore = new JsonFileLocalJobStateStore({ filePath });
    const scheduler = new DurableLocalScheduler({
      store: firstStore,
      now: clock.now,
      maxCatchUpPerSchedule: 2,
    });
    await scheduler.upsertSchedule({
      tenantId: TENANT_ID,
      scheduleId: "hourly-fixture-sync",
      kind: "fixture.inventory.collect",
      payload: { fixtureId: "northstar-retail", version: "2026.07.1" },
      everyMs: 60_000,
      firstRunAt: clock.now(),
      maxAttempts: 4,
    });

    const firstTick = await scheduler.runDueSchedules();
    assert.equal(firstTick.occurrencesProcessed, 1);
    assert.equal(firstTick.jobsCreated, 1);
    assert.equal((await scheduler.runDueSchedules()).jobsCreated, 0);

    clock.advance(180_000);
    const catchUpOne = await scheduler.runDueSchedules();
    assert.equal(catchUpOne.occurrencesProcessed, 2);
    assert.equal(catchUpOne.jobsCreated, 2);
    const catchUpTwo = await scheduler.runDueSchedules();
    assert.equal(catchUpTwo.occurrencesProcessed, 1);
    assert.equal(catchUpTwo.jobsCreated, 1);

    const restartedStore = new JsonFileLocalJobStateStore({ filePath });
    const restartedQueue = new DurableLocalJobQueue({
      store: restartedStore,
      now: clock.now,
    });
    const jobs = await restartedQueue.listJobs(TENANT_ID);
    assert.equal(jobs.length, 4);
    assert.equal(new Set(jobs.map((job) => job.jobId)).size, 4);
    assert.ok(jobs.every((job) => job.maxAttempts === 4));

    const restartedScheduler = new DurableLocalScheduler({
      store: restartedStore,
      now: clock.now,
    });
    const [persisted] = await restartedScheduler.listSchedules(TENANT_ID);
    assert.ok(persisted);
    assert.equal(persisted.nextRunAt, "2026-07-15T13:04:00.000Z");
    await restartedScheduler.setScheduleEnabled(
      TENANT_ID,
      persisted.scheduleId,
      false,
    );
    clock.advance(60_000);
    assert.equal((await restartedScheduler.runDueSchedules()).jobsCreated, 0);
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
