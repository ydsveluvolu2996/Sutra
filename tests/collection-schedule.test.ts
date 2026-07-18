import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSchedules,
  type ScheduleInput,
} from "../lib/collection-schedule.ts";

function schedule(id: string, over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    id,
    target: `collect:${id}`,
    intervalMinutes: 60,
    lastRunAtMinutes: null,
    enabled: true,
    ...over,
  };
}

test("a never-run enabled schedule is due immediately with a zero overdue backlog", () => {
  const report = evaluateSchedules([schedule("s1", { lastRunAtMinutes: null })], 1000);
  assert.equal(report.due.length, 1);
  const due = report.due[0];
  assert.equal(due?.scheduleId, "s1");
  assert.equal(due?.target, "collect:s1");
  // Never assumed already run; but no first-scheduled time is synthesized.
  assert.equal(due?.overdueByMinutes, 0);
  assert.equal(report.upcoming.length, 0);
});

test("a schedule whose elapsed time meets the interval is due with the correct overdue", () => {
  // lastRun=100, interval=60, now=200 => elapsed 100 >= 60 => overdue 200-(100+60)=40.
  const report = evaluateSchedules([schedule("s1", { lastRunAtMinutes: 100, intervalMinutes: 60 })], 200);
  assert.equal(report.due.length, 1);
  assert.equal(report.due[0]?.overdueByMinutes, 40);
  assert.equal(report.upcoming.length, 0);
});

test("the due boundary is inclusive: elapsed exactly equal to the interval is due, overdue 0", () => {
  // lastRun=100, interval=60, now=160 => elapsed 60 >= 60 => due, overdue 0.
  const report = evaluateSchedules([schedule("s1", { lastRunAtMinutes: 100, intervalMinutes: 60 })], 160);
  assert.equal(report.due.length, 1);
  assert.equal(report.due[0]?.overdueByMinutes, 0);
  assert.equal(report.upcoming.length, 0);
});

test("a not-yet-elapsed schedule is upcoming with the correct nextDueInMinutes", () => {
  // lastRun=100, interval=60, now=130 => elapsed 30 < 60 => nextDue 160, in 30 minutes.
  const report = evaluateSchedules([schedule("s1", { lastRunAtMinutes: 100, intervalMinutes: 60 })], 130);
  assert.equal(report.upcoming.length, 1);
  assert.equal(report.upcoming[0]?.scheduleId, "s1");
  assert.equal(report.upcoming[0]?.nextDueInMinutes, 30);
  assert.equal(report.due.length, 0);
});

test("just below the boundary is upcoming in one minute, not due", () => {
  // lastRun=100, interval=60, now=159 => elapsed 59 < 60 => nextDue in 1 minute.
  const report = evaluateSchedules([schedule("s1", { lastRunAtMinutes: 100, intervalMinutes: 60 })], 159);
  assert.equal(report.due.length, 0);
  assert.equal(report.upcoming[0]?.nextDueInMinutes, 1);
});

test("a disabled schedule is listed under disabled and is never due, even when never run", () => {
  const report = evaluateSchedules([schedule("s1", { enabled: false, lastRunAtMinutes: null })], 1000);
  assert.deepEqual(report.disabled, ["s1"]);
  assert.equal(report.due.length, 0);
  assert.equal(report.upcoming.length, 0);
  assert.equal(report.invalid.length, 0);
});

test("a non-positive interval is reported invalid, never silently run", () => {
  const zero = evaluateSchedules([schedule("z", { intervalMinutes: 0, lastRunAtMinutes: null })], 500);
  assert.deepEqual(zero.invalid, [{ id: "z", tenant: null, reason: "non-positive-interval" }]);
  assert.equal(zero.due.length, 0);

  const negative = evaluateSchedules([schedule("n", { intervalMinutes: -30, lastRunAtMinutes: 100 })], 500);
  assert.deepEqual(negative.invalid, [{ id: "n", tenant: null, reason: "non-positive-interval" }]);
  assert.equal(negative.due.length, 0);
  assert.equal(negative.upcoming.length, 0);
});

test("a non-finite interval or non-finite last-run is reported invalid, not emitted as NaN", () => {
  const nanInterval = evaluateSchedules([schedule("a", { intervalMinutes: Number.NaN })], 500);
  assert.deepEqual(nanInterval.invalid, [{ id: "a", tenant: null, reason: "invalid-interval" }]);

  const infInterval = evaluateSchedules([schedule("b", { intervalMinutes: Number.POSITIVE_INFINITY })], 500);
  assert.deepEqual(infInterval.invalid, [{ id: "b", tenant: null, reason: "invalid-interval" }]);

  const badLastRun = evaluateSchedules([schedule("c", { intervalMinutes: 60, lastRunAtMinutes: Number.NaN })], 500);
  assert.deepEqual(badLastRun.invalid, [{ id: "c", tenant: null, reason: "invalid-last-run" }]);
  assert.equal(badLastRun.upcoming.length, 0);
  assert.equal(badLastRun.due.length, 0);
});

