// Engine for the "recently launched / newly observed resources" tracker.
//
// A CMDB "added" change event marks the first snapshot in which Sutra observed a
// resource — that is an OBSERVATION time, not necessarily the moment the
// resource was created in the provider. Where the provider itself reports a real
// creation/launch time inside the resource configuration (EC2 launchTime, ELB
// createdAt, KMS/DynamoDB/S3 creationDate) we surface that as the authoritative
// launch time and mark the row `launchSource: 'aws'`. Otherwise we fall back to
// the first-observed timestamp and mark it `launchSource: 'first-observed'` so
// the two are never conflated.
//
// The engine is pure and deterministic: it maps rows to output and reads no
// clock. Any time-window filtering happens before the engine is called (the
// window-start epoch is computed and applied in the API route / repository).
import type { CmdbComparableResource } from "./cmdb-change-history.ts";

/** One `change_type='added'` event, as read from `cmdb_change_events`. */
export interface LaunchedAddedEvent {
  readonly resourceKey: string;
  /** `occurred_at` epoch milliseconds — when Sutra first observed the resource. */
  readonly occurredAtMs: number;
  /** The resource snapshot retained on the event (`after_json`), or null. */
  readonly after: CmdbComparableResource | null;
}

export interface LaunchedResource {
  readonly resourceKey: string;
  readonly name: string | null;
  readonly service: string | null;
  readonly resourceType: string | null;
  readonly region: string | null;
  /** ISO 8601 — when Sutra first observed the resource between snapshots. */
  readonly firstObservedAt: string;
  /** ISO 8601 provider launch/creation time when reported, else null. */
  readonly launchedAt: string | null;
  /** 'aws' when a real provider launch time was found, else 'first-observed'. */
  readonly launchSource: "aws" | "first-observed";
}

// Configuration keys that carry a provider-reported creation/launch time, in
// priority order. The collector writes these as ISO strings (see the AWS
// inventory runner): EC2 launchTime, ELB createdAt, KMS/DynamoDB/S3 creationDate.
const LAUNCH_TIME_KEYS = ["launchTime", "createdAt", "creationDate"] as const;

/** Parse a config value into an ISO 8601 string, or null when it is not a usable timestamp. */
function toIso(value: unknown): string | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  // Some providers report epoch seconds/milliseconds as a number.
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: values below 10^12 are treated as epoch seconds.
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function providerLaunchedAt(configuration: CmdbComparableResource["configuration"] | undefined): string | null {
  if (configuration === undefined || configuration === null) return null;
  for (const key of LAUNCH_TIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(configuration, key)) {
      const iso = toIso(configuration[key]);
      if (iso !== null) return iso;
    }
  }
  return null;
}

/**
 * Maps added-event rows to launched-resource rows. Pure and deterministic:
 * output order mirrors input order (callers pass rows already ordered by
 * occurred_at DESC). No clock is read.
 */
export function buildLaunchedResources(events: readonly LaunchedAddedEvent[]): readonly LaunchedResource[] {
  return events.map((event) => {
    const after = event.after;
    const launchedAt = providerLaunchedAt(after?.configuration);
    return {
      resourceKey: event.resourceKey,
      name: after?.name ?? null,
      service: after?.service ?? null,
      resourceType: after?.resourceType ?? null,
      region: after?.region ?? null,
      firstObservedAt: new Date(event.occurredAtMs).toISOString(),
      launchedAt,
      launchSource: launchedAt === null ? "first-observed" : "aws",
    };
  });
}
