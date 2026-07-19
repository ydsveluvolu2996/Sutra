// Collection-schedule engine: decides which collection targets are DUE to run
// right now, purely from the integer minute counts the caller supplies. It reads
// no wall clock — the caller passes `nowMinutes`, so identical inputs always
// yield an identical verdict. Three honesty rules keep it from inventing
// schedule state that was never collected:
//   * A never-run schedule (lastRunAtMinutes === null) is due NOW; the engine
//     never assumes an unrecorded run already happened, and never synthesizes a
//     first-scheduled time it was not given — its overdueByMinutes is 0, not a
//     fabricated backlog.
//   * A non-positive or non-finite intervalMinutes is reported as INVALID, never
//     silently run and never silently skipped; a broken cadence is surfaced with
//     a cited reason. The same applies to a non-null but non-finite last-run and
//     to a non-finite `now` — reported invalid rather than emitted as a NaN due
//     or overdue value.
//   * A disabled schedule is listed under `disabled`, never dropped.
// Nothing is synthesized: every verdict is a function of the cited minute counts.

export type ScheduleInvalidReason =
  | "invalid-now"
  | "non-positive-interval"
  | "invalid-interval"
  | "invalid-last-run";

export interface ScheduleInput {
  readonly id: string;
  readonly tenant?: string | null;
  readonly target: string;
  readonly intervalMinutes: number;
  // Minutes (on the caller's own clock) of the last recorded run, or null when
  // the schedule has never run. Null is an explicit fact, not a missing value.
  readonly lastRunAtMinutes: number | null;
  readonly enabled: boolean;
}

export interface DueSchedule {
  readonly scheduleId: string;
  readonly tenant: string | null;
  readonly target: string;
  readonly overdueByMinutes: number;
}

export interface UpcomingSchedule {
  readonly scheduleId: string;
  readonly tenant: string | null;
  readonly nextDueInMinutes: number;
}

export interface InvalidSchedule {
  readonly id: string;
  readonly tenant: string | null;
  readonly reason: ScheduleInvalidReason;
}

export interface ScheduleEvaluationSummary {
  readonly total: number;
  readonly due: number;
  readonly upcoming: number;
  readonly disabled: number;
  readonly invalid: number;
  // Schedules whose cadence was actually computed (enabled and valid) = due +
  // upcoming; disabled and invalid schedules are not evaluated for dueness.
  readonly evaluated: number;
}

export interface ScheduleEvaluation {
  readonly schema: "sutra.collection-schedule.v1";
  // The `now` used, echoed back for traceability; null when the caller passed a
  // non-finite value, so a NaN is never surfaced as if it were a real clock.
  readonly nowMinutes: number | null;
  readonly due: readonly DueSchedule[];
  readonly upcoming: readonly UpcomingSchedule[];
  readonly disabled: readonly string[];
  readonly invalid: readonly InvalidSchedule[];
  readonly summary: ScheduleEvaluationSummary;
  readonly disclaimer: string;
}

const SCHEDULE_DISCLAIMER =
  "Dueness is computed only from the integer minute counts provided: a schedule " +
  "is due when it is enabled and has either never run or has gone at least its " +
  "interval since its last recorded run. A never-run schedule is due now and is " +
  "never assumed to have already run; its overdue backlog is not synthesized. A " +
  "non-positive, non-finite, or otherwise unusable interval, last-run, or now " +
  "value is reported as invalid, never silently run or skipped, and disabled " +
  "schedules are listed, never dropped. No wall clock is read — the caller " +
  "supplies now, so the same inputs always yield the same verdict.";

export function evaluateSchedules(
  schedules: readonly ScheduleInput[],
  nowMinutes: number,
): ScheduleEvaluation {
  const nowValid = Number.isFinite(nowMinutes);

  const due: DueSchedule[] = [];
  const upcoming: UpcomingSchedule[] = [];
  const disabled: string[] = [];
  const invalid: InvalidSchedule[] = [];

  for (const schedule of schedules) {
    const tenant = schedule.tenant ?? null;

    // Without a usable now, no schedule's dueness can be determined; report each
    // as invalid rather than emit a synthesized NaN verdict.
    if (!nowValid) {
      invalid.push({ id: schedule.id, tenant, reason: "invalid-now" });
      continue;
    }

    // Data-integrity checks first: a broken cadence is surfaced whether or not
    // the schedule is enabled, because reporting it merely "disabled" would hide
    // a real problem that resurfaces the moment it is re-enabled.
    if (!Number.isFinite(schedule.intervalMinutes)) {
      invalid.push({ id: schedule.id, tenant, reason: "invalid-interval" });
      continue;
    }
    if (schedule.intervalMinutes <= 0) {
      invalid.push({ id: schedule.id, tenant, reason: "non-positive-interval" });
      continue;
    }
    if (schedule.lastRunAtMinutes !== null && !Number.isFinite(schedule.lastRunAtMinutes)) {
      invalid.push({ id: schedule.id, tenant, reason: "invalid-last-run" });
      continue;
    }

    if (!schedule.enabled) {
      disabled.push(schedule.id);
      continue;
    }

    const lastRun = schedule.lastRunAtMinutes;
    const isDue = lastRun === null || nowMinutes - lastRun >= schedule.intervalMinutes;
    if (isDue) {
      // A never-run schedule is due now; we do not fabricate how long it has
      // been overdue (there is no first-scheduled time on record), so its
      // overdue backlog is 0. The clamp guards the arithmetic for run schedules.
      const overdueByMinutes = lastRun === null
        ? 0
        : Math.max(0, nowMinutes - (lastRun + schedule.intervalMinutes));
      due.push({ scheduleId: schedule.id, tenant, target: schedule.target, overdueByMinutes });
    } else {
      // lastRun is non-null here: a null lastRun is always due above.
      const nextDue = (lastRun ?? nowMinutes) + schedule.intervalMinutes;
      upcoming.push({ scheduleId: schedule.id, tenant, nextDueInMinutes: nextDue - nowMinutes });
    }
  }

  due.sort((left, right) =>
    right.overdueByMinutes - left.overdueByMinutes ||
    left.scheduleId.localeCompare(right.scheduleId, "en-US"));
  upcoming.sort((left, right) =>
    left.nextDueInMinutes - right.nextDueInMinutes ||
    left.scheduleId.localeCompare(right.scheduleId, "en-US"));
  disabled.sort((left, right) => left.localeCompare(right, "en-US"));
  invalid.sort((left, right) =>
    left.id.localeCompare(right.id, "en-US") ||
    left.reason.localeCompare(right.reason, "en-US"));

  return {
    schema: "sutra.collection-schedule.v1",
    nowMinutes: nowValid ? nowMinutes : null,
    due,
    upcoming,
    disabled,
    invalid,
    summary: {
      total: schedules.length,
      due: due.length,
      upcoming: upcoming.length,
      disabled: disabled.length,
      invalid: invalid.length,
      evaluated: due.length + upcoming.length,
    },
    disclaimer: SCHEDULE_DISCLAIMER,
  };
}
