/**
 * Pure orchestration for draining the durable `background_jobs` queue.
 *
 * This module owns the job lifecycle (lease -> run handler -> complete/fail)
 * but performs no I/O itself: the queue and the per-kind handlers are injected.
 * That keeps it deterministic and unit-testable, and lets the same logic run
 * inside the app runtime (where the real repository has Postgres/D1 access)
 * while tests drive it with an in-memory queue.
 *
 * Honesty rules:
 * - The result is an exact tally of what happened this drain — leased,
 *   succeeded, retried, dead-lettered, and jobs with no registered handler.
 *   Nothing is inferred; a kind with no handler is reported, never guessed.
 * - A handler that throws is a failure: the queue's own backoff/dead-letter
 *   policy decides whether it is retried or terminal. The runner never
 *   silently drops a job.
 */

export interface RunnableJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export type FailureOutcome = "queued" | "dead_letter";

/**
 * The subset of the durable queue the runner depends on. The real
 * `JobQueueRepository` satisfies this; tests provide an in-memory double.
 */
export interface JobQueuePort {
  /** Lease the oldest ready job of a kind across all tenants, or null. */
  leaseNext(kind: string, now?: number): Promise<RunnableJob | null>;
  /** Mark a leased job succeeded. Returns false if the lease was lost. */
  complete(orgId: string, id: string, now?: number): Promise<boolean>;
  /** Record a failure; the queue decides retry-vs-dead-letter. */
  fail(orgId: string, id: string, error: string, now?: number): Promise<{ readonly status: string }>;
}

/** A handler does the work for one job and throws to signal failure. */
export type JobHandler = (job: RunnableJob) => Promise<void>;

export interface JobKindOutcome {
  readonly kind: string;
  readonly leased: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly deadLettered: number;
  /** Jobs leased for a kind with no registered handler (released to retry). */
  readonly unhandled: number;
  readonly lostLease: number;
}

export interface RunDueResult {
  readonly ranAt: string;
  readonly outcomes: readonly JobKindOutcome[];
  readonly totalLeased: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
  readonly disclaimer: string;
}

export const JOB_RUNNER_DISCLAIMER =
  "Counts reflect exactly the jobs this drain leased and their terminal outcome. " +
  "A kind with no registered handler is reported as unhandled and left queued for a " +
  "future drain — it is never marked succeeded.";

const MAX_ERROR_LENGTH = 2_000;

function messageOf(caught: unknown): string {
  if (caught instanceof Error && caught.message.length > 0) return caught.message.slice(0, MAX_ERROR_LENGTH);
  return "job-handler-failed";
}

/**
 * Drain due jobs for the given kinds. For each kind the runner leases up to
 * `maxPerKind` ready jobs and runs its handler, recording the outcome. It stops
 * a kind as soon as the queue reports no more ready work. Deterministic given
 * the injected queue, handlers, and clock.
 */
export async function runDueBackgroundJobs(input: {
  readonly queue: JobQueuePort;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly kinds?: readonly string[];
  readonly maxPerKind?: number;
  readonly now?: () => number;
}): Promise<RunDueResult> {
  const now = input.now ?? Date.now;
  const kinds = input.kinds ?? Object.keys(input.handlers);
  const maxPerKind = input.maxPerKind ?? 25;
  const outcomes: JobKindOutcome[] = [];
  for (const kind of kinds) {
    let leased = 0;
    let succeeded = 0;
    let retried = 0;
    let deadLettered = 0;
    let unhandled = 0;
    let lostLease = 0;
    for (let processed = 0; processed < maxPerKind; processed += 1) {
      const job = await input.queue.leaseNext(kind, now());
      if (job === null) break;
      leased += 1;
      const handler = input.handlers[kind];
      if (handler === undefined) {
        // Leased with no handler (kind requested but not registered): release
        // it back through the failure path so it is retried, not lost.
        unhandled += 1;
        const outcome = await input.queue.fail(job.orgId, job.id, "no-registered-handler", now());
        if (outcome.status === "dead_letter") deadLettered += 1; else retried += 1;
        continue;
      }
      try {
        await handler(job);
        const completed = await input.queue.complete(job.orgId, job.id, now());
        if (completed) succeeded += 1; else lostLease += 1;
      } catch (caught) {
        const outcome = await input.queue.fail(job.orgId, job.id, messageOf(caught), now());
        if (outcome.status === "dead_letter") deadLettered += 1; else retried += 1;
      }
    }
    outcomes.push({ kind, leased, succeeded, retried, deadLettered, unhandled, lostLease });
  }
  const totalLeased = outcomes.reduce((sum, o) => sum + o.leased, 0);
  const totalSucceeded = outcomes.reduce((sum, o) => sum + o.succeeded, 0);
  return {
    ranAt: new Date(now()).toISOString(),
    outcomes,
    totalLeased,
    totalSucceeded,
    totalFailed: totalLeased - totalSucceeded,
    disclaimer: JOB_RUNNER_DISCLAIMER,
  };
}
