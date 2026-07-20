// Adapter: the REAL configured local fixture schedules (LocalFixtureSchedule[])
// -> the collection-schedule engine's ScheduleInput[] + the nowMinutes the
// engine reads no clock for. Pure and deterministic: it only reshapes stored
// cadence and never invents a run.
//
// The collector stores each schedule as an interval (`everyMs`) plus the next
// scheduled boundary (`nextRunAt`). The engine reasons about a last-run minute
// and an interval, so the implied last run is exactly one interval before
// `nextRunAt`; deriving it that way preserves the collector's own dueness
// semantics (a schedule is due once now has reached its `nextRunAt`) while
// giving the engine faithful overdue / next-due magnitudes. Nothing is
// synthesized beyond that one arithmetic identity.
//
// Honesty rules mirror the engine's own:
//   * A non-finite or non-positive `everyMs` becomes a non-finite / non-positive
//     intervalMinutes, which the engine reports invalid — never silently dropped
//     and never assumed due.
//   * An unparseable `nextRunAt` yields a NaN last-run, which the engine reports
//     as invalid-last-run rather than treating the schedule as due.
//   * A disabled schedule is passed through with enabled:false so the engine
//     lists it under `disabled`, never dropped.
// The strict `parseLocalFixtureSchedule` boundary already rejects malformed
// schedules upstream, but this adapter still maps defensively so that if a
// broken cadence ever reaches it, the state is surfaced, not hidden.
import type { LocalFixtureSchedule } from "./local-ops-types.ts";
import type { ScheduleInput } from "./collection-schedule.ts";

const MS_PER_MINUTE = 60_000;

export interface CollectionScheduleInputs {
  readonly schedules: readonly ScheduleInput[];
  readonly nowMinutes: number;
}

function lastRunAtMinutes(schedule: LocalFixtureSchedule): number | null {
  const nextRunEpochMs = Date.parse(schedule.nextRunAt);
  // A non-finite parse or a non-finite interval cannot yield a real last-run
  // minute; hand the engine a NaN so it reports invalid rather than a fabricated
  // due verdict. (null would mean "never run" — an explicit fact we do not have.)
  if (!Number.isFinite(nextRunEpochMs) || !Number.isFinite(schedule.everyMs)) {
    return Number.NaN;
  }
  return (nextRunEpochMs - schedule.everyMs) / MS_PER_MINUTE;
}

export function buildCollectionScheduleInputs(
  schedules: readonly LocalFixtureSchedule[],
  nowEpochMs: number,
): CollectionScheduleInputs {
  const mapped = schedules.map((schedule): ScheduleInput => ({
    id: schedule.scheduleId,
    tenant: schedule.customerId,
    target: schedule.fixtureId,
    intervalMinutes: schedule.everyMs / MS_PER_MINUTE,
    lastRunAtMinutes: lastRunAtMinutes(schedule),
    enabled: schedule.enabled,
  }));
  return { schedules: mapped, nowMinutes: nowEpochMs / MS_PER_MINUTE };
}
