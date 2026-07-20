import assert from "node:assert/strict";
import test from "node:test";
import { buildCollectionScheduleInputs } from "../lib/collection-schedule-inputs.ts";
import { evaluateSchedules } from "../lib/collection-schedule.ts";
import type { LocalFixtureSchedule } from "../lib/local-ops-types.ts";

const HOUR_MS = 3_600_000;
// A fixed wall clock so every case is deterministic; the adapter reads no clock.
const NOW_MS = Date.parse("2026-07-20T12:00:00.000Z");

function fixtureSchedule(over: Partial<LocalFixtureSchedule> = {}): LocalFixtureSchedule {
  return {
    scheduleId: "sched_0000000000000000000000000000000000000000000000",
    tenantId: "org_local_sutra",
    fixtureId: "acme-prod",
    customerId: "cust_00000000000000000000000000000000",
    connectionId: "conn_00000000000000000000000000000000",
    version: "2026.07.0",
    everyMs: HOUR_MS,
    nextRunAt: "2026-07-20T12:30:00.000Z",
    enabled: true,
    maxAttempts: 5,
    capacityState: "healthy",
    capacitySkippedOccurrences: 0,
    capacityBlockedAt: null,
    missedOccurrences: 0,
    lastMissedAt: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...over,
  };
}

test("empty configured set maps to an explicit empty evaluation, never assumed due", () => {
  const inputs = buildCollectionScheduleInputs([], NOW_MS);
  assert.equal(inputs.schedules.length, 0);
  assert.equal(inputs.nowMinutes, NOW_MS / 60_000);
  const report = evaluateSchedules(inputs.schedules, inputs.nowMinutes);
  assert.equal(report.summary.total, 0);
  assert.equal(report.summary.due, 0);
  assert.equal(report.summary.upcoming, 0);
  assert.equal(report.due.length, 0);
});

test("interval and derived last-run are mapped from everyMs and nextRunAt", () => {
  const { schedules, nowMinutes } = buildCollectionScheduleInputs(
    [fixtureSchedule({ everyMs: HOUR_MS, nextRunAt: "2026-07-20T12:30:00.000Z" })],
    NOW_MS,
  );
  assert.equal(nowMinutes, NOW_MS / 60_000);
  const input = schedules[0];
  assert.equal(input?.intervalMinutes, 60);
  assert.equal(input?.tenant, "cust_00000000000000000000000000000000");
  assert.equal(input?.target, "acme-prod");
  // Implied last run is exactly one interval before the stored next run.
  assert.equal(input?.lastRunAtMinutes, Date.parse("2026-07-20T11:30:00.000Z") / 60_000);
});

test("a schedule whose next run has passed is due, with the correct overdue backlog", () => {
  // next run 11:00 (past), interval 60m => last run 10:00 => now 12:00 overdue 60m.
  const { schedules, nowMinutes } = buildCollectionScheduleInputs(
    [fixtureSchedule({ nextRunAt: "2026-07-20T11:00:00.000Z" })],
    NOW_MS,
  );
  const report = evaluateSchedules(schedules, nowMinutes);
  assert.equal(report.summary.due, 1);
  assert.equal(report.due[0]?.target, "acme-prod");
  assert.equal(report.due[0]?.overdueByMinutes, 60);
});

test("a schedule whose next run is still ahead is upcoming, never due", () => {
  // next run 12:30 => upcoming in 30 minutes.
  const { schedules, nowMinutes } = buildCollectionScheduleInputs(
    [fixtureSchedule({ nextRunAt: "2026-07-20T12:30:00.000Z" })],
    NOW_MS,
  );
  const report = evaluateSchedules(schedules, nowMinutes);
  assert.equal(report.summary.due, 0);
  assert.equal(report.summary.upcoming, 1);
  assert.equal(report.upcoming[0]?.nextDueInMinutes, 30);
});

test("a disabled schedule is listed under disabled, never dropped", () => {
  const { schedules, nowMinutes } = buildCollectionScheduleInputs(
    [fixtureSchedule({ enabled: false, nextRunAt: "2026-07-20T11:00:00.000Z" })],
    NOW_MS,
  );
  const report = evaluateSchedules(schedules, nowMinutes);
  assert.equal(report.summary.disabled, 1);
  assert.equal(report.summary.due, 0);
  assert.deepEqual(report.disabled, [schedules[0]?.id]);
});

test("a non-positive interval is surfaced invalid, never silently run or skipped", () => {
  // A broken cadence that the strict parser would reject upstream still maps to
  // an invalid verdict rather than being dropped or assumed due.
  const broken = { ...fixtureSchedule(), everyMs: 0 } as LocalFixtureSchedule;
  const { schedules, nowMinutes } = buildCollectionScheduleInputs([broken], NOW_MS);
  const report = evaluateSchedules(schedules, nowMinutes);
  assert.equal(report.summary.invalid, 1);
  assert.equal(report.invalid[0]?.reason, "non-positive-interval");
  assert.equal(report.summary.due, 0);
});

test("an unparseable next-run timestamp is surfaced as invalid-last-run", () => {
  const broken = { ...fixtureSchedule(), nextRunAt: "not-a-timestamp" } as LocalFixtureSchedule;
  const { schedules, nowMinutes } = buildCollectionScheduleInputs([broken], NOW_MS);
  assert.equal(Number.isNaN(schedules[0]?.lastRunAtMinutes), true);
  const report = evaluateSchedules(schedules, nowMinutes);
  assert.equal(report.summary.invalid, 1);
  assert.equal(report.invalid[0]?.reason, "invalid-last-run");
});
