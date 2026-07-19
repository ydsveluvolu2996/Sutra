import assert from "node:assert/strict";
import { test } from "node:test";

import type { Event as CloudTrailLookupEvent } from "@aws-sdk/client-cloudtrail";

import {
  collectCloudTrailSecurityEvents,
  deriveSecurityEventDetections,
  type CloudTrailLookupReader,
  type NormalizedSecurityEvent,
} from "../src/security-events-runner.js";

const NOW = new Date("2026-07-16T10:00:00.000Z");
const START = new Date("2026-07-16T09:00:00.000Z");
const credentials = {
  accessKeyId: "ASIAEXAMPLE00000000",
  secretAccessKey: "not-a-real-secret",
  sessionToken: "not-a-real-session",
  expiration: new Date("2026-07-16T11:00:00.000Z"),
};

function event(
  id: string,
  minute: number,
  eventName: string,
  detail: Record<string, unknown>,
): CloudTrailLookupEvent {
  return {
    EventId: id,
    EventName: eventName,
    EventSource: eventName === "ConsoleLogin" ? "signin.amazonaws.com" : "cloudtrail.amazonaws.com",
    EventTime: new Date(`2026-07-16T09:${String(minute).padStart(2, "0")}:00.000Z`),
    Username: "sutra-admin",
    ReadOnly: "false",
    CloudTrailEvent: JSON.stringify({
      eventVersion: "1.11",
      recipientAccountId: "123456789012",
      awsRegion: "us-east-1",
      sourceIPAddress: "203.0.113.10",
      userAgent: "console.amazonaws.com",
      requestParameters: { password: "must-never-be-normalized" },
      userIdentity: {
        type: "IAMUser",
        arn: "arn:aws:iam::123456789012:user/sutra-admin",
      },
      ...detail,
    }),
  };
}

test("normalizes real LookupEvents evidence and derives explainable rules without raw payloads", async () => {
  const events = [
    event("evt-login-fail", 1, "ConsoleLogin", {
      responseElements: { ConsoleLogin: "Failure" },
      errorCode: "FailedAuthentication",
      additionalEventData: { MFAUsed: "No" },
    }),
    event("evt-root-login", 2, "ConsoleLogin", {
      responseElements: { ConsoleLogin: "Success" },
      additionalEventData: { MFAUsed: "No" },
      userIdentity: { type: "Root", arn: "arn:aws:iam::123456789012:root" },
    }),
    event("evt-stop-logging", 3, "StopLogging", {}),
    event("evt-denied-1", 10, "UpdateTrail", { errorCode: "AccessDenied" }),
    event("evt-denied-2", 12, "UpdateTrail", { errorCode: "AccessDeniedException" }),
    event("evt-denied-3", 14, "UpdateTrail", { errorCode: "UnauthorizedOperation" }),
  ];
  const reader: CloudTrailLookupReader = {
    async lookupEvents() { return { Events: events }; },
  };
  const result = await collectCloudTrailSecurityEvents({
    accountId: "123456789012",
    partition: "aws",
    regions: ["us-east-1"],
    credentials,
    windowStart: START,
    windowEnd: NOW,
    now: () => NOW,
    readerFactory: () => reader,
  });

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.events.length, 6);
  assert.equal(result.retentionDays, 30);
  assert.deepEqual(new Set(result.detections.map((item) => item.ruleKey)), new Set([
    "SUTRA.EVENT.CONSOLE_LOGIN_FAILURE",
    "SUTRA.EVENT.ROOT_CONSOLE_LOGIN_NO_MFA",
    "SUTRA.EVENT.CLOUDTRAIL_CONFIGURATION_CHANGE",
    "SUTRA.EVENT.ACCESS_DENIED_BURST",
  ]));
  assert.equal(result.detections.find((item) => item.ruleKey === "SUTRA.EVENT.ACCESS_DENIED_BURST")?.eventIds.length, 3);
  assert.equal(JSON.stringify(result).includes("must-never-be-normalized"), false);
  assert.equal(JSON.stringify(result).includes("CloudTrailEvent"), false);
});

test("returns explicit unavailable coverage when every regional LookupEvents call is denied", async () => {
  const result = await collectCloudTrailSecurityEvents({
    accountId: "123456789012",
    partition: "aws",
    regions: ["us-east-1", "us-west-2"],
    credentials,
    windowStart: START,
    windowEnd: NOW,
    now: () => NOW,
    readerFactory: () => ({
      async lookupEvents() {
        throw Object.assign(new Error("sensitive provider detail"), { name: "AccessDeniedException" });
      },
    }),
  });

  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.every((entry) => entry.errorCode === "ACCESS_DENIED"), true);
  assert.equal(JSON.stringify(result).includes("sensitive provider detail"), false);
});

