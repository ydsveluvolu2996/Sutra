/**
 * The `uptime-probe` background job: it records one health sample per platform
 * component so the public /status page can report measured status + uptime
 * history instead of a hard-coded "all operational".
 *
 * Shaped to match the existing retention-sweep / scheduled-report /
 * alert-evaluation handlers so the parent can register it with a one-line add:
 *   - buildJobHandlers():  "uptime-probe": (job) => runUptimeProbeJob(job, buildUptimeProbeDeps())
 *   - the jobs/run tick:   await ensureUptimeProbeEnqueued(queue, await listActiveOrgIds());
 *
 * The probe checks the SAME signals `/api/healthz` reflects:
 *   - database   — a `SELECT 1` liveness read
 *   - collector  — the broker `/v1/health` result (getCollectorHealth)
 *   - web app    — proven live by this code running inside the request runtime
 *   - job runner — proven live by this code running inside the job runner
 *
 * Honesty: a failed database/collector check is RECORDED as an unhealthy
 * sample, not swallowed — the probe's job is to record what it observed. The
 * job only throws (so the queue retries) when persistence itself fails; a
 * component being down is a successful probe, not a failed one.
 */
import type { RunnableJob } from "./background-job-runner.ts";
import { getCollectorHealth } from "./pilot-server.ts";
import type { UptimeSampleInput } from "./uptime-status.ts";
import { getRawDb } from "../db/index.ts";
import { ensureRuntimeSchema } from "../db/runtime-migrations.ts";
import { UptimeRepository } from "../db/uptime-repository.ts";

export const UPTIME_PROBE_JOB_KIND = "uptime-probe";

/** Injected dependencies so the probe -> record path is unit-testable. */
export interface UptimeProbeRunDeps {
  /** Liveness read against the database; true when it answered. */
  readonly probeDatabase: () => Promise<boolean>;
  /** Collector/broker health; true when the broker reported ok. */
  readonly probeCollector: () => Promise<boolean>;
  /** Persist the batch of samples for one probe run. */
  readonly record: (samples: readonly UptimeSampleInput[]) => Promise<void>;
  readonly now: () => number;
}

/** Run one probe check, converting a thrown check into an unhealthy sample. */
async function checkSample(
  component: string,
  probe: () => Promise<boolean>,
  healthyDetail: string,
  unhealthyDetail: string,
): Promise<UptimeSampleInput> {
  try {
    const healthy = await probe();
    return { component, healthy, detail: healthy ? healthyDetail : unhealthyDetail };
  } catch {
    return { component, healthy: false, detail: unhealthyDetail };
  }
}

/**
 * Probe every component and record one sample each. The web app and job runner
 * are recorded healthy because this handler executing at all proves both
 * runtimes are live — the same basis on which `/api/healthz` returning 200
 * proves the app is up. The database and collector are actively checked.
 */
export async function runUptimeProbeJob(_job: RunnableJob, deps: UptimeProbeRunDeps): Promise<void> {
  const samples: UptimeSampleInput[] = [
    { component: "web-app", healthy: true, detail: "Request runtime executed the probe." },
    { component: "job-runner", healthy: true, detail: "Background job runner executed the probe." },
    await checkSample(
      "database",
      deps.probeDatabase,
      "SELECT 1 liveness check succeeded.",
      "SELECT 1 liveness check failed.",
    ),
    await checkSample(
      "collector",
      deps.probeCollector,
      "Broker /v1/health reported ok.",
      "Broker /v1/health did not report ok.",
    ),
  ];
  // Only persistence failure is a job failure worth retrying; the probe results
  // themselves (including "down") are the successful output.
  await deps.record(samples);
}

/** The subset of the durable queue the tick depends on (structural — the real
 * JobQueueRepository satisfies it without a value import here). */
export interface UptimeProbeQueuePort {
  list(orgId: string, customerId: string | null): Promise<readonly { readonly kind: string; readonly status: string }[]>;
  enqueue(
    input: { readonly orgId: string; readonly customerId: string | null; readonly kind: string; readonly payload: unknown },
    now?: number,
  ): Promise<unknown>;
}

/**
 * The uptime-probe tick: ensure at most one in-flight `uptime-probe` job.
 * Mirrors ensureRetentionSweepsEnqueued's cadence model — a queued/leased probe
 * enqueues nothing, so a slow tick never piles up duplicate probes.
 *
 * The durable queue guards org-scoped rows against a real, active organization,
 * so the platform probe is hosted by a deterministic CARRIER org — the
 * lowest-id active org from the same `listActiveOrgIds()` the retention sweep
 * uses. The org is only a carrier for the queue row; the recorded samples carry
 * no org scope (see uptime_samples). With no active org there is nothing to
 * serve, so nothing is enqueued. Returns the number enqueued (0 or 1).
 */
export async function ensureUptimeProbeEnqueued(
  queue: UptimeProbeQueuePort,
  activeOrgIds: readonly string[],
  now = Date.now(),
): Promise<number> {
  const carrier = [...activeOrgIds].sort()[0];
  if (carrier === undefined) return 0;
  const existing = await queue.list(carrier, null);
  const active = existing.some(
    (job) => job.kind === UPTIME_PROBE_JOB_KIND && (job.status === "queued" || job.status === "leased"),
  );
  if (active) return 0;
  await queue.enqueue(
    { orgId: carrier, customerId: null, kind: UPTIME_PROBE_JOB_KIND, payload: {} },
    now,
  );
  return 1;
}

/**
 * Assemble the real, live probe dependencies. Kept here so the parent's
 * registration is a single call. The database check is a `SELECT 1` against the
 * runtime D1/Postgres handle; the collector check is the broker health used by
 * `/api/healthz`; recording goes to the durable `uptime_samples` store.
 */
export function buildUptimeProbeDeps(): UptimeProbeRunDeps {
  return {
    probeDatabase: async () => {
      const db = getRawDb();
      await ensureRuntimeSchema(db);
      const row = await db.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
      return row?.healthy === 1;
    },
    probeCollector: async () => {
      // getCollectorHealth reads the same broker signal /api/healthz uses.
      const health = await getCollectorHealth();
      return health.ok;
    },
    record: (samples) => new UptimeRepository().recordSamples(samples),
    now: Date.now,
  };
}
