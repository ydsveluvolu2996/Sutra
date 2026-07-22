/**
 * Platform uptime probing records one health sample per component so the public
 * /status page can report measured status + uptime history instead of a
 * hard-coded "all operational".
 *
 * The platform tick is deliberately SYSTEM-scoped and runs directly from the
 * token-gated internal runner. It never borrows a customer organization as a
 * queue carrier, so monitoring starts before the first tenant is onboarded.
 * The legacy durable-job handler remains able to drain an already-queued probe.
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
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
export const UPTIME_PROBE_INTERVAL_MS = 10 * MS_PER_MINUTE;
export const UPTIME_RETENTION_MS = 31 * MS_PER_DAY;

/** Injected dependencies so the probe -> record path is unit-testable. */
export interface UptimeProbeRunDeps {
  /** Liveness read against the database; true when it answered. */
  readonly probeDatabase: () => Promise<boolean>;
  /** Collector/broker health; true when the broker reported ok. */
  readonly probeCollector: () => Promise<boolean>;
  /** Persist the batch of samples for one probe run at its observed time. */
  readonly record: (
    samples: readonly UptimeSampleInput[],
    observedAtMs: number,
    idempotencySlotMs?: number,
  ) => Promise<number>;
  readonly now: () => number;
}

export interface PlatformUptimeProbeTickDeps extends UptimeProbeRunDeps {
  readonly hasCompleteProbeSlot: (slotMs: number) => Promise<boolean>;
  readonly pruneBefore: (cutoffMs: number) => Promise<number>;
}

export interface PlatformUptimeProbeTickResult {
  readonly recorded: boolean;
  readonly observedAt: string;
  readonly pruned: number;
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
async function collectUptimeSamples(deps: UptimeProbeRunDeps): Promise<UptimeSampleInput[]> {
  return [
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
}

export async function runUptimeProbeJob(_job: RunnableJob, deps: UptimeProbeRunDeps): Promise<void> {
  const observedAtMs = deps.now();
  const samples = await collectUptimeSamples(deps);
  // Only persistence failure is a job failure worth retrying; the probe results
  // themselves (including "down") are the successful output.
  await deps.record(samples, observedAtMs);
}

/**
 * Record one system-scoped probe per ten-minute UTC bucket. The repository's
 * deterministic sample ids make the write idempotent if concurrent runners
 * race after the due check. Retention is enforced whenever a bucket is written.
 */
export async function runPlatformUptimeProbeTick(
  deps: PlatformUptimeProbeTickDeps,
): Promise<PlatformUptimeProbeTickResult> {
  const now = deps.now();
  if (!Number.isFinite(now)) throw new Error("Uptime probe clock is invalid");
  const observedAt = new Date(now).toISOString();
  const slotStartMs = Math.floor(now / UPTIME_PROBE_INTERVAL_MS) * UPTIME_PROBE_INTERVAL_MS;
  if (await deps.hasCompleteProbeSlot(slotStartMs)) {
    return { recorded: false, observedAt, pruned: 0 };
  }
  const samples = await collectUptimeSamples(deps);
  const inserted = await deps.record(samples, now, slotStartMs);
  const pruned = await deps.pruneBefore(now - UPTIME_RETENTION_MS);
  return { recorded: inserted > 0, observedAt, pruned };
}

/**
 * Assemble the real, live probe dependencies. Kept here so the parent's
 * registration is a single call. The database check is a `SELECT 1` against the
 * runtime D1/Postgres handle; the collector check is the broker health used by
 * `/api/healthz`; recording goes to the durable `uptime_samples` store.
 */
export function buildUptimeProbeDeps(): UptimeProbeRunDeps {
  const repository = new UptimeRepository();
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
    record: (samples, observedAtMs, idempotencySlotMs) =>
      repository.recordSamples(samples, observedAtMs, idempotencySlotMs),
    now: Date.now,
  };
}

/** Real dependencies for the tenant-independent platform probe tick. */
export function buildPlatformUptimeProbeTickDeps(): PlatformUptimeProbeTickDeps {
  const repository = new UptimeRepository();
  const base = buildUptimeProbeDeps();
  return {
    ...base,
    record: (samples, observedAtMs, idempotencySlotMs) =>
      repository.recordSamples(samples, observedAtMs, idempotencySlotMs),
    hasCompleteProbeSlot: (slotMs) => repository.hasCompleteProbeSlot(slotMs),
    pruneBefore: (cutoffMs) => repository.pruneBefore(cutoffMs),
  };
}
