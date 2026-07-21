// Adapter: the already-collected, tenant-scoped evidence this app persists ->
// the cloud-detection engine's multi-source event stream. Pure and
// deterministic; it only reshapes already-collected evidence and never invents
// an event, a field, or a source that was not collected.
//
// MULTI-SOURCE. The cloud-detection engine correlates three sources: AWS
// CloudTrail management events, AWS GuardDuty findings, and Kubernetes audit /
// in-cluster runtime signals. CloudTrail is always fed (the positional
// argument). GuardDuty findings and Kubernetes audit signals are fed only when
// the caller has actually collected them; each is optional so the coverage
// disclosure can distinguish "collected, nothing found" (an empty array) from
// "not collected" (omitted). A source that was never collected is declared
// absent — its would-be detections are structurally out of reach here, and an
// empty result for it is never presented as "clean".
//
// HONESTY.
//   * Every mapped event carries its true source; the engine labels each
//     detection with that source and a confidence, so a GuardDuty finding is
//     never blurred into a CloudTrail change.
//   * The CloudTrail normalized store deliberately keeps a bounded subset and
//     does NOT retain raw request parameters. So the only rule parameter
//     recoverable from CloudTrail is `mfaUsed` (console-login-without-MFA).
//     Parameter-dependent CloudTrail rules — security group opened to the
//     world, IAM policy made permissive, S3 bucket made public, GuardDuty
//     detector explicitly disabled — cannot fire from this source because their
//     evidence was never collected. Those calls still count as evaluated events
//     but emit no fabricated detection.
//   * A failed console login is normalized as consoleLoginResult "Failure"
//     rather than an errorCode; it is translated into the engine's errorCode
//     convention so a failed login is treated as not having changed state.
//   * When no source produced any event, the result reports zero coverage
//     explicitly — this is not the same as "no detections".
import type {
  CloudTrailEvent,
  CloudDetectionEvent,
  GuardDutyEvent,
  K8sAuditEvent,
} from "./cloud-detection.ts";
import type { NormalizedSecurityEvent } from "./security-event-types.ts";

export type CloudDetectionSourceKind = "cloudtrail" | "guardduty" | "k8s-audit";

// Canonical source order used in every coverage disclosure so present/absent
// lists are deterministic regardless of which sources the caller supplied.
const SOURCE_ORDER: readonly CloudDetectionSourceKind[] = ["cloudtrail", "guardduty", "k8s-audit"];

// A GuardDuty finding already normalized out of the collected AWS-native
// finding evidence. Only the fields the engine's pass-through rule needs are
// carried; the rest of the finding is discarded rather than reshaped.
export interface NormalizedGuardDutyFinding {
  readonly findingType: string;
  readonly severity: number;
  readonly resourceRef: string;
  readonly time: string;
}

// A Kubernetes audit / in-cluster runtime signal already normalized out of the
// collected agent evidence. Verb + resource + user are what the engine's
// exec/secret/clusterrolebinding rules read.
export interface NormalizedK8sAuditSignal {
  readonly verb: string;
  readonly resource: string;
  readonly user: string;
  readonly namespace?: string;
  readonly time: string;
}

export interface CloudDetectionCoverage {
  // Sources with a live collection pipeline feeding the engine for this call.
  readonly sourcesPresent: readonly CloudDetectionSourceKind[];
  // Sources the engine supports but which were not collected for this call — so
  // any detection they would surface is structurally out of reach here.
  readonly sourcesAbsent: readonly CloudDetectionSourceKind[];
  // True when exactly one source fed the engine.
  readonly singleSource: boolean;
  // True when no source produced any event: report zero coverage, never
  // "no detections" (an empty stream cannot prove the account is clean).
  readonly zeroCoverage: boolean;
  // Number of collected events actually handed to the engine, across all
  // present sources.
  readonly eventsIngested: number;
  // Per-source count of events handed to the engine (0 for an absent source).
  readonly ingestedBySource: Readonly<Record<CloudDetectionSourceKind, number>>;
  // True when the only recoverable rule parameter is `mfaUsed`; the CloudTrail
  // normalized store does not retain request parameters, so parameter-dependent
  // CloudTrail rules cannot fire from this source.
  readonly parametersUnavailable: boolean;
  // Human-readable coverage disclosure for the UI.
  readonly notice: string;
}

export interface CloudDetectionInputs {
  readonly events: readonly CloudDetectionEvent[];
  readonly coverage: CloudDetectionCoverage;
}

export interface CloudDetectionInputOptions {
  readonly tenant?: string;
  // Omit a source entirely to declare it "not collected"; pass an array (even
  // empty) to declare it collected. This is what keeps "collected, nothing
  // found" honestly distinct from "never collected".
  readonly guardDutyFindings?: readonly NormalizedGuardDutyFinding[];
  readonly k8sAuditSignals?: readonly NormalizedK8sAuditSignal[];
}

const ZERO_COVERAGE_NOTICE =
  "Zero coverage: none of the collected sources produced an event for this " +
  "connection yet. This is not a claim that the account is free of threats — " +
  "there is simply nothing to evaluate. Collect a bounded CloudTrail window on " +
  "the Security Events page (and, where available, GuardDuty findings and " +
  "Kubernetes audit signals) first.";

