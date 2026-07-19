import type {
  AwsSecurityEventCollection,
  NormalizedSecurityEvent,
  SecurityEventDetection,
  SecurityEventRegionCoverage,
} from "./security-event-types.ts";

const MAX_EVENTS = 2_000;
const MAX_DETECTIONS = 200;
const MAX_COVERAGE = 32;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

export class SecurityEventBoundaryError extends Error {
  public readonly code = "BROKER_RESPONSE_INVALID";

  public constructor() {
    super("The collector returned security-event data that failed Sutra validation");
    this.name = "SecurityEventBoundaryError";
  }
}

function invalid(): never {
  throw new SecurityEventBoundaryError();
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  return record;
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  ) invalid();
  return value;
}

function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}

function timestamp(value: unknown): string {
  const parsed = text(value, 40);
  const millis = Date.parse(parsed);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== parsed || millis > Date.now() + 300_000) invalid();
  return parsed;
}

function safeInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid();
  return value as number;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  return invalid();
}

function resources(value: unknown): NormalizedSecurityEvent["resources"] {
  if (!Array.isArray(value) || value.length > 10) invalid();
  return value.map((item) => {
    const parsed = exactRecord(item, ["type", "name"]);
    return { type: nullableText(parsed.type, 256), name: nullableText(parsed.name, 512) };
  });
}

function event(value: unknown, accountId: string, regions: ReadonlySet<string>, start: number, end: number): NormalizedSecurityEvent {
  const parsed = exactRecord(value, [
    "schemaVersion", "providerEventId", "accountId", "region", "eventTime", "eventName", "eventSource",
    "readOnly", "managementEvent", "eventCategory", "username", "identityType", "principalArn", "sourceIp",
    "userAgent", "errorCode", "requestId", "consoleLoginResult", "mfaUsed", "detailStatus", "resources",
  ]);
  if (parsed.schemaVersion !== "sutra.security-event.v1" || parsed.accountId !== accountId) invalid();
  const region = text(parsed.region, 64);
  if (!regions.has(region)) invalid();
  const eventTime = timestamp(parsed.eventTime);
  const millis = Date.parse(eventTime);
  if (millis < start || millis > end) invalid();
  if (parsed.consoleLoginResult !== null && parsed.consoleLoginResult !== "Success" && parsed.consoleLoginResult !== "Failure") invalid();
  if (parsed.detailStatus !== "AVAILABLE" && parsed.detailStatus !== "UNAVAILABLE") invalid();
  return {
    schemaVersion: "sutra.security-event.v1",
    providerEventId: text(parsed.providerEventId, 128),
    accountId,
    region,
    eventTime,
    eventName: text(parsed.eventName, 128),
    eventSource: text(parsed.eventSource, 256),
    readOnly: nullableBoolean(parsed.readOnly),
    managementEvent: nullableBoolean(parsed.managementEvent),
    eventCategory: nullableText(parsed.eventCategory, 64),
    username: nullableText(parsed.username, 256),
    identityType: nullableText(parsed.identityType, 64),
    principalArn: nullableText(parsed.principalArn, 2_048),
    sourceIp: nullableText(parsed.sourceIp, 128),
    userAgent: nullableText(parsed.userAgent, 512),
    errorCode: nullableText(parsed.errorCode, 128),
    requestId: nullableText(parsed.requestId, 256),
    consoleLoginResult: parsed.consoleLoginResult as "Success" | "Failure" | null,
    mfaUsed: nullableBoolean(parsed.mfaUsed),
    detailStatus: parsed.detailStatus,
    resources: resources(parsed.resources),
  };
}

function evidence(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 12) invalid();
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key)) invalid();
    if (typeof item === "string") result[key] = text(item, 512);
    else if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (typeof item === "boolean") result[key] = item;
    else invalid();
  }
  return result;
}

