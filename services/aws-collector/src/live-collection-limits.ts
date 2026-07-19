/**
 * One-host live-collection safety envelope. The web request and stale-run
 * reclaim windows deliberately exceed the collector deadline so a healthy
 * bounded run is never abandoned or reclaimed while it is still working.
 */
// Short per-call ceilings produced false partials against healthy but occasionally
// slow commercial Region endpoints during repeated live 17-Region rehearsals.
// Sixty seconds accommodates normal AWS SDK retry latency while the five-minute
// collection deadline still bounds the complete workload.
export const LIVE_AWS_COMMAND_DEADLINE_MS = 60_000;
export const LIVE_AWS_COLLECTION_DEADLINE_MS = 300_000;
export const LIVE_AWS_BROKER_TIMEOUT_MS = 330_000;
export const LIVE_AWS_RUN_RECLAIM_AFTER_MS = 360_000;

/** The pilot boundary accepts at most 500 collector coverage rows. */
export const LIVE_AWS_COVERAGE_ROW_LIMIT = 500;
export const LIVE_AWS_GLOBAL_COLLECTOR_COUNT = 2;
export const LIVE_AWS_REGIONAL_COLLECTOR_COUNT = 21;
export const LIVE_AWS_MAX_REGIONS = Math.floor(
  (LIVE_AWS_COVERAGE_ROW_LIMIT - LIVE_AWS_GLOBAL_COLLECTOR_COUNT) /
    LIVE_AWS_REGIONAL_COLLECTOR_COUNT,
);

if (
  LIVE_AWS_BROKER_TIMEOUT_MS <= LIVE_AWS_COLLECTION_DEADLINE_MS ||
  LIVE_AWS_RUN_RECLAIM_AFTER_MS <= LIVE_AWS_BROKER_TIMEOUT_MS ||
  LIVE_AWS_GLOBAL_COLLECTOR_COUNT +
    LIVE_AWS_REGIONAL_COLLECTOR_COUNT * LIVE_AWS_MAX_REGIONS >
    LIVE_AWS_COVERAGE_ROW_LIMIT
) {
  throw new Error("The live AWS collection safety envelope is inconsistent");
}
