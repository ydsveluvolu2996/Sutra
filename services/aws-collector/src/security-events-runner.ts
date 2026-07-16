import { createHash } from "node:crypto";

import {
  CloudTrailClient,
  LookupEventsCommand,
  type Event as CloudTrailLookupEvent,
  type LookupEventsCommandInput,
  type LookupEventsCommandOutput,
} from "@aws-sdk/client-cloudtrail";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";

export const SECURITY_EVENT_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
export const SECURITY_EVENT_RETENTION_DAYS = 30;
export const SECURITY_EVENT_MAX_EVENTS = 2_000;
export const SECURITY_EVENT_MAX_PAGES_PER_REGION = 3;
export const SECURITY_EVENT_MAX_DETECTIONS = 200;
export const SECURITY_EVENT_OVERALL_DEADLINE_MS = 75_000;
export const SECURITY_EVENT_COMMAND_DEADLINE_MS = 10_000;

const LOOKUP_PAGE_SIZE = 50;
const ACCESS_DENIED_BURST_THRESHOLD = 3;
const ACCESS_DENIED_BURST_WINDOW_MS = 10 * 60 * 1_000;
const CLOUDTRAIL_CHANGE_EVENTS = new Set([
  "DeleteEventDataStore",
  "DeleteTrail",
  "PutEventSelectors",
  "PutInsightSelectors",
  "StartImport",
  "StopImport",
  "StopLogging",
  "UpdateEventDataStore",
  "UpdateTrail",
]);

export type SecurityEventCollectionStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export type SecurityEventCoverageStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";
export type SecurityDetectionSeverity = "critical" | "high" | "medium" | "low";

export interface NormalizedSecurityEventResource {
  readonly type: string | null;
  readonly name: string | null;
}

export interface NormalizedSecurityEvent {
  readonly schemaVersion: "sutra.security-event.v1";
  readonly providerEventId: string;
  readonly accountId: string;
  readonly region: string;
  readonly eventTime: string;
  readonly eventName: string;
  readonly eventSource: string;
  readonly readOnly: boolean | null;
  readonly managementEvent: boolean | null;
  readonly eventCategory: string | null;
  readonly username: string | null;
  readonly identityType: string | null;
  readonly principalArn: string | null;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly errorCode: string | null;
  readonly requestId: string | null;
  readonly consoleLoginResult: "Success" | "Failure" | null;
  readonly mfaUsed: boolean | null;
  readonly detailStatus: "AVAILABLE" | "UNAVAILABLE";
  readonly resources: readonly NormalizedSecurityEventResource[];
}

export interface SecurityEventDetection {
  readonly detectionId: string;
  readonly ruleKey: string;
  readonly ruleVersion: "1.0.0";
  readonly severity: SecurityDetectionSeverity;
  readonly title: string;
  readonly summary: string;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventIds: readonly string[];
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly limitation: string;
}

export interface SecurityEventRegionCoverage {
  readonly region: string;
  readonly status: SecurityEventCoverageStatus;
  readonly pagesObserved: number;
  readonly eventsObserved: number;
  readonly eventsDropped: number;
  readonly errorCode: string | null;
}

export interface AwsSecurityEventCollection {
  readonly schemaVersion: "sutra.security-events.v1";
  readonly source: "AWS_CLOUDTRAIL_LOOKUP_EVENTS";
  readonly status: SecurityEventCollectionStatus;
  readonly accountId: string;
  readonly collectedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly retentionDays: 30;
  readonly coverage: readonly SecurityEventRegionCoverage[];
  readonly events: readonly NormalizedSecurityEvent[];
  readonly detections: readonly SecurityEventDetection[];
  readonly limitations: readonly string[];
}

