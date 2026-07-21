/**
 * Pure derivation of platform status + uptime history for the public /status
 * page. This module performs no I/O: it is handed the recorded probe samples
 * (from `uptime_samples`) plus, optionally, the results of a live probe run at
 * read time, and it computes each component's current status and its uptime %
 * over rolling windows.
 *
 * EVIDENCE HONESTY — the whole point of this engine:
 * - A component with no sample within a window has uptime `null` ("unknown"),
 *   never 0 % and never 100 %. Every window discloses the sample count and the
 *   window start it was computed from.
 * - Current status is "unknown" when there is no sample at all, and also when
 *   the most recent sample is older than the freshness window (we cannot vouch
 *   for a component we have not observed recently — that is disclosed as stale).
 * - "operational" is only ever reported for a component whose latest sample is
 *   fresh AND healthy. A recent failure that has since recovered is "degraded",
 *   not silently hidden.
 * - The overall banner is the honest worst case: it is "operational" only when
 *   every component is operational; a single "unknown" keeps the banner from
 *   claiming all-clear.
 */

export type ComponentStatus = "operational" | "degraded" | "down" | "unknown";

export interface UptimeComponent {
  /** Stable machine key persisted in `uptime_samples.component`. */
  readonly key: string;
  /** Human label shown on the status page. */
  readonly name: string;
  /** One-line description of what the component is. */
  readonly detail: string;
}

/**
 * The platform components the /status page reports — exactly the signals the
 * `/api/healthz` liveness probe reflects (database + collector), plus the two
 * runtimes whose liveness is proven by the probe executing at all (the web app
 * that serves requests and the background job runner that runs the probe).
 */
export const UPTIME_COMPONENTS: readonly UptimeComponent[] = [
  { key: "web-app", name: "Application", detail: "Web control plane, dashboards and public API" },
  { key: "database", name: "Database", detail: "Evidence store and query layer" },
  { key: "job-runner", name: "Background jobs", detail: "Durable background job runner" },
  { key: "collector", name: "Collector", detail: "Agentless AWS + EKS collection plane" },
] as const;

export const UPTIME_COMPONENT_KEYS: readonly string[] = UPTIME_COMPONENTS.map((component) => component.key);

/** One recorded (or freshly probed) observation of a single component. */
export interface UptimeSample {
  readonly component: string;
  /** ISO-8601 UTC timestamp of the observation. */
  readonly observedAt: string;
  readonly healthy: boolean;
  readonly detail: string | null;
}

/** The minimal shape a probe emits before persistence assigns id/timestamps. */
export interface UptimeSampleInput {
  readonly component: string;
  readonly healthy: boolean;
  readonly detail: string | null;
}

export interface WindowUptime {
  /** Machine label for the window, e.g. "24h". */
  readonly window: string;
  readonly windowMs: number;
  /** ISO-8601 start of the window (now - windowMs). */
  readonly windowStartAt: string;
  readonly sampleCount: number;
  readonly healthyCount: number;
  /** Fraction healthy in [0, 1], or null when no samples were recorded. */
  readonly uptimeRatio: number | null;
  /** Convenience percentage rounded to 3 decimals, or null when unknown. */
  readonly uptimePercent: number | null;
}

export interface ComponentHealth {
  readonly component: UptimeComponent;
  readonly status: ComponentStatus;
  readonly latestObservedAt: string | null;
  readonly latestDetail: string | null;
  /** True when we have samples but the most recent one is older than fresh. */
  readonly stale: boolean;
  readonly statusReason: string;
  readonly windows: readonly WindowUptime[];
}

export interface StatusReport {
  readonly generatedAt: string;
  readonly overall: ComponentStatus;
  readonly components: readonly ComponentHealth[];
  readonly windows: readonly string[];
  readonly freshWindowMs: number;
  readonly disclaimer: string;
}

