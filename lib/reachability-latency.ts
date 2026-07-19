// Reachability latency overlay. Once network-exposure says an endpoint is
// reachable, this answers "how healthy is that path" by aggregating latency
// observations into per-kind status bands: response latency (edge / load
// balancer target response time), application latency (compute/handler time),
// and database latency (query round-trip). It is pure and deterministic — the
// caller supplies already-collected samples (e.g. CloudWatch datapoints or APM
// exports); it never probes and never invents a number. A kind with no samples
// is UNKNOWN, not "healthy": absence of a measurement is not evidence of speed.

export type LatencyKind = "response" | "application" | "database";
export type LatencyStatus = "healthy" | "degraded" | "slow" | "unknown";

export interface LatencySample {
  readonly endpointRef: string;
  readonly kind: LatencyKind;
  readonly milliseconds: number;
}

export interface LatencyThreshold {
  readonly degradedMs: number;
  readonly slowMs: number;
}

export interface LatencyMetric {
  readonly kind: LatencyKind;
  readonly status: LatencyStatus;
  readonly sampleCount: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  readonly meanMs: number | null;
}

export interface EndpointLatency {
  readonly endpointRef: string;
  readonly worstStatus: LatencyStatus;
  readonly metrics: Readonly<Record<LatencyKind, LatencyMetric>>;
}

export interface LatencyReport {
  readonly schema: "sutra.reachability-latency.v1";
  readonly endpoints: readonly EndpointLatency[];
  readonly summary: {
    readonly endpoints: number;
    readonly healthy: number;
    readonly degraded: number;
    readonly slow: number;
    readonly unknown: number;
  };
  readonly disclaimer: string;
}

export const LATENCY_KINDS: readonly LatencyKind[] = ["response", "application", "database"];

// Tail latency (p95) is what users feel, so status is banded on p95. Defaults
// reflect typical expectations at each layer; a caller can override per kind.
export const DEFAULT_LATENCY_THRESHOLDS: Readonly<Record<LatencyKind, LatencyThreshold>> = {
  response: { degradedMs: 300, slowMs: 1_000 },
  application: { degradedMs: 200, slowMs: 800 },
  database: { degradedMs: 50, slowMs: 200 },
};

const STATUS_RANK: Readonly<Record<LatencyStatus, number>> = { slow: 3, degraded: 2, healthy: 1, unknown: 0 };

const DISCLAIMER =
  "Latency status aggregates collected samples per endpoint and kind (response, " +
  "application, database) and bands the p95 against per-kind thresholds. A kind " +
  "with no samples is 'unknown', never 'healthy' — absence of a measurement is " +
  "not evidence of speed. The engine does not probe; it summarizes observations " +
  "the collector supplied.";

function validThreshold(value: LatencyThreshold): boolean {
  return (
    Number.isFinite(value.degradedMs) && Number.isFinite(value.slowMs) &&
    value.degradedMs >= 0 && value.slowMs > value.degradedMs
  );
}

// Nearest-rank percentile over an ascending-sorted, non-empty array.
function percentile(sortedAsc: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index] as number;
}

function bandFor(p95: number, threshold: LatencyThreshold): LatencyStatus {
  if (p95 > threshold.slowMs) return "slow";
  if (p95 > threshold.degradedMs) return "degraded";
  return "healthy";
}

function metricFor(
  kind: LatencyKind,
  samples: readonly number[],
  threshold: LatencyThreshold,
): LatencyMetric {
  if (samples.length === 0) {
    return { kind, status: "unknown", sampleCount: 0, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    kind,
    status: bandFor(p95, threshold),
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: p95,
    maxMs: sorted[sorted.length - 1] as number,
    meanMs: Math.round(sum / sorted.length),
  };
}

export function buildReachabilityLatency(
  samples: readonly LatencySample[],
  opts: { readonly thresholds?: Partial<Record<LatencyKind, LatencyThreshold>> } = {},
): LatencyReport {
  const thresholds: Record<LatencyKind, LatencyThreshold> = { ...DEFAULT_LATENCY_THRESHOLDS };
  for (const kind of LATENCY_KINDS) {
    const override = opts.thresholds?.[kind];
    if (override !== undefined && validThreshold(override)) thresholds[kind] = override;
  }

  // Group valid samples by endpoint then kind. A non-finite or negative reading
  // is not a real observation and is dropped (never coerced to zero).
  const byEndpoint = new Map<string, Record<LatencyKind, number[]>>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.milliseconds) || sample.milliseconds < 0) continue;
    if (!LATENCY_KINDS.includes(sample.kind)) continue;
    let kinds = byEndpoint.get(sample.endpointRef);
    if (kinds === undefined) {
      kinds = { response: [], application: [], database: [] };
      byEndpoint.set(sample.endpointRef, kinds);
    }
    kinds[sample.kind].push(sample.milliseconds);
  }

  const endpoints: EndpointLatency[] = [...byEndpoint.entries()]
    .map(([endpointRef, kinds]) => {
      const metrics = {
        response: metricFor("response", kinds.response, thresholds.response),
        application: metricFor("application", kinds.application, thresholds.application),
        database: metricFor("database", kinds.database, thresholds.database),
      };
      const worstStatus = LATENCY_KINDS
        .map((kind) => metrics[kind].status)
        .reduce((worst, status) => (STATUS_RANK[status] > STATUS_RANK[worst] ? status : worst), "unknown" as LatencyStatus);
      return { endpointRef, worstStatus, metrics };
    })
    .sort((a, b) => a.endpointRef.localeCompare(b.endpointRef, "en-US"));

  const summary = {
    endpoints: endpoints.length,
    healthy: endpoints.filter((entry) => entry.worstStatus === "healthy").length,
    degraded: endpoints.filter((entry) => entry.worstStatus === "degraded").length,
    slow: endpoints.filter((entry) => entry.worstStatus === "slow").length,
    unknown: endpoints.filter((entry) => entry.worstStatus === "unknown").length,
  };

  return { schema: "sutra.reachability-latency.v1", endpoints, summary, disclaimer: DISCLAIMER };
}