test("data-integrity invalidity takes precedence over disabled so the broken cadence is surfaced", () => {
  const report = evaluateSchedules([schedule("s1", { enabled: false, intervalMinutes: 0 })], 500);
  assert.deepEqual(report.invalid, [{ id: "s1", tenant: null, reason: "non-positive-interval" }]);
  assert.equal(report.disabled.length, 0);
});

test("a non-finite now makes every schedule invalid rather than emit a synthesized verdict", () => {
  const schedules = [
    schedule("s1", { lastRunAtMinutes: null }),
    schedule("s2", { lastRunAtMinutes: 100, intervalMinutes: 30 }),
  ];
  const report = evaluateSchedules(schedules, Number.NaN);
  assert.equal(report.nowMinutes, null);
  assert.equal(report.due.length, 0);
  assert.equal(report.upcoming.length, 0);
  assert.deepEqual(report.invalid.map((entry) => entry.reason), ["invalid-now", "invalid-now"]);
});

test("tenant scope is carried through onto due, upcoming, and invalid entries; absent tenant is null", () => {
  const report = evaluateSchedules(
    [
      schedule("due", { tenant: "acme", lastRunAtMinutes: null }),
      schedule("soon", { tenant: "globex", lastRunAtMinutes: 100, intervalMinutes: 60 }),
      schedule("broken", { tenant: "initech", intervalMinutes: 0 }),
      schedule("untenanted", { lastRunAtMinutes: null }),
    ],
    130,
  );
  assert.equal(report.due.find((d) => d.scheduleId === "due")?.tenant, "acme");
  assert.equal(report.due.find((d) => d.scheduleId === "untenanted")?.tenant, null);
  assert.equal(report.upcoming.find((u) => u.scheduleId === "soon")?.tenant, "globex");
  assert.equal(report.invalid.find((i) => i.id === "broken")?.tenant, "initech");
});

test("summary counts partition the input and evaluated equals due plus upcoming", () => {
  const report = evaluateSchedules(
    [
      schedule("due1", { lastRunAtMinutes: null }),
      schedule("due2", { lastRunAtMinutes: 0, intervalMinutes: 10 }),
      schedule("soon", { lastRunAtMinutes: 100, intervalMinutes: 60 }),
      schedule("off", { enabled: false }),
      schedule("bad", { intervalMinutes: -1 }),
    ],
    120,
  );
  const { summary } = report;
  assert.equal(summary.total, 5);
  assert.equal(summary.due, 2);
  assert.equal(summary.upcoming, 1);
  assert.equal(summary.disabled, 1);
  assert.equal(summary.invalid, 1);
  assert.equal(summary.evaluated, 3);
  // Every schedule lands in exactly one bucket.
  assert.equal(summary.due + summary.upcoming + summary.disabled + summary.invalid, summary.total);
});

test("due is ordered most-overdue-first and upcoming soonest-first, deterministically", () => {
  const report = evaluateSchedules(
    [
      schedule("d-small", { lastRunAtMinutes: 100, intervalMinutes: 10 }), // overdue 90
      schedule("d-big", { lastRunAtMinutes: 0, intervalMinutes: 10 }), // overdue 190
      schedule("u-late", { lastRunAtMinutes: 195, intervalMinutes: 60 }), // due in 55
      schedule("u-soon", { lastRunAtMinutes: 190, intervalMinutes: 20 }), // due in 10
    ],
    200,
  );
  assert.deepEqual(report.due.map((d) => d.scheduleId), ["d-big", "d-small"]);
  assert.deepEqual(report.upcoming.map((u) => u.scheduleId), ["u-soon", "u-late"]);
});

test("negative caller-epoch minute counts are handled as pure arithmetic", () => {
  // The caller's clock may be zero-based or negative; the engine only subtracts.
  const report = evaluateSchedules([schedule("s1", { lastRunAtMinutes: -50, intervalMinutes: 30 })], 10);
  // elapsed 10-(-50)=60 >= 30 => due, overdue 10-(-50+30)=30.
  assert.equal(report.due[0]?.overdueByMinutes, 30);
});

test("empty input yields empty buckets, zeroed summary, and the disclaimer", () => {
  const report = evaluateSchedules([], 1000);
  assert.equal(report.schema, "sutra.collection-schedule.v1");
  assert.equal(report.nowMinutes, 1000);
  assert.deepEqual(report.due, []);
  assert.deepEqual(report.upcoming, []);
  assert.deepEqual(report.disabled, []);
  assert.deepEqual(report.invalid, []);
  assert.deepEqual(report.summary, { total: 0, due: 0, upcoming: 0, disabled: 0, invalid: 0, evaluated: 0 });
  assert.match(report.disclaimer, /No wall clock is read/u);
});

test("output is deterministic for identical input", () => {
  const build = () => evaluateSchedules(
    [
      schedule("z", { lastRunAtMinutes: null }),
      schedule("a", { lastRunAtMinutes: 10, intervalMinutes: 5 }),
      schedule("m", { enabled: false }),
      schedule("q", { intervalMinutes: 0 }),
    ],
    100,
  );
  assert.deepEqual(build(), build());
});
