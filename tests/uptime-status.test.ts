import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStatusReport,
  DEFAULT_FRESH_WINDOW_MS,
  UPTIME_COMPONENT_KEYS,
  UPTIME_COMPONENTS,
  type ComponentStatus,
  type UptimeSample,
} from "../lib/uptime-status.ts";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function sample(component: string, agoMs: number, healthy: boolean): UptimeSample {
  return { component, observedAt: new Date(NOW - agoMs).toISOString(), healthy, detail: null };
}

function statusOf(report: ReturnType<typeof buildStatusReport>, key: string): ComponentStatus {
  const found = report.components.find((entry) => entry.component.key === key);
  assert.ok(found, `component ${key} missing`);
  return found.status;
}

function windowFor(report: ReturnType<typeof buildStatusReport>, key: string, window: string) {
  const health = report.components.find((entry) => entry.component.key === key);
  assert.ok(health, `component ${key} missing`);
  const found = health.windows.find((entry) => entry.window === window);
  assert.ok(found, `window ${window} missing`);
  return found;
}

test("with no samples every component is unknown and uptime is null, not 0 or 100", () => {
  const report = buildStatusReport({ recorded: [], now: NOW });
  assert.equal(report.overall, "unknown");
  assert.equal(report.components.length, UPTIME_COMPONENTS.length);
  for (const health of report.components) {
    assert.equal(health.status, "unknown");
    assert.equal(health.latestObservedAt, null);
    assert.equal(health.stale, false);
    for (const window of health.windows) {
      assert.equal(window.uptimeRatio, null);
      assert.equal(window.uptimePercent, null);
      assert.equal(window.sampleCount, 0);
    }
  }
});

test("a fresh healthy latest sample is operational with 100% over the windows it covers", () => {
  const recorded: UptimeSample[] = UPTIME_COMPONENT_KEYS.map((key) => sample(key, 2 * MINUTE, true));
  const report = buildStatusReport({ recorded, now: NOW });
  assert.equal(report.overall, "operational");
  for (const key of UPTIME_COMPONENT_KEYS) {
    assert.equal(statusOf(report, key), "operational");
    const day = windowFor(report, key, "24h");
    assert.equal(day.sampleCount, 1);
    assert.equal(day.healthyCount, 1);
    assert.equal(day.uptimePercent, 100);
  }
});

test("a fresh unhealthy latest sample is down", () => {
  const recorded = [sample("database", 1 * MINUTE, false)];
  const report = buildStatusReport({ recorded, now: NOW });
  assert.equal(statusOf(report, "database"), "down");
  // Other components have no sample, so overall is at worst down (>= down).
  assert.equal(report.overall, "down");
});

test("a recovered component (healthy now, failure in last 24h) is degraded, not operational", () => {
  const recorded = [
    sample("collector", 6 * HOUR, false),
    sample("collector", 1 * MINUTE, true),
  ];
  const report = buildStatusReport({ recorded, now: NOW });
  assert.equal(statusOf(report, "collector"), "degraded");
  const day = windowFor(report, "collector", "24h");
  assert.equal(day.sampleCount, 2);
  assert.equal(day.healthyCount, 1);
  assert.equal(day.uptimePercent, 50);
});

test("a latest sample older than the freshness window is unknown and marked stale", () => {
  const recorded = [sample("web-app", DEFAULT_FRESH_WINDOW_MS + MINUTE, true)];
  const report = buildStatusReport({ recorded, now: NOW });
  const health = report.components.find((entry) => entry.component.key === "web-app");
  assert.ok(health);
  assert.equal(health.status, "unknown");
  assert.equal(health.stale, true);
  // Even though the current state is unknown, the recorded sample still counts
  // toward the uptime windows (honest historical accounting).
  assert.equal(windowFor(report, "web-app", "24h").sampleCount, 1);
});

test("uptime windows partition samples by age and only count what was recorded", () => {
  const recorded = [
    sample("database", 10 * MINUTE, true), // in 24h, 7d, 30d
    sample("database", 3 * DAY, false), // in 7d, 30d only
    sample("database", 20 * DAY, true), // in 30d only
    sample("database", 40 * DAY, false), // outside all windows
  ];
  const report = buildStatusReport({ recorded, now: NOW });
  const day = windowFor(report, "database", "24h");
  assert.deepEqual([day.sampleCount, day.healthyCount, day.uptimePercent], [1, 1, 100]);
  const week = windowFor(report, "database", "7d");
  assert.deepEqual([week.sampleCount, week.healthyCount, week.uptimePercent], [2, 1, 50]);
  const month = windowFor(report, "database", "30d");
  assert.deepEqual([month.sampleCount, month.healthyCount, month.uptimePercent], [3, 2, roundPct(2 / 3)]);
});

test("overall is unknown when any component is unobserved even if the rest are operational", () => {
  // Every component operational except collector (no sample).
  const recorded = UPTIME_COMPONENT_KEYS
    .filter((key) => key !== "collector")
    .map((key) => sample(key, 1 * MINUTE, true));
  const report = buildStatusReport({ recorded, now: NOW });
  assert.equal(statusOf(report, "collector"), "unknown");
  assert.equal(report.overall, "unknown");
});

test("a live current probe is merged in as the most recent observation", () => {
  const recorded = [sample("database", 5 * MINUTE, false)];
  const report = buildStatusReport({
    recorded,
    current: [{ component: "database", observedAt: new Date(NOW).toISOString(), healthy: true, detail: "live" }],
    now: NOW,
  });
  // The live healthy probe is newest, but the recent failure keeps it degraded.
  assert.equal(statusOf(report, "database"), "degraded");
  assert.equal(windowFor(report, "database", "24h").sampleCount, 2);
});

test("samples for unknown component keys are ignored", () => {
  const recorded = [
    { component: "not-a-component", observedAt: new Date(NOW).toISOString(), healthy: true, detail: null },
  ];
  const report = buildStatusReport({ recorded, now: NOW });
  assert.equal(report.components.length, UPTIME_COMPONENTS.length);
  for (const health of report.components) assert.equal(health.status, "unknown");
});

function roundPct(ratio: number): number {
  return Math.round(ratio * 100 * 1000) / 1000;
}
