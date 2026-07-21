import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCloudDetectionInputs,
  toCloudTrailDetectionEvent,
  toGuardDutyDetectionEvent,
  toK8sAuditDetectionEvent,
} from "../lib/cloud-detection-inputs.ts";
import { buildCloudDetections } from "../lib/cloud-detection.ts";
import type { NormalizedSecurityEvent } from "../lib/security-event-types.ts";

const T = "2026-07-18T00:00:00.000Z";

function event(over: Partial<NormalizedSecurityEvent> & { readonly eventName: string }): NormalizedSecurityEvent {
  return {
    schemaVersion: "sutra.security-event.v1",
    providerEventId: "evt-1",
    accountId: "111122223333",
    region: "us-east-1",
    eventTime: T,
    eventSource: "cloudtrail.amazonaws.com",
    readOnly: false,
    managementEvent: true,
    eventCategory: "Management",
    username: null,
    identityType: "IAMUser",
    principalArn: "arn:aws:iam::111122223333:user/alice",
    sourceIp: "203.0.113.5",
    userAgent: null,
    errorCode: null,
    requestId: null,
    consoleLoginResult: null,
    mfaUsed: null,
    detailStatus: "AVAILABLE",
    resources: [],
    ...over,
  };
}

test("zero collected events reports zero coverage explicitly, not 'no detections'", () => {
  const inputs = buildCloudDetectionInputs([]);
  assert.equal(inputs.events.length, 0);
  assert.equal(inputs.coverage.zeroCoverage, true);
  assert.equal(inputs.coverage.eventsIngested, 0);
  assert.match(inputs.coverage.notice, /Zero coverage/u);
  // The engine over an empty stream still yields a well-formed, empty report.
  const report = buildCloudDetections(inputs.events);
  assert.equal(report.summary.detections, 0);
});

test("single-source coverage discloses CloudTrail-only and the absent sources", () => {
  const inputs = buildCloudDetectionInputs([event({ eventName: "DescribeInstances" })]);
  assert.equal(inputs.coverage.zeroCoverage, false);
  assert.equal(inputs.coverage.singleSource, true);
  assert.deepEqual(inputs.coverage.sourcesPresent, ["cloudtrail"]);
  assert.deepEqual(inputs.coverage.sourcesAbsent, ["guardduty", "k8s-audit"]);
  assert.equal(inputs.coverage.parametersUnavailable, true);
  assert.match(inputs.coverage.notice, /CloudTrail-only/u);
  assert.match(inputs.coverage.notice, /not.*full-coverage/iu);
});

test("maps a normalized event into a cloudtrail engine event, carrying the tenant", () => {
  const mapped = toCloudTrailDetectionEvent(event({ eventName: "StopLogging" }), "acme");
  assert.equal(mapped.source, "cloudtrail");
  assert.equal(mapped.eventName, "StopLogging");
  assert.equal(mapped.principal, "arn:aws:iam::111122223333:user/alice");
  assert.equal(mapped.sourceIp, "203.0.113.5");
  assert.equal(mapped.time, T);
  assert.equal(mapped.tenant, "acme");
  assert.equal(mapped.errorCode, undefined);
  const report = buildCloudDetections([mapped]);
  assert.equal(report.detections[0]?.ruleId, "cloudtrail-logging-disabled");
  assert.equal(report.detections[0]?.tenant, "acme");
});

test("recovers mfaUsed so a console login without MFA is detected", () => {
  const report = buildCloudDetections(buildCloudDetectionInputs([
    event({ eventName: "ConsoleLogin", consoleLoginResult: "Success", mfaUsed: false }),
  ]).events);
  assert.equal(report.detections[0]?.ruleId, "console-login-without-mfa");
});

test("a failed console login (result Failure, no errorCode) is treated as not having changed state", () => {
  const mapped = toCloudTrailDetectionEvent(event({ eventName: "ConsoleLogin", consoleLoginResult: "Failure", mfaUsed: false }));
  assert.equal(mapped.errorCode, "ConsoleLoginFailure");
  const report = buildCloudDetections([mapped]);
  assert.equal(report.detections.length, 0);
});

test("prefers a real errorCode when the normalized event carries one", () => {
  const mapped = toCloudTrailDetectionEvent(event({ eventName: "StopLogging", errorCode: "AccessDenied" }));
  assert.equal(mapped.errorCode, "AccessDenied");
  // A failed mutating call emits no detection.
  assert.equal(buildCloudDetections([mapped]).detections.length, 0);
});

test("falls back to username, then 'unknown', when no principal ARN is present", () => {
  assert.equal(toCloudTrailDetectionEvent(event({ eventName: "X", principalArn: null, username: "bob" })).principal, "bob");
  assert.equal(toCloudTrailDetectionEvent(event({ eventName: "X", principalArn: null, username: null })).principal, "unknown");
});

test("does not fabricate request parameters: an S3-public call cannot fire without collected params", () => {
  // The normalized store never retained the ACL/policy params this rule needs,
  // so the event is evaluated but emits no fabricated detection.
  const report = buildCloudDetections(buildCloudDetectionInputs([
    event({ eventName: "PutBucketAcl" }),
  ]).events);
  assert.equal(report.detections.length, 0);
  assert.equal(report.summary.evaluated, 1);
  assert.equal(report.summary.unclassified, 0);
});

test("omits sourceIp and params when the normalized event does not carry them", () => {
  const mapped = toCloudTrailDetectionEvent(event({ eventName: "X", sourceIp: null, mfaUsed: null }));
  assert.equal("sourceIp" in mapped, false);
  assert.equal("params" in mapped, false);
});

