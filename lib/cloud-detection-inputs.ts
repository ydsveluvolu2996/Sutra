// Adapter: the CloudTrail management events this app already collects
// ("Security Events Lite", normalized as NormalizedSecurityEvent) -> the
// cloud-detection engine's event stream. Pure and deterministic; it only
// reshapes already-collected evidence and never invents an event or a field.
//
// HONESTY. The cloud-detection engine ideally correlates three sources
// (CloudTrail management events, GuardDuty findings, Kubernetes audit). Only
// CloudTrail management events are collected today, so:
//   * Every mapped event carries source "cloudtrail"; GuardDuty and k8s-audit
//     are declared absent in the coverage disclosure below. These are
//     CloudTrail-only signals, never full-coverage cloud detection & response.
//   * The normalized store deliberately keeps a bounded subset and does NOT
//     retain the raw CloudTrailEvent request parameters. So the only rule
//     parameter recoverable from this source is `mfaUsed` (for the
//     console-login-without-MFA rule). Parameter-dependent rules — security
//     group opened to the world, IAM policy made permissive, S3 bucket made
//     public, GuardDuty detector explicitly disabled — cannot fire from this
//     source because their evidence was never collected. That is surfaced, not
//     silently swallowed: those calls still count as evaluated events but emit
//     no detection rather than a fabricated one.
//   * A failed console login is normalized as consoleLoginResult "Failure"
//     rather than an errorCode; it is translated into the engine's errorCode
//     convention so a failed login is treated as not having changed state.
//   * When no events are collected, the result reports zero coverage
//     explicitly — this is not the same as "no detections".
import type { CloudTrailEvent } from "./cloud-detection.ts";
import type { NormalizedSecurityEvent } from "./security-event-types.ts";

export type CloudDetectionSourceKind = "cloudtrail" | "guardduty" | "k8s-audit";

// The full source universe the engine can correlate. Only CloudTrail
// management events have a collection pipeline in this app today.
const COLLECTED_SOURCES: readonly CloudDetectionSourceKind[] = ["cloudtrail"];
const UNCOLLECTED_SOURCES: readonly CloudDetectionSourceKind[] = ["guardduty", "k8s-audit"];

export interface CloudDetectionCoverage {
  // Sources with a live collection pipeline feeding the engine.
  readonly sourcesPresent: readonly CloudDetectionSourceKind[];
  // Sources the engine supports but which this app does not collect — so any
  // detection they would surface is structurally out of reach here.
  readonly sourcesAbsent: readonly CloudDetectionSourceKind[];
  // True when at most one source feeds the engine (always true today).
  readonly singleSource: boolean;
  // True when no events were collected at all: report zero coverage, never
  // "no detections" (an empty stream cannot prove the account is clean).
  readonly zeroCoverage: boolean;
  // Number of collected events actually handed to the engine.
  readonly eventsIngested: number;
  // True when the only recoverable rule parameter is `mfaUsed`; the normalized
  // store does not retain request parameters, so parameter-dependent rules
  // cannot fire from this source.
  readonly parametersUnavailable: boolean;
  // Human-readable single-source / partial-coverage disclosure for the UI.
  readonly notice: string;
}

export interface CloudDetectionInputs {
  readonly events: readonly CloudTrailEvent[];
  readonly coverage: CloudDetectionCoverage;
}

const ZERO_COVERAGE_NOTICE =
  "Zero coverage: no CloudTrail management events have been collected for this " +
  "connection yet. This is not a claim that the account is free of threats — " +
  "there is simply nothing to evaluate. Collect a bounded CloudTrail window on " +
  "the Security Events page first.";

const SINGLE_SOURCE_NOTICE =
  "Single-source coverage. These detections are derived only from collected " +
  "AWS CloudTrail management events. GuardDuty findings and Kubernetes audit " +
  "events are not collected, so runtime, threat-intelligence, and in-cluster " +
  "detections are out of scope — this is CloudTrail-only signal, not " +
  "full-coverage cloud detection & response. The normalized event store does " +
  "not retain request parameters, so parameter-dependent rules (security group " +
  "opened to 0.0.0.0/0, IAM policy made permissive, S3 bucket made public, " +
  "GuardDuty detector disabled) cannot fire from this source; those calls are " +
  "counted as evaluated but emit no fabricated detection.";

function principalOf(event: NormalizedSecurityEvent): string {
  return event.principalArn ?? event.username ?? "unknown";
}

// A failed console login is normalized to consoleLoginResult "Failure" rather
// than to an errorCode; translate it so the engine treats the login as not
// having succeeded (and so never flags a failed login as "login without MFA").
function errorCodeOf(event: NormalizedSecurityEvent): string | undefined {
  if (event.errorCode !== null) return event.errorCode;
  if (event.consoleLoginResult === "Failure") return "ConsoleLoginFailure";
  return undefined;
}

function paramsOf(event: NormalizedSecurityEvent): Record<string, unknown> | undefined {
  // Only `mfaUsed` is recoverable from the normalized shape; request
  // parameters were never collected, so no other rule input is fabricated.
  return event.mfaUsed === null ? undefined : { mfaUsed: event.mfaUsed };
}

export function toCloudTrailDetectionEvent(
  event: NormalizedSecurityEvent,
  tenant?: string,
): CloudTrailEvent {
  const sourceIp = event.sourceIp ?? undefined;
  const errorCode = errorCodeOf(event);
  const params = paramsOf(event);
  return {
    source: "cloudtrail",
    eventName: event.eventName,
    principal: principalOf(event),
    time: event.eventTime,
    ...(sourceIp === undefined ? {} : { sourceIp }),
    ...(params === undefined ? {} : { params }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(tenant === undefined ? {} : { tenant }),
  };
}

export function buildCloudDetectionInputs(
  events: readonly NormalizedSecurityEvent[],
  options: { readonly tenant?: string } = {},
): CloudDetectionInputs {
  const mapped = events.map((event) => toCloudTrailDetectionEvent(event, options.tenant));
  const zeroCoverage = mapped.length === 0;
  return {
    events: mapped,
    coverage: {
      sourcesPresent: COLLECTED_SOURCES,
      sourcesAbsent: UNCOLLECTED_SOURCES,
      singleSource: true,
      zeroCoverage,
      eventsIngested: mapped.length,
      parametersUnavailable: true,
      notice: zeroCoverage ? ZERO_COVERAGE_NOTICE : SINGLE_SOURCE_NOTICE,
    },
  };
}
