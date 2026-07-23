import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runDueBackgroundJobs,
  type JobQueuePort,
  type RunnableJob,
} from "../lib/background-job-runner.ts";

interface FakeJob {
  id: string;
  orgId: string;
  customerId: string | null;
  connectionId: string | null;
  kind: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
  status: "queued" | "leased" | "succeeded" | "dead_letter";
  readyAt: number;
}
type JobSeed = Omit<FakeJob, "status" | "readyAt">;

/**
 * In-memory queue double that mimics the real repository contract, including
 * the crucial detail that a failed job is re-queued with a future run_after
 * (backoff) so it is NOT re-leasable within the same drain.
 */
class FakeQueue implements JobQueuePort {
  public readonly jobs: FakeJob[];
  public constructor(jobs: readonly JobSeed[]) {
    this.jobs = jobs.map((job) => ({ ...job, status: "queued", readyAt: 0 }));
  }
  public leaseNext(kind: string, now = Date.now()): Promise<RunnableJob | null> {
    const job = this.jobs.find((c) => c.kind === kind && c.status === "queued" && c.readyAt <= now);
    if (job === undefined) return Promise.resolve(null);
    job.status = "leased";
    job.attempt += 1;
    return Promise.resolve({ ...job });
  }
  public complete(orgId: string, id: string): Promise<boolean> {
    const job = this.jobs.find((c) => c.id === id && c.orgId === orgId);
    if (job === undefined || job.status !== "leased") return Promise.resolve(false);
    job.status = "succeeded";
    return Promise.resolve(true);
  }
  public fail(orgId: string, id: string, _error: string, now = Date.now()): Promise<{ status: string }> {
    const job = this.jobs.find((c) => c.id === id && c.orgId === orgId);
    if (job === undefined) return Promise.resolve({ status: "dead_letter" });
    const terminal = job.attempt >= job.maxAttempts;
    job.status = terminal ? "dead_letter" : "queued";
    job.readyAt = now + 5_000; // backoff: not re-leasable this drain
    return Promise.resolve({ status: terminal ? "dead_letter" : "queued" });
  }
}

function job(id: string, kind: string, overrides: Partial<JobSeed> = {}): JobSeed {
  return { id, orgId: "org_1", customerId: null, connectionId: null, kind, payload: {}, attempt: 0, maxAttempts: 3, ...overrides };
}

const clock = () => 1_000;

describe("runDueBackgroundJobs", () => {
  it("completes jobs whose handler succeeds and tallies them honestly", async () => {
    const queue = new FakeQueue([job("job_a", "retention-sweep"), job("job_b", "retention-sweep")]);
    const seen: string[] = [];
    const result = await runDueBackgroundJobs({
      queue,
      handlers: { "retention-sweep": async (j) => { seen.push(j.id); } },
      now: clock,
    });
    assert.deepEqual(seen, ["job_a", "job_b"]);
    assert.equal(result.totalLeased, 2);
    assert.equal(result.totalSucceeded, 2);
    assert.equal(result.totalFailed, 0);
    assert.equal(result.outcomes[0].succeeded, 2);
    assert.equal(queue.jobs.every((j) => j.status === "succeeded"), true);
    assert.match(result.disclaimer, /never marked succeeded/);
  });

  it("retries a failing handler until attempts are exhausted, then dead-letters", async () => {
    const queue = new FakeQueue([job("job_x", "itsm-dispatch", { maxAttempts: 2 })]);
    const failing = { "itsm-dispatch": async () => { throw new Error("remote 503"); } };
    let t = 1_000;
    const advancing = () => t;
    const first = await runDueBackgroundJobs({ queue, handlers: failing, now: advancing });
    assert.equal(first.outcomes[0].retried, 1);
    assert.equal(first.outcomes[0].deadLettered, 0);
    assert.equal(queue.jobs[0].status, "queued");
    t = 1_000_000; // past the backoff window
    const second = await runDueBackgroundJobs({ queue, handlers: failing, now: advancing });
    assert.equal(second.outcomes[0].deadLettered, 1);
    assert.equal(queue.jobs[0].status, "dead_letter");
  });

  it("reports a leased job with no registered handler as unhandled and does not complete it", async () => {
    const queue = new FakeQueue([job("job_o", "orphan-kind")]);
    const result = await runDueBackgroundJobs({
      queue,
      handlers: {},
      kinds: ["orphan-kind"],
      now: clock,
    });
    assert.equal(result.outcomes[0].unhandled, 1);
    assert.equal(result.totalSucceeded, 0);
    assert.notEqual(queue.jobs[0].status, "succeeded");
  });

  it("counts a lost lease (complete returns false) without crediting success", async () => {
    const queue = new FakeQueue([job("job_l", "retention-sweep")]);
    // Another actor drives the job to a terminal state before the runner
    // completes it, so complete() finds no live lease and returns false.
    const result = await runDueBackgroundJobs({
      queue,
      handlers: { "retention-sweep": async (j) => { const found = queue.jobs.find((c) => c.id === j.id); if (found) found.status = "succeeded"; } },
      now: clock,
    });
    assert.equal(result.outcomes[0].lostLease, 1);
    assert.equal(result.totalSucceeded, 0);
  });

  it("honors maxPerKind so one drain cannot starve other kinds", async () => {
    const queue = new FakeQueue([
      job("job_1", "retention-sweep"), job("job_2", "retention-sweep"), job("job_3", "retention-sweep"),
    ]);
    const result = await runDueBackgroundJobs({
      queue,
      handlers: { "retention-sweep": async () => {} },
      maxPerKind: 2,
      now: clock,
    });
    assert.equal(result.outcomes[0].leased, 2);
    assert.equal(queue.jobs.filter((j) => j.status === "queued").length, 1);
  });
});