function detection(value: unknown, eventIds: ReadonlySet<string>, start: number, end: number): SecurityEventDetection {
  const parsed = exactRecord(value, [
    "detectionId", "ruleKey", "ruleVersion", "severity", "title", "summary", "firstEventAt", "lastEventAt",
    "eventIds", "evidence", "limitation",
  ]);
  if (
    parsed.ruleVersion !== "1.0.0" ||
    !new Set(["critical", "high", "medium", "low"]).has(parsed.severity as string) ||
    !Array.isArray(parsed.eventIds) || parsed.eventIds.length === 0 || parsed.eventIds.length > 50
  ) invalid();
  const referenced = parsed.eventIds.map((item) => text(item, 128));
  if (new Set(referenced).size !== referenced.length || referenced.some((item) => !eventIds.has(item))) invalid();
  const firstEventAt = timestamp(parsed.firstEventAt);
  const lastEventAt = timestamp(parsed.lastEventAt);
  if (Date.parse(firstEventAt) < start || Date.parse(lastEventAt) > end || firstEventAt > lastEventAt) invalid();
  return {
    detectionId: text(parsed.detectionId, 64),
    ruleKey: text(parsed.ruleKey, 128),
    ruleVersion: "1.0.0",
    severity: parsed.severity as SecurityEventDetection["severity"],
    title: text(parsed.title, 200),
    summary: text(parsed.summary, 1_000),
    firstEventAt,
    lastEventAt,
    eventIds: referenced,
    evidence: evidence(parsed.evidence),
    limitation: text(parsed.limitation, 1_000),
  };
}

function coverageEntry(value: unknown): SecurityEventRegionCoverage {
  const parsed = exactRecord(value, ["region", "status", "pagesObserved", "eventsObserved", "eventsDropped", "errorCode"]);
  if (!new Set(["SUCCEEDED", "PARTIAL", "FAILED"]).has(parsed.status as string)) invalid();
  return {
    region: text(parsed.region, 64),
    status: parsed.status as SecurityEventRegionCoverage["status"],
    pagesObserved: safeInteger(parsed.pagesObserved, 3),
    eventsObserved: safeInteger(parsed.eventsObserved, MAX_EVENTS),
    eventsDropped: safeInteger(parsed.eventsDropped, MAX_EVENTS * 2),
    errorCode: nullableText(parsed.errorCode, 96),
  };
}

export function parseAwsSecurityEventCollection(
  value: unknown,
  expectedAccountId: string,
): AwsSecurityEventCollection {
  const parsed = exactRecord(value, [
    "schemaVersion", "source", "status", "accountId", "collectedAt", "windowStart", "windowEnd",
    "retentionDays", "coverage", "events", "detections", "limitations",
  ]);
  if (
    parsed.schemaVersion !== "sutra.security-events.v1" ||
    parsed.source !== "AWS_CLOUDTRAIL_LOOKUP_EVENTS" ||
    parsed.accountId !== expectedAccountId ||
    !new Set(["COMPLETE", "PARTIAL", "UNAVAILABLE"]).has(parsed.status as string) ||
    parsed.retentionDays !== 30 ||
    !Array.isArray(parsed.coverage) || parsed.coverage.length === 0 || parsed.coverage.length > MAX_COVERAGE ||
    !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS ||
    !Array.isArray(parsed.detections) || parsed.detections.length > MAX_DETECTIONS ||
    !Array.isArray(parsed.limitations) || parsed.limitations.length > 12
  ) invalid();
  const windowStart = timestamp(parsed.windowStart);
  const windowEnd = timestamp(parsed.windowEnd);
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (start >= end || end - start > MAX_LOOKBACK_MS) invalid();
  const coverage = parsed.coverage.map(coverageEntry);
  if (new Set(coverage.map((item) => item.region)).size !== coverage.length) invalid();
  const regions = new Set(coverage.map((item) => item.region));
  const events = parsed.events.map((item) => event(item, expectedAccountId, regions, start, end));
  const eventIds = new Set(events.map((item) => item.providerEventId));
  if (eventIds.size !== events.length) invalid();
  const detections = parsed.detections.map((item) => detection(item, eventIds, start, end));
  if (new Set(detections.map((item) => item.detectionId)).size !== detections.length) invalid();
  if (parsed.status === "COMPLETE" && coverage.some((item) => item.status !== "SUCCEEDED")) invalid();
  if (parsed.status === "COMPLETE" && events.some((item) => item.detailStatus === "UNAVAILABLE")) invalid();
  if (parsed.status === "UNAVAILABLE" && (events.length > 0 || coverage.some((item) => item.status === "SUCCEEDED"))) invalid();
  return {
    schemaVersion: "sutra.security-events.v1",
    source: "AWS_CLOUDTRAIL_LOOKUP_EVENTS",
    status: parsed.status as AwsSecurityEventCollection["status"],
    accountId: expectedAccountId,
    collectedAt: timestamp(parsed.collectedAt),
    windowStart,
    windowEnd,
    retentionDays: 30,
    coverage,
    events,
    detections,
    limitations: parsed.limitations.map((item) => text(item, 160)),
  };
}