export interface BuildStatusReportInput {
  /** Samples read back from durable storage. */
  readonly recorded: readonly UptimeSample[];
  /** Optional live probe taken at read time; treated as the most recent samples. */
  readonly current?: readonly UptimeSample[];
  readonly now: number;
  /** A sample older than this makes the current status "unknown". Default 15 min. */
  readonly freshWindowMs?: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const DEFAULT_FRESH_WINDOW_MS = 15 * MS_PER_MINUTE;

/** The rolling windows uptime % is reported over. */
export const UPTIME_WINDOWS: readonly { readonly window: string; readonly windowMs: number }[] = [
  { window: "24h", windowMs: MS_PER_DAY },
  { window: "7d", windowMs: 7 * MS_PER_DAY },
  { window: "30d", windowMs: 30 * MS_PER_DAY },
] as const;

export const STATUS_DISCLAIMER =
  "Status and uptime are derived only from recorded health probes — a component " +
  "with no recent sample is shown as unknown, never assumed operational. Uptime " +
  "percentages are computed solely from the samples inside each disclosed window " +
  "and are an operational summary, not a contractual SLA.";

function isFiniteIso(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/** Parse to epoch ms, or NaN for anything unparseable. */
function toMs(value: string): number {
  return Date.parse(value);
}

function roundPercent(ratio: number): number {
  return Math.round(ratio * 100 * 1000) / 1000;
}

/**
 * Rank used to fold per-component statuses into the overall banner. A larger
 * number is a worse (more attention-worthy) state. "unknown" outranks
 * "operational" so a single unobserved component prevents an all-clear, but it
 * ranks below "degraded"/"down" which are observed problems.
 */
const STATUS_RANK: Record<ComponentStatus, number> = {
  operational: 0,
  unknown: 1,
  degraded: 2,
  down: 3,
};

function worst(a: ComponentStatus, b: ComponentStatus): ComponentStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function windowUptime(samples: readonly UptimeSample[], now: number, spec: { window: string; windowMs: number }): WindowUptime {
  const start = now - spec.windowMs;
  let sampleCount = 0;
  let healthyCount = 0;
  for (const sample of samples) {
    const ms = toMs(sample.observedAt);
    if (!Number.isFinite(ms) || ms < start || ms > now) continue;
    sampleCount += 1;
    if (sample.healthy) healthyCount += 1;
  }
  const uptimeRatio = sampleCount === 0 ? null : healthyCount / sampleCount;
  return {
    window: spec.window,
    windowMs: spec.windowMs,
    windowStartAt: new Date(start).toISOString(),
    sampleCount,
    healthyCount,
    uptimeRatio,
    uptimePercent: uptimeRatio === null ? null : roundPercent(uptimeRatio),
  };
}

function deriveComponent(
  component: UptimeComponent,
  samples: readonly UptimeSample[],
  now: number,
  freshWindowMs: number,
): ComponentHealth {
  const windows = UPTIME_WINDOWS.map((spec) => windowUptime(samples, now, spec));

  // Most recent valid sample by observed time.
  let latest: UptimeSample | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    const ms = toMs(sample.observedAt);
    if (!Number.isFinite(ms) || ms > now) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = sample;
    }
  }

  if (latest === null) {
    return {
      component,
      status: "unknown",
      latestObservedAt: null,
      latestDetail: null,
      stale: false,
      statusReason: "No health probe has recorded this component yet.",
      windows,
    };
  }

  const ageMs = now - latestMs;
  if (ageMs > freshWindowMs) {
    return {
      component,
      status: "unknown",
      latestObservedAt: latest.observedAt,
      latestDetail: latest.detail,
      stale: true,
      statusReason:
        `Last observed ${latest.observedAt}; the sample is older than the ${Math.round(freshWindowMs / MS_PER_MINUTE)}-minute ` +
        "freshness window, so the current state is unknown.",
      windows,
    };
  }

  if (!latest.healthy) {
    return {
      component,
      status: "down",
      latestObservedAt: latest.observedAt,
      latestDetail: latest.detail,
      stale: false,
      statusReason: latest.detail ?? "The most recent probe reported this component unhealthy.",
      windows,
    };
  }

  // Latest is fresh and healthy. Distinguish steady-state from a recent recovery
  // by looking for any failure inside the 24h window.
  const dayStart = now - MS_PER_DAY;
  const recentFailure = samples.some((sample) => {
    const ms = toMs(sample.observedAt);
    return Number.isFinite(ms) && ms >= dayStart && ms <= now && !sample.healthy;
  });

  if (recentFailure) {
    return {
      component,
      status: "degraded",
      latestObservedAt: latest.observedAt,
      latestDetail: latest.detail,
      stale: false,
      statusReason: "Recovered — the latest probe is healthy, but at least one failure was recorded in the last 24 hours.",
      windows,
    };
  }

  return {
    component,
    status: "operational",
    latestObservedAt: latest.observedAt,
    latestDetail: latest.detail,
    stale: false,
    statusReason: latest.detail ?? "The most recent probe reported this component healthy.",
    windows,
  };
}

/**
 * Compute the full status report. Samples for unknown component keys are
 * ignored (only the canonical `UPTIME_COMPONENTS` are reported), and malformed
 * timestamps are skipped rather than trusted. The optional live `current`
 * probe is merged in as the most recent observations.
 */
export function buildStatusReport(input: BuildStatusReportInput): StatusReport {
  const freshWindowMs = input.freshWindowMs ?? DEFAULT_FRESH_WINDOW_MS;
  const now = input.now;
  const nowIso = new Date(now).toISOString();

  const currentAsSamples: readonly UptimeSample[] = (input.current ?? []).map((sample) => ({
    component: sample.component,
    observedAt: isFiniteIso(sample.observedAt) ? sample.observedAt : nowIso,
    healthy: sample.healthy,
    detail: sample.detail,
  }));

  const all = [...input.recorded, ...currentAsSamples];
  const byComponent = new Map<string, UptimeSample[]>();
  for (const sample of all) {
    if (!UPTIME_COMPONENT_KEYS.includes(sample.component)) continue;
    const bucket = byComponent.get(sample.component);
    if (bucket === undefined) byComponent.set(sample.component, [sample]);
    else bucket.push(sample);
  }

  const components = UPTIME_COMPONENTS.map((component) =>
    deriveComponent(component, byComponent.get(component.key) ?? [], now, freshWindowMs),
  );

  const overall = components.reduce<ComponentStatus>(
    (acc, health) => worst(acc, health.status),
    "operational",
  );

  return {
    generatedAt: nowIso,
    overall,
    components,
    windows: UPTIME_WINDOWS.map((spec) => spec.window),
    freshWindowMs,
    disclaimer: STATUS_DISCLAIMER,
  };
}