test("an omitted source is declared absent; a supplied (even empty) source is declared present", () => {
  // GuardDuty supplied but empty (collected, nothing found) -> present, not absent.
  const withGuardDuty = buildCloudDetectionInputs([event({ eventName: "DescribeInstances" })], {
    guardDutyFindings: [],
  });
  assert.deepEqual(withGuardDuty.coverage.sourcesPresent, ["cloudtrail", "guardduty"]);
  assert.deepEqual(withGuardDuty.coverage.sourcesAbsent, ["k8s-audit"]);
  assert.equal(withGuardDuty.coverage.singleSource, false);
  assert.equal(withGuardDuty.coverage.zeroCoverage, false);
  assert.deepEqual(withGuardDuty.coverage.ingestedBySource, { cloudtrail: 1, guardduty: 0, "k8s-audit": 0 });
  // Omitting GuardDuty entirely keeps it absent (never collected).
  const withoutGuardDuty = buildCloudDetectionInputs([event({ eventName: "DescribeInstances" })]);
  assert.deepEqual(withoutGuardDuty.coverage.sourcesPresent, ["cloudtrail"]);
  assert.deepEqual(withoutGuardDuty.coverage.sourcesAbsent, ["guardduty", "k8s-audit"]);
});

test("GuardDuty findings are mapped, banded, and fed as a second engine source", () => {
  const mapped = toGuardDutyDetectionEvent(
    { findingType: "Backdoor:EC2/C&CActivity.B", severity: 8.5, resourceRef: "i-0abc", time: T },
    "acme",
  );
  assert.equal(mapped.source, "guardduty");
  assert.equal(mapped.findingType, "Backdoor:EC2/C&CActivity.B");
  assert.equal(mapped.severity, 8.5);
  assert.equal(mapped.resourceRef, "i-0abc");
  assert.equal(mapped.tenant, "acme");
  const inputs = buildCloudDetectionInputs([], {
    tenant: "acme",
    guardDutyFindings: [{ findingType: "Backdoor:EC2/C&CActivity.B", severity: 8.5, resourceRef: "i-0abc", time: T }],
  });
  const report = buildCloudDetections(inputs.events);
  assert.equal(report.detections.length, 1);
  assert.equal(report.detections[0]?.source, "guardduty");
  assert.equal(report.detections[0]?.severity, "critical");
  assert.equal(report.detections[0]?.confidence, "high");
  assert.equal(report.detections[0]?.tenant, "acme");
  assert.equal(report.summary.bySource.guardduty, 1);
});

test("Kubernetes audit signals are mapped and fed as a third engine source", () => {
  const mapped = toK8sAuditDetectionEvent(
    { verb: "create", resource: "pods/exec", user: "dev@corp", namespace: "payments", time: T },
    "acme",
  );
  assert.equal(mapped.source, "k8s-audit");
  assert.equal(mapped.verb, "create");
  assert.equal(mapped.resource, "pods/exec");
  assert.equal(mapped.namespace, "payments");
  assert.equal(mapped.tenant, "acme");
  const inputs = buildCloudDetectionInputs([], {
    tenant: "acme",
    k8sAuditSignals: [{ verb: "create", resource: "pods/exec", user: "dev@corp", namespace: "payments", time: T }],
  });
  const report = buildCloudDetections(inputs.events);
  assert.equal(report.detections[0]?.ruleId, "k8s-exec-into-pod");
  assert.equal(report.detections[0]?.source, "k8s-audit");
});

test("omits namespace when the Kubernetes signal does not carry one", () => {
  const mapped = toK8sAuditDetectionEvent({ verb: "get", resource: "secrets", user: "alice", time: T });
  assert.equal("namespace" in mapped, false);
});

test("full multi-source coverage discloses all three present and merges every event", () => {
  const inputs = buildCloudDetectionInputs([event({ eventName: "StopLogging" })], {
    tenant: "acme",
    guardDutyFindings: [{ findingType: "X", severity: 8, resourceRef: "i-1", time: T }],
    k8sAuditSignals: [{ verb: "create", resource: "pods/exec", user: "u", time: T }],
  });
  assert.deepEqual(inputs.coverage.sourcesPresent, ["cloudtrail", "guardduty", "k8s-audit"]);
  assert.deepEqual(inputs.coverage.sourcesAbsent, []);
  assert.equal(inputs.coverage.singleSource, false);
  assert.equal(inputs.coverage.eventsIngested, 3);
  assert.deepEqual(inputs.coverage.ingestedBySource, { cloudtrail: 1, guardduty: 1, "k8s-audit": 1 });
  assert.doesNotMatch(inputs.coverage.notice, /CloudTrail-only/u);
  assert.match(inputs.coverage.notice, /Multi-source/u);
  const report = buildCloudDetections(inputs.events);
  assert.deepEqual(report.summary.bySource, { cloudtrail: 1, guardduty: 1, "k8s-audit": 1 });
});

test("zero coverage across all present sources reports zero coverage, not 'no detections'", () => {
  const inputs = buildCloudDetectionInputs([], { guardDutyFindings: [], k8sAuditSignals: [] });
  assert.equal(inputs.coverage.zeroCoverage, true);
  assert.equal(inputs.coverage.eventsIngested, 0);
  assert.match(inputs.coverage.notice, /Zero coverage/u);
  // Sources are still disclosed as present (collected, empty), not absent.
  assert.deepEqual(inputs.coverage.sourcesPresent, ["cloudtrail", "guardduty", "k8s-audit"]);
});
