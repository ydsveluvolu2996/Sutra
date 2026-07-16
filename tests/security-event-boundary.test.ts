import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAwsSecurityEventCollection, SecurityEventBoundaryError } from "../lib/security-event-boundary.ts";
import { resolveSecurityEventWindow } from "../lib/security-event-window.ts";

const base = {
  schemaVersion: "sutra.security-events.v1",
  source: "AWS_CLOUDTRAIL_LOOKUP_EVENTS",
  status: "COMPLETE",
  accountId: "123456789012",
  collectedAt: "2026-07-16T10:00:00.000Z",
  windowStart: "2026-07-16T09:00:00.000Z",
  windowEnd: "2026-07-16T10:00:00.000Z",
  retentionDays: 30,
  coverage: [{ region: "us-east-1", status: "SUCCEEDED", pagesObserved: 1, eventsObserved: 1, eventsDropped: 0, errorCode: null }],
  events: [{
    schemaVersion: "sutra.security-event.v1",
    providerEventId: "event-1",
    accountId: "123456789012",
    region: "us-east-1",
    eventTime: "2026-07-16T09:30:00.000Z",
    eventName: "ConsoleLogin",
    eventSource: "signin.amazonaws.com",
    readOnly: false,
    managementEvent: true,
    eventCategory: "Management",
    username: "operator",
    identityType: "IAMUser",
    principalArn: "arn:aws:iam::123456789012:user/operator",
    sourceIp: "203.0.113.10",
    userAgent: "console.amazonaws.com",
    errorCode: "FailedAuthentication",
    requestId: "request-1",
    consoleLoginResult: "Failure",
    mfaUsed: false,
    detailStatus: "AVAILABLE",
    resources: [],
  }],
  detections: [{
    detectionId: `sed_${"a".repeat(48)}`,
    ruleKey: "SUTRA.EVENT.CONSOLE_LOGIN_FAILURE",
    ruleVersion: "1.0.0",
    severity: "medium",
    title: "AWS console login failed",
    summary: "CloudTrail recorded an unsuccessful sign-in.",
    firstEventAt: "2026-07-16T09:30:00.000Z",
    lastEventAt: "2026-07-16T09:30:00.000Z",
    eventIds: ["event-1"],
    evidence: { eventCount: 1 },
    limitation: "Validate the identity and surrounding events.",
  }],
  limitations: ["RAW_CLOUDTRAIL_EVENT_NOT_RETAINED"],
} as const;

test("accepts a strictly scoped normalized security-event collection", () => {
  const parsed = parseAwsSecurityEventCollection(base, "123456789012");
  assert.equal(parsed.events[0]?.providerEventId, "event-1");
  assert.equal(parsed.detections[0]?.eventIds[0], "event-1");
});

test("rejects cross-account, cross-region, and orphan detection evidence", () => {
  assert.throws(() => parseAwsSecurityEventCollection({ ...base, accountId: "999999999999" }, "123456789012"), SecurityEventBoundaryError);
  assert.throws(() => parseAwsSecurityEventCollection({ ...base, events: [{ ...base.events[0], region: "us-west-2" }] }, "123456789012"), SecurityEventBoundaryError);
  assert.throws(() => parseAwsSecurityEventCollection({ ...base, detections: [{ ...base.detections[0], eventIds: ["missing"] }] }, "123456789012"), SecurityEventBoundaryError);
});

test("rejects a completeness claim when regional coverage is partial", () => {
  assert.throws(() => parseAwsSecurityEventCollection({
    ...base,
    coverage: [{ ...base.coverage[0], status: "PARTIAL", errorCode: "PAGE_LIMIT_REACHED" }],
  }, "123456789012"), SecurityEventBoundaryError);
});

test("rejects a completeness claim when detection fields could not be parsed", () => {
  assert.throws(() => parseAwsSecurityEventCollection({
    ...base,
    events: [{ ...base.events[0], detailStatus: "UNAVAILABLE" }],
  }, "123456789012"), SecurityEventBoundaryError);
});

test("retries an incomplete window without advancing the complete checkpoint", () => {
  const nowMillis = Date.parse("2026-07-16T12:00:00.000Z");
  const resolved = resolveSecurityEventWindow({
    nowMillis,
    lookbackHours: 1,
    overlapMinutes: 5,
    completeCheckpointEndMillis: Date.parse("2026-07-16T10:00:00.000Z"),
    latestAttempt: {
      status: "PARTIAL",
      windowStartMillis: Date.parse("2026-07-16T09:55:00.000Z"),
    },
  });

  assert.equal(resolved.basis, "INCOMPLETE_RETRY");
  assert.equal(new Date(resolved.startMillis).toISOString(), "2026-07-16T09:55:00.000Z");
  assert.equal(resolved.gapTruncated, false);
});

test("reports an explicit gap when an incomplete retry exceeds the 24-hour source bound", () => {
  const nowMillis = Date.parse("2026-07-16T12:00:00.000Z");
  const resolved = resolveSecurityEventWindow({
    nowMillis,
    lookbackHours: 1,
    overlapMinutes: 5,
    completeCheckpointEndMillis: null,
    latestAttempt: {
      status: "UNAVAILABLE",
      windowStartMillis: Date.parse("2026-07-14T12:00:00.000Z"),
    },
  });

  assert.equal(resolved.basis, "INCOMPLETE_RETRY");
  assert.equal(new Date(resolved.startMillis).toISOString(), "2026-07-15T12:00:00.000Z");
  assert.equal(resolved.gapTruncated, true);
});

test("applies the configured overlap only to a complete checkpoint", () => {
  const resolved = resolveSecurityEventWindow({
    nowMillis: Date.parse("2026-07-16T12:00:00.000Z"),
    lookbackHours: 1,
    overlapMinutes: 5,
    completeCheckpointEndMillis: Date.parse("2026-07-16T11:30:00.000Z"),
    latestAttempt: { status: "COMPLETE", windowStartMillis: Date.parse("2026-07-16T10:30:00.000Z") },
  });

  assert.equal(resolved.basis, "COMPLETE_CHECKPOINT_OVERLAP");
  assert.equal(new Date(resolved.startMillis).toISOString(), "2026-07-16T11:25:00.000Z");
});