export interface CloudTrailLookupReader {
  lookupEvents(
    input: LookupEventsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<Pick<LookupEventsCommandOutput, "Events" | "NextToken">>;
}

export type CloudTrailLookupReaderFactory = (
  region: string,
  credentials: AwsTemporaryCredentials,
) => CloudTrailLookupReader;

export interface SecurityEventCollectionOptions {
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly regions: readonly string[];
  readonly credentials: AwsTemporaryCredentials;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly now?: () => Date;
  readonly readerFactory?: CloudTrailLookupReaderFactory;
  readonly maxEvents?: number;
  readonly maxPagesPerRegion?: number;
  readonly overallDeadlineMs?: number;
  readonly commandDeadlineMs?: number;
  readonly abortSignal?: AbortSignal;
}

export async function collectCloudTrailSecurityEvents(
  options: SecurityEventCollectionOptions,
): Promise<AwsSecurityEventCollection> {
  const now = options.now?.() ?? new Date();
  const maximumEvents = boundedInteger(options.maxEvents ?? SECURITY_EVENT_MAX_EVENTS, 1, SECURITY_EVENT_MAX_EVENTS);
  const maximumPages = boundedInteger(
    options.maxPagesPerRegion ?? SECURITY_EVENT_MAX_PAGES_PER_REGION,
    1,
    SECURITY_EVENT_MAX_PAGES_PER_REGION,
  );
  const overallDeadlineMs = boundedInteger(
    options.overallDeadlineMs ?? SECURITY_EVENT_OVERALL_DEADLINE_MS,
    1,
    SECURITY_EVENT_OVERALL_DEADLINE_MS,
  );
  const commandDeadlineMs = boundedInteger(
    options.commandDeadlineMs ?? SECURITY_EVENT_COMMAND_DEADLINE_MS,
    1,
    SECURITY_EVENT_COMMAND_DEADLINE_MS,
  );
  assertCollectionInput(options, now);
  const readerFactory = options.readerFactory ?? createCloudTrailLookupReader;
  const eventMap = new Map<string, NormalizedSecurityEvent>();
  const coverage: SecurityEventRegionCoverage[] = [];
  let outputTruncated = false;
  const regions = [...new Set(options.regions)].sort();
  const overallController = new AbortController();
  const forwardAbort = () => overallController.abort(options.abortSignal?.reason);
  if (options.abortSignal?.aborted === true) forwardAbort();
  else options.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const overallTimer = setTimeout(
    () => overallController.abort(new Error("Security-event collection deadline exceeded")),
    overallDeadlineMs,
  );
  overallTimer.unref?.();

  try {
    for (const region of regions) {
      if (overallController.signal.aborted) {
        coverage.push({
          region,
          status: "FAILED",
          pagesObserved: 0,
          eventsObserved: 0,
          eventsDropped: 0,
          errorCode: "COLLECTION_TIMEOUT",
        });
        continue;
      }
    if (eventMap.size >= maximumEvents) {
      outputTruncated = true;
      coverage.push({
        region,
        status: "PARTIAL",
        pagesObserved: 0,
        eventsObserved: 0,
        eventsDropped: 0,
        errorCode: "ITEM_LIMIT_REACHED",
      });
      continue;
    }

    const reader = readerFactory(region, options.credentials);
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();
    let pagesObserved = 0;
    let eventsObserved = 0;
    let eventsDropped = 0;
    let status: SecurityEventCoverageStatus = "SUCCEEDED";
    let errorCode: string | null = null;

    try {
      for (let page = 0; page < maximumPages; page += 1) {
        const output = await lookupWithDeadline(
          reader,
          {
            StartTime: options.windowStart,
            EndTime: options.windowEnd,
            MaxResults: LOOKUP_PAGE_SIZE,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
          },
          overallController.signal,
          commandDeadlineMs,
        );
        pagesObserved += 1;
        for (const candidate of output.Events ?? []) {
          const normalized = normalizeLookupEvent(
            candidate,
            options.accountId,
            region,
            options.windowStart,
            options.windowEnd,
          );
          if (normalized === null) {
            eventsDropped += 1;
            status = "PARTIAL";
            errorCode ??= "NORMALIZATION_DROPPED";
            continue;
          }
          if (normalized.detailStatus === "UNAVAILABLE") {
            status = "PARTIAL";
            errorCode ??= "DETECTION_DETAIL_UNAVAILABLE";
          }
          eventsObserved += 1;
          if (eventMap.has(normalized.providerEventId)) continue;
          if (eventMap.size >= maximumEvents) {
            outputTruncated = true;
            eventsDropped += 1;
            status = "PARTIAL";
            errorCode = "ITEM_LIMIT_REACHED";
            continue;
          }
          eventMap.set(normalized.providerEventId, normalized);
        }

        const token = parseNextToken(output.NextToken);
        if (token.kind === "end") {
          nextToken = undefined;
          break;
        }
        if (token.kind === "invalid") {
          status = "PARTIAL";
          errorCode = "PAGINATION_TOKEN_INVALID";
          break;
        }
        if (seenTokens.has(token.value)) {
          status = "PARTIAL";
          errorCode = "PAGINATION_TOKEN_REPEATED";
          break;
        }
        seenTokens.add(token.value);
        nextToken = token.value;
        if (page === maximumPages - 1) {
          outputTruncated = true;
          status = "PARTIAL";
          errorCode = "PAGE_LIMIT_REACHED";
        }
      }
    } catch (error) {
      status = "FAILED";
      errorCode = overallController.signal.aborted
        ? "COLLECTION_TIMEOUT"
        : publicLookupErrorCode(error);
    }

    coverage.push({ region, status, pagesObserved, eventsObserved, eventsDropped, errorCode });
    }
  } finally {
    clearTimeout(overallTimer);
    options.abortSignal?.removeEventListener("abort", forwardAbort);
  }

  const events = [...eventMap.values()].sort(compareEvents);
  const derived = deriveSecurityEventDetections(events);
  const detections = derived.slice(0, SECURITY_EVENT_MAX_DETECTIONS);
  const detectionTruncated = derived.length > detections.length;
  const failedRegions = coverage.filter((entry) => entry.status === "FAILED").length;
  const status: SecurityEventCollectionStatus =
    failedRegions === coverage.length && events.length === 0
      ? "UNAVAILABLE"
      : coverage.every((entry) => entry.status === "SUCCEEDED") && !outputTruncated && !detectionTruncated
        ? "COMPLETE"
        : "PARTIAL";
  const limitations = [
    "LOOKUP_EVENTS_MANAGEMENT_EVENTS_ONLY",
    "LOOKUP_EVENTS_PROVIDER_HISTORY_LIMIT_APPLIES",
    "RAW_CLOUDTRAIL_EVENT_NOT_RETAINED",
    ...(outputTruncated ? ["EVENT_OUTPUT_LIMIT_REACHED"] : []),
    ...(detectionTruncated ? ["DETECTION_OUTPUT_LIMIT_REACHED"] : []),
    ...(coverage.some((entry) => entry.status !== "SUCCEEDED") ? ["REGIONAL_COVERAGE_INCOMPLETE"] : []),
  ];

  return {
    schemaVersion: "sutra.security-events.v1",
    source: "AWS_CLOUDTRAIL_LOOKUP_EVENTS",
    status,
    accountId: options.accountId,
    collectedAt: now.toISOString(),
    windowStart: options.windowStart.toISOString(),
    windowEnd: options.windowEnd.toISOString(),
    retentionDays: SECURITY_EVENT_RETENTION_DAYS,
    coverage,
    events,
    detections,
    limitations,
  };
}

function createCloudTrailLookupReader(
  region: string,
  credentials: AwsTemporaryCredentials,
): CloudTrailLookupReader {
  const client = new CloudTrailClient({
    ...workloadIdentityAwsClientConfig(region, 3),
    credentials,
  });
  return {
    lookupEvents: (input, abortSignal) => client.send(
      new LookupEventsCommand(input),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
  };
}

function assertCollectionInput(options: SecurityEventCollectionOptions, now: Date): void {
  if (!/^\d{12}$/u.test(options.accountId)) throw new TypeError("AWS account ID is invalid");
  if (options.regions.length === 0 || options.regions.length > 32) {
    throw new TypeError("Security-event region scope is invalid");
  }
  if (new Set(options.regions).size !== options.regions.length || options.regions.some((region) => !validRegion(region, options.partition))) {
    throw new TypeError("Security-event region scope is invalid");
  }
  const start = options.windowStart.getTime();
  const end = options.windowEnd.getTime();
  if (
    !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
    end - start > SECURITY_EVENT_MAX_LOOKBACK_MS || end > now.getTime() + 60_000
  ) {
    throw new TypeError("Security-event collection window is invalid");
  }
}

function validRegion(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return /^cn-(?:north|northwest)-[1-9]\d?$/u.test(region);
  if (partition === "aws-us-gov") return /^us-gov-(?:east|west)-[1-9]\d?$/u.test(region);
  return /^[a-z]{2}-[a-z0-9-]+-[1-9]\d?$/u.test(region) &&
    !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("Security-event collection limit is invalid");
  }
  return value;
}

function parseNextToken(value: string | undefined):
  | { readonly kind: "end" }
  | { readonly kind: "invalid" }
  | { readonly kind: "token"; readonly value: string } {
  if (value === undefined) return { kind: "end" };
  if (value.length === 0) return { kind: "invalid" };
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) return { kind: "invalid" };
  return { kind: "token", value };
}

