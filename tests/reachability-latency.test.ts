import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReachabilityLatency,
  DEFAULT_LATENCY_THRESHOLDS,
  type LatencySample,
} from "../lib/reachability-latency.ts";

function samples(ref: string, kind: LatencySample["kind"], values: readonly number[]): LatencySample[] {
  return values.map((milliseconds) => ({ endpointRef: ref, kind, milliseconds }));
}

test("no samples produces no endpoints and an all-zero summary", () => {
  const report = buildReachabilityLatency([]);
  assert.deepEqual(report.endpoints, []);
  assert.deepEqual(report.summary, { endpoints: 0, healthy: 0, degraded: 0, slow: 0, unknown: 0 });
  assert.equal(report.schema, "sutra.reachability-latency.v1");
});

test("a kind with no samples is 'unknown', never defaulted to 'healthy'", () => {
  const report = buildReachabilityLatency(samples("api", "response", [10, 20, 30]));
  const endpoint = report.endpoints[0];
  assert.equal(endpoint?.metrics.response.status, "healthy");
  assert.equal(endpoint?.metrics.application.status, "unknown");
  assert.equal(endpoint?.metrics.database.status, "unknown");
  assert.equal(endpoint?.metrics.application.sampleCount, 0);
  assert.equal(endpoint?.metrics.application.p95Ms, null);
  assert.equal(endpoint?.metrics.application.p50Ms, null);
});

test("bands response latency by p95 against the default thresholds", () => {
  // Nearest-rank p95 of 20 samples is index 18 (the 2nd-highest), so the top
  // two values drive the band.
  const healthy = buildReachabilityLatency(samples("h", "response", Array.from({ length: 20 }, () => 100)));
  assert.equal(healthy.endpoints[0]?.metrics.response.status, "healthy");

  const degraded = buildReachabilityLatency(samples("d", "response", [...Array(18).fill(100), 500, 500]));
  assert.equal(degraded.endpoints[0]?.metrics.response.status, "degraded"); // p95=500 > 300, <= 1000

  const slow = buildReachabilityLatency(samples("s", "response", [...Array(18).fill(100), 2_000, 2_000]));
  assert.equal(slow.endpoints[0]?.metrics.response.status, "slow"); // p95=2000 > 1000
});

test("database thresholds are stricter than response thresholds", () => {
  assert.ok(DEFAULT_LATENCY_THRESHOLDS.database.slowMs < DEFAULT_LATENCY_THRESHOLDS.response.slowMs);
  // 120ms p95 is healthy for response but slow for a database query.
  const values = [...Array(19).fill(120), 120];
  assert.equal(buildReachabilityLatency(samples("x", "response", values)).endpoints[0]?.metrics.response.status, "healthy");
  assert.equal(buildReachabilityLatency(samples("x", "database", values)).endpoints[0]?.metrics.database.status, "degraded");
});

test("computes p50, p95, max, and mean from the samples", () => {
  const report = buildReachabilityLatency(samples("api", "response", [10, 20, 30, 40, 100]));
  const m = report.endpoints[0]?.metrics.response;
  assert.equal(m?.sampleCount, 5);
  assert.equal(m?.p50Ms, 30); // ceil(0.5*5)=3 -> index 2 -> 30
  assert.equal(m?.p95Ms, 100); // ceil(0.95*5)=5 -> index 4 -> 100
  assert.equal(m?.maxMs, 100);
  assert.equal(m?.meanMs, 40); // (200)/5
});

test("worstStatus is the worst band across the three kinds", () => {
  const report = buildReachabilityLatency([
    ...samples("api", "response", [50]),
    ...samples("api", "application", [50]),
    ...samples("api", "database", [500]), // slow for database (>200)
  ]);
  assert.equal(report.endpoints[0]?.worstStatus, "slow");
  assert.equal(report.summary.slow, 1);
});

test("an endpoint with only unknown kinds cannot appear (no samples => not present)", () => {
  // Only invalid samples for an endpoint -> dropped -> endpoint absent entirely.
  const report = buildReachabilityLatency([
    { endpointRef: "ghost", kind: "response", milliseconds: Number.NaN },
    { endpointRef: "ghost", kind: "database", milliseconds: -5 },
  ]);
  assert.deepEqual(report.endpoints, []);
});

test("drops non-finite and negative readings without coercing them to zero", () => {
  const report = buildReachabilityLatency([
    ...samples("api", "response", [10, 20]),
    { endpointRef: "api", kind: "response", milliseconds: Number.NaN },
    { endpointRef: "api", kind: "response", milliseconds: -100 },
    { endpointRef: "api", kind: "response", milliseconds: Infinity },
  ]);
  const m = report.endpoints[0]?.metrics.response;
  assert.equal(m?.sampleCount, 2);
  assert.equal(m?.maxMs, 20); // the -100/NaN/Infinity never entered the aggregate
});

test("honors per-kind threshold overrides", () => {
  const strict = buildReachabilityLatency(samples("api", "response", [...Array(19).fill(60), 60]), {
    thresholds: { response: { degradedMs: 50, slowMs: 100 } },
  });
  assert.equal(strict.endpoints[0]?.metrics.response.status, "degraded"); // p95=60 > 50

  // An invalid override (slow <= degraded) is ignored; the default applies.
  const ignored = buildReachabilityLatency(samples("api", "response", [...Array(19).fill(60), 60]), {
    thresholds: { response: { degradedMs: 100, slowMs: 50 } },
  });
  assert.equal(ignored.endpoints[0]?.metrics.response.status, "healthy");
});

test("endpoints are sorted and output is deterministic", () => {
  const input = [
    ...samples("zeta", "response", [10]),
    ...samples("alpha", "database", [500]),
    ...samples("mu", "application", [50]),
  ];
  const a = buildReachabilityLatency(input);
  const b = buildReachabilityLatency([...input].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(a.endpoints.map((e) => e.endpointRef), ["alpha", "mu", "zeta"]);
  // alpha: database 500 -> slow; mu: application 50 -> healthy; zeta: response 10 -> healthy.
  assert.deepEqual(a.summary, { endpoints: 3, healthy: 2, degraded: 0, slow: 1, unknown: 0 });
});