const CLOUDTRAIL_ONLY_NOTICE =
  "Single-source coverage. These detections are derived only from collected " +
  "AWS CloudTrail management events. GuardDuty findings and Kubernetes audit " +
  "events are not collected, so runtime, threat-intelligence, and in-cluster " +
  "detections are out of scope — this is CloudTrail-only signal, not " +
  "full-coverage cloud detection & response. The normalized event store does " +
  "not retain request parameters, so parameter-dependent rules (security group " +
  "opened to 0.0.0.0/0, IAM policy made permissive, S3 bucket made public, " +
  "GuardDuty detector disabled) cannot fire from this source; those calls are " +
  "counted as evaluated but emit no fabricated detection.";

const SOURCE_LABEL: Readonly<Record<CloudDetectionSourceKind, string>> = {
  cloudtrail: "AWS CloudTrail management events",
  guardduty: "AWS GuardDuty findings",
  "k8s-audit": "Kubernetes audit / in-cluster runtime signals",
};

function coverageNotice(
  present: readonly CloudDetectionSourceKind[],
  absent: readonly CloudDetectionSourceKind[],
  zeroCoverage: boolean,
): string {
  if (zeroCoverage) return ZERO_COVERAGE_NOTICE;
  // Preserve the exact CloudTrail-only wording (and its "CloudTrail-only" /
  // "not full-coverage" phrasing) for the common single-source case.
  if (present.length === 1 && present[0] === "cloudtrail") return CLOUDTRAIL_ONLY_NOTICE;
  const presentText = present.map((source) => SOURCE_LABEL[source]).join("; ");
  const absentText = absent.length === 0
    ? "No supported source is absent."
    : `Not collected, so structurally out of scope here: ${absent.map((source) => SOURCE_LABEL[source]).join("; ")}.`;
  const parameterCaveat = present.includes("cloudtrail")
    ? " The CloudTrail normalized store does not retain request parameters, so " +
      "parameter-dependent CloudTrail rules (security group opened to 0.0.0.0/0, " +
      "IAM policy made permissive, S3 bucket made public, GuardDuty detector " +
      "disabled) cannot fire from that source and are counted as evaluated but " +
      "emit no fabricated detection."
    : "";
  return (
    `Multi-source coverage. Detections are derived from collected: ${presentText}. ` +
    `Each detection is labeled with the source that proved it. ${absentText}` +
    `${parameterCaveat} An empty result for any source is not a claim that the ` +
    "account is clean; it means nothing matched the collected evidence."
  );
}

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

export function toGuardDutyDetectionEvent(
  finding: NormalizedGuardDutyFinding,
  tenant?: string,
): GuardDutyEvent {
  return {
    source: "guardduty",
    findingType: finding.findingType,
    severity: finding.severity,
    resourceRef: finding.resourceRef,
    time: finding.time,
    ...(tenant === undefined ? {} : { tenant }),
  };
}

export function toK8sAuditDetectionEvent(
  signal: NormalizedK8sAuditSignal,
  tenant?: string,
): K8sAuditEvent {
  const namespace = signal.namespace ?? undefined;
  return {
    source: "k8s-audit",
    verb: signal.verb,
    resource: signal.resource,
    user: signal.user,
    time: signal.time,
    ...(namespace === undefined ? {} : { namespace }),
    ...(tenant === undefined ? {} : { tenant }),
  };
}

export function buildCloudDetectionInputs(
  events: readonly NormalizedSecurityEvent[],
  options: CloudDetectionInputOptions = {},
): CloudDetectionInputs {
  const tenant = options.tenant;
  const cloudTrail = events.map((event) => toCloudTrailDetectionEvent(event, tenant));
  // CloudTrail is always a present source (the route always queries it).
  // GuardDuty / Kubernetes are present only when the caller collected them.
  const guardDutyCollected = options.guardDutyFindings !== undefined;
  const k8sCollected = options.k8sAuditSignals !== undefined;
  const guardDuty = (options.guardDutyFindings ?? []).map((finding) =>
    toGuardDutyDetectionEvent(finding, tenant));
  const k8sAudit = (options.k8sAuditSignals ?? []).map((signal) =>
    toK8sAuditDetectionEvent(signal, tenant));

  const merged: CloudDetectionEvent[] = [...cloudTrail, ...guardDuty, ...k8sAudit];
  const ingestedBySource: Record<CloudDetectionSourceKind, number> = {
    cloudtrail: cloudTrail.length,
    guardduty: guardDuty.length,
    "k8s-audit": k8sAudit.length,
  };
  const presentSet = new Set<CloudDetectionSourceKind>(["cloudtrail"]);
  if (guardDutyCollected) presentSet.add("guardduty");
  if (k8sCollected) presentSet.add("k8s-audit");
  const sourcesPresent = SOURCE_ORDER.filter((source) => presentSet.has(source));
  const sourcesAbsent = SOURCE_ORDER.filter((source) => !presentSet.has(source));
  const zeroCoverage = merged.length === 0;

  return {
    events: merged,
    coverage: {
      sourcesPresent,
      sourcesAbsent,
      singleSource: sourcesPresent.length === 1,
      zeroCoverage,
      eventsIngested: merged.length,
      ingestedBySource,
      parametersUnavailable: true,
      notice: coverageNotice(sourcesPresent, sourcesAbsent, zeroCoverage),
    },
  };
}