async function lookupWithDeadline(
  reader: CloudTrailLookupReader,
  input: LookupEventsCommandInput,
  overallSignal: AbortSignal,
  commandDeadlineMs: number,
): Promise<Pick<LookupEventsCommandOutput, "Events" | "NextToken">> {
  if (overallSignal.aborted) throw overallSignal.reason;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(overallSignal.reason);
  overallSignal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(Object.assign(
      new Error("CloudTrail LookupEvents command deadline exceeded"),
      { name: "TimeoutError" },
    )),
    commandDeadlineMs,
  );
  timer.unref?.();
  try {
    return await raceAbortable(reader.lookupEvents(input, controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", forwardAbort);
  }
}

function raceAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function normalizeLookupEvent(
  event: CloudTrailLookupEvent,
  accountId: string,
  region: string,
  windowStart: Date,
  windowEnd: Date,
): NormalizedSecurityEvent | null {
  const providerEventId = safeRequiredText(event.EventId, 128);
  const eventName = safeRequiredText(event.EventName, 128);
  const eventSource = safeRequiredText(event.EventSource, 256);
  const eventTime = event.EventTime;
  if (providerEventId === null || eventName === null || eventSource === null || !(eventTime instanceof Date)) return null;
  const eventMillis = eventTime.getTime();
  if (!Number.isFinite(eventMillis) || eventMillis < windowStart.getTime() || eventMillis > windowEnd.getTime()) return null;

  const detail = parseCloudTrailDetail(event.CloudTrailEvent);
  const recipientAccountId = safeOptionalText(detail?.recipientAccountId, 12);
  const detailRegion = safeOptionalText(detail?.awsRegion, 64);
  if ((recipientAccountId !== null && recipientAccountId !== accountId) || (detailRegion !== null && detailRegion !== region)) return null;
  const identity = record(detail?.userIdentity);
  const additional = record(detail?.additionalEventData);
  const sessionContext = record(identity?.sessionContext);
  const sessionAttributes = record(sessionContext?.attributes);
  const responseElements = record(detail?.responseElements);
  const consoleLoginResult = responseElements?.ConsoleLogin === "Success" || responseElements?.ConsoleLogin === "Failure"
    ? responseElements.ConsoleLogin
    : null;
  const mfaUsed = yesNoBoolean(additional?.MFAUsed) ?? booleanText(sessionAttributes?.mfaAuthenticated);
  const resources = (event.Resources ?? []).slice(0, 10).map((resource) => ({
    type: safeOptionalText(resource.ResourceType, 256),
    name: safeOptionalText(resource.ResourceName, 512),
  }));

  return {
    schemaVersion: "sutra.security-event.v1",
    providerEventId,
    accountId,
    region,
    eventTime: eventTime.toISOString(),
    eventName,
    eventSource,
    readOnly: booleanText(event.ReadOnly) ?? booleanText(detail?.readOnly),
    managementEvent: typeof detail?.managementEvent === "boolean" ? detail.managementEvent : null,
    eventCategory: safeOptionalText(detail?.eventCategory, 64),
    username: safeOptionalText(event.Username, 256),
    identityType: safeOptionalText(identity?.type, 64),
    principalArn: safeOptionalText(identity?.arn, 2_048),
    sourceIp: safeOptionalText(detail?.sourceIPAddress, 128),
    userAgent: safeOptionalText(detail?.userAgent, 512),
    errorCode: safeOptionalText(detail?.errorCode, 128),
    requestId: safeOptionalText(detail?.requestID, 256),
    consoleLoginResult,
    mfaUsed,
    detailStatus: detail === null ? "UNAVAILABLE" : "AVAILABLE",
    resources,
  };
}

function parseCloudTrailDetail(value: string | undefined): Record<string, unknown> | null {
  if (value === undefined || value.length === 0 || value.length > 256 * 1_024) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return record(parsed);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeRequiredText(value: unknown, maximum: number): string | null {
  const text = safeOptionalText(value, maximum);
  return text === null || text.length === 0 ? null : text;
}

function safeOptionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return sanitized.length === 0 ? null : sanitized.slice(0, maximum);
}

function yesNoBoolean(value: unknown): boolean | null {
  if (value === "Yes" || value === "YES") return true;
  if (value === "No" || value === "NO") return false;
  return null;
}

function booleanText(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function compareEvents(left: NormalizedSecurityEvent, right: NormalizedSecurityEvent): number {
  return left.eventTime.localeCompare(right.eventTime) || left.providerEventId.localeCompare(right.providerEventId);
}

export function deriveSecurityEventDetections(
  events: readonly NormalizedSecurityEvent[],
): SecurityEventDetection[] {
  const sorted = [...events].sort(compareEvents);
  const detections: SecurityEventDetection[] = [];
  for (const event of sorted) {
    if (
      event.eventName === "ConsoleLogin" &&
      (event.consoleLoginResult === "Failure" || event.errorCode !== null)
    ) {
      detections.push(singleEventDetection({
        event,
        ruleKey: "SUTRA.EVENT.CONSOLE_LOGIN_FAILURE",
        severity: "medium",
        title: "AWS console login failed",
        summary: "CloudTrail recorded an unsuccessful AWS Management Console sign-in.",
        evidence: {
          eventName: event.eventName,
          errorCode: event.errorCode ?? "ConsoleLoginFailure",
          sourceIp: event.sourceIp ?? "unknown",
          principal: event.principalArn ?? event.username ?? "unknown",
        },
        limitation: "A failed sign-in is not proof of malicious activity; validate identity, source, and surrounding events.",
      }));
    }
    if (
      event.eventName === "ConsoleLogin" && event.consoleLoginResult === "Success" &&
      event.identityType === "Root" && event.mfaUsed === false
    ) {
      detections.push(singleEventDetection({
        event,
        ruleKey: "SUTRA.EVENT.ROOT_CONSOLE_LOGIN_NO_MFA",
        severity: "high",
        title: "Root console login without MFA",
        summary: "CloudTrail recorded a successful root-user console sign-in whose normalized MFA evidence is false.",
        evidence: { eventName: event.eventName, identityType: "Root", mfaUsed: false, sourceIp: event.sourceIp ?? "unknown" },
        limitation: "This detection depends on CloudTrail MFA fields being present and correctly emitted for the sign-in event.",
      }));
    }
    if (event.eventSource === "cloudtrail.amazonaws.com" && CLOUDTRAIL_CHANGE_EVENTS.has(event.eventName)) {
      detections.push(singleEventDetection({
        event,
        ruleKey: "SUTRA.EVENT.CLOUDTRAIL_CONFIGURATION_CHANGE",
        severity: event.eventName === "StopLogging" || event.eventName === "DeleteTrail" ? "critical" : "high",
        title: "CloudTrail configuration changed",
        summary: `CloudTrail recorded ${event.eventName}, an operation that can change audit-event collection or retention.`,
        evidence: { eventName: event.eventName, principal: event.principalArn ?? event.username ?? "unknown", sourceIp: event.sourceIp ?? "unknown" },
        limitation: "The event name identifies a change request; inspect AWS configuration and authorization context to determine impact.",
      }));
    }
  }
  detections.push(...accessDeniedBurstDetections(sorted));
  return detections.sort((left, right) =>
    left.firstEventAt.localeCompare(right.firstEventAt) || left.detectionId.localeCompare(right.detectionId)
  );
}

function singleEventDetection(input: {
  readonly event: NormalizedSecurityEvent;
  readonly ruleKey: string;
  readonly severity: SecurityDetectionSeverity;
  readonly title: string;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly limitation: string;
}): SecurityEventDetection {
  return {
    detectionId: detectionId(input.ruleKey, input.event.providerEventId),
    ruleKey: input.ruleKey,
    ruleVersion: "1.0.0",
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    firstEventAt: input.event.eventTime,
    lastEventAt: input.event.eventTime,
    eventIds: [input.event.providerEventId],
    evidence: input.evidence,
    limitation: input.limitation,
  };
}

function accessDeniedBurstDetections(
  events: readonly NormalizedSecurityEvent[],
): SecurityEventDetection[] {
  const grouped = new Map<string, NormalizedSecurityEvent[]>();
  for (const event of events) {
    if (event.errorCode === null || !/(?:AccessDenied|Unauthorized|AuthFailure)/iu.test(event.errorCode)) continue;
    const principal = event.principalArn ?? event.username;
    if (principal === null && event.sourceIp === null) continue;
    const key = `${principal ?? "unknown"}\u0000${event.sourceIp ?? "unknown"}`;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  const results: SecurityEventDetection[] = [];
  for (const [key, group] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = group.sort(compareEvents);
    let left = 0;
    while (left < ordered.length) {
      let right = left;
      const start = Date.parse(ordered[left]!.eventTime);
      while (
        right + 1 < ordered.length &&
        Date.parse(ordered[right + 1]!.eventTime) - start <= ACCESS_DENIED_BURST_WINDOW_MS
      ) right += 1;
      const burst = ordered.slice(left, right + 1);
      if (burst.length >= ACCESS_DENIED_BURST_THRESHOLD) {
        const [principal, sourceIp] = key.split("\u0000") as [string, string];
        const eventIds = burst.map((event) => event.providerEventId);
        results.push({
          detectionId: detectionId("SUTRA.EVENT.ACCESS_DENIED_BURST", `${key}:${eventIds[0]}`),
          ruleKey: "SUTRA.EVENT.ACCESS_DENIED_BURST",
          ruleVersion: "1.0.0",
          severity: burst.length >= 10 ? "high" : "medium",
          title: "Repeated AWS access denials",
          summary: `${burst.length} authorization failures were observed for the same normalized principal and source within ten minutes.`,
          firstEventAt: burst[0]!.eventTime,
          lastEventAt: burst.at(-1)!.eventTime,
          eventIds,
          evidence: { eventCount: burst.length, principal, sourceIp, windowSeconds: Math.round((Date.parse(burst.at(-1)!.eventTime) - start) / 1_000) },
          limitation: "Repeated denials can result from a broken deployment or stale permissions; this rule does not establish hostile intent.",
        });
        left = right + 1;
      } else {
        left += 1;
      }
    }
  }
  return results;
}

function detectionId(ruleKey: string, identity: string): string {
  return `sed_${createHash("sha256").update(`${ruleKey}\u0000${identity}`, "utf8").digest("hex").slice(0, 48)}`;
}

function publicLookupErrorCode(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "UnknownError";
  if (new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "UnrecognizedClientException"]).has(name)) return "ACCESS_DENIED";
  if (new Set(["Throttling", "ThrottlingException", "TooManyRequestsException"]).has(name)) return "THROTTLED";
  if (new Set(["TimeoutError", "RequestTimeout", "RequestTimeoutException", "AbortError"]).has(name)) return "TIMEOUT";
  return "LOOKUP_FAILED";
}