test("enforces page bounds and reports truncation instead of silently claiming completeness", async () => {
  let calls = 0;
  const result = await collectCloudTrailSecurityEvents({
    accountId: "123456789012",
    partition: "aws",
    regions: ["us-east-1"],
    credentials,
    windowStart: START,
    windowEnd: NOW,
    now: () => NOW,
    maxPagesPerRegion: 2,
    readerFactory: () => ({
      async lookupEvents() {
        calls += 1;
        return { Events: [], NextToken: `token-${calls}` };
      },
    }),
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.coverage[0]?.errorCode, "PAGE_LIMIT_REACHED");
  assert.ok(result.limitations.includes("EVENT_OUTPUT_LIMIT_REACHED"));
});

test("treats a malformed pagination token as partial protocol evidence", async () => {
  const result = await collectCloudTrailSecurityEvents({
    accountId: "123456789012",
    partition: "aws",
    regions: ["us-east-1"],
    credentials,
    windowStart: START,
    windowEnd: NOW,
    now: () => NOW,
    readerFactory: () => ({
      async lookupEvents() { return { Events: [], NextToken: "invalid\ncontinuation" }; },
    }),
  });

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.coverage[0]?.status, "PARTIAL");
  assert.equal(result.coverage[0]?.errorCode, "PAGINATION_TOKEN_INVALID");
});

test("reports partial detection coverage when CloudTrail detail is unavailable", async () => {
  const withoutDetail = { ...event("evt-no-detail", 20, "ConsoleLogin", {}), CloudTrailEvent: undefined };
  const result = await collectCloudTrailSecurityEvents({
    accountId: "123456789012",
    partition: "aws",
    regions: ["us-east-1"],
    credentials,
    windowStart: START,
    windowEnd: NOW,
    now: () => NOW,
    readerFactory: () => ({
      async lookupEvents() { return { Events: [withoutDetail] }; },
    }),
  });

  assert.equal(result.events[0]?.detailStatus, "UNAVAILABLE");
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.coverage[0]?.status, "PARTIAL");
  assert.equal(result.coverage[0]?.errorCode, "DETECTION_DETAIL_UNAVAILABLE");
});

test("aborts a stalled LookupEvents command at the overall deadline", async () => {
  let sawAbort = false;
  const startedAt = Date.now();
  const result = await collectCloudTrailSecurityEvents({
    accountId: "123456789012",
    partition: "aws",
    regions: ["us-east-1", "us-west-2"],
    credentials,
    windowStart: START,
    windowEnd: NOW,
    now: () => NOW,
    overallDeadlineMs: 20,
    commandDeadlineMs: 1_000,
    readerFactory: () => ({
      lookupEvents(_input, signal) {
        return new Promise((_, reject) => {
          const fallback = setTimeout(() => reject(new Error("abort signal was not delivered")), 1_000);
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            clearTimeout(fallback);
            reject(signal.reason);
          }, { once: true });
        });
      },
    }),
  });

  assert.equal(sawAbort, true);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.coverage.length, 2);
  assert.equal(result.coverage.every((entry) => entry.errorCode === "COLLECTION_TIMEOUT"), true);
});

test("aborts an individual stalled LookupEvents command before the overall deadline", async () => {
  let sawAbort = false;
  const result = await collectCloudTrailSecurityEvents({
    accountId: "123456789012",
    partition: "aws",
    regions: ["us-east-1"],
    credentials,
    windowStart: START,
    windowEnd: NOW,
    now: () => NOW,
    overallDeadlineMs: 1_000,
    commandDeadlineMs: 20,
    readerFactory: () => ({
      lookupEvents(_input, signal) {
        return new Promise((_, reject) => {
          const fallback = setTimeout(() => reject(new Error("abort signal was not delivered")), 1_000);
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            clearTimeout(fallback);
            reject(signal.reason);
          }, { once: true });
        });
      },
    }),
  });

  assert.equal(sawAbort, true);
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.coverage[0]?.errorCode, "TIMEOUT");
});

test("access-denied correlation requires a bounded burst with matching principal and source", () => {
  const base = (id: string, minute: number, sourceIp: string): NormalizedSecurityEvent => ({
    schemaVersion: "sutra.security-event.v1",
    providerEventId: id,
    accountId: "123456789012",
    region: "us-east-1",
    eventTime: `2026-07-16T09:${String(minute).padStart(2, "0")}:00.000Z`,
    eventName: "GetObject",
    eventSource: "s3.amazonaws.com",
    readOnly: true,
    managementEvent: true,
    eventCategory: "Management",
    username: "operator",
    identityType: "IAMUser",
    principalArn: "arn:aws:iam::123456789012:user/operator",
    sourceIp,
    userAgent: null,
    errorCode: "AccessDenied",
    requestId: null,
    consoleLoginResult: null,
    mfaUsed: null,
    detailStatus: "AVAILABLE",
    resources: [],
  });
  const detections = deriveSecurityEventDetections([
    base("one", 1, "203.0.113.10"),
    base("two", 4, "203.0.113.10"),
    base("three", 9, "203.0.113.10"),
    base("other-source", 10, "203.0.113.11"),
  ]);
  assert.equal(detections.filter((item) => item.ruleKey === "SUTRA.EVENT.ACCESS_DENIED_BURST").length, 1);
});
