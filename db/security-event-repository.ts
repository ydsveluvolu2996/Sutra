import { canonicalJson } from "../lib/canonical-json";
import { parseAwsSecurityEventCollection } from "../lib/security-event-boundary";
import type {
  AwsSecurityEventCollection,
  NormalizedSecurityEventResource,
  SecurityEventRegionCoverage,
  SecurityEventRun,
  SecurityEventsWorkspace,
  SecurityEventSourceState,
  StoredSecurityDetection,
  StoredSecurityEvent,
} from "../lib/security-event-types";
import { resolveSecurityEventWindow, type SecurityEventWindowBasis } from "../lib/security-event-window";
import { getRawDb } from "./index";
import { commitAuditedStatements } from "./pilot-repository";
import { ensureRuntimeSchema } from "./runtime-migrations";

const DEFAULT_LOOKBACK_HOURS = 1;
const DEFAULT_OVERLAP_MINUTES = 5;
const MAX_QUERY_LIMIT = 200;

interface SourceRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  source: string;
  status: string;
  retention_days: number;
  lookback_hours: number;
  overlap_minutes: number;
  last_window_start: number | null;
  last_window_end: number | null;
  last_collected_at: number | null;
  last_run_id: string | null;
  last_error_code: string | null;
  updated_at: number;
}

interface RunRow {
  id: string;
  status: string;
  window_start: number;
  window_end: number;
  collected_at: number;
  finished_at: number;
  coverage_json: string;
  events_observed: number;
  events_inserted: number;
  duplicate_events: number;
  detections_observed: number;
  payload_sha256: string;
}

interface EventRow {
  provider_event_id: string;
  account_id: string;
  region_key: string;
  event_time: number;
  event_name: string;
  event_source: string;
  read_only: number | null;
  management_event: number | null;
  event_category: string | null;
  username: string | null;
  identity_type: string | null;
  principal_arn: string | null;
  source_ip: string | null;
  user_agent: string | null;
  error_code: string | null;
  request_id: string | null;
  console_login_result: string | null;
  mfa_used: number | null;
  detail_status: string;
  resources_json: string;
  ingested_at: number;
  source_run_id: string;
}

interface DetectionRow {
  id: string;
  source_run_id: string;
  rule_key: string;
  rule_version: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  first_event_at: number;
  last_event_at: number;
  event_ids_json: string;
  evidence_json: string;
  limitation: string;
  note: string | null;
  actor_id: string | null;
  updated_at: number;
}

interface CountRow {
  count: number | string;
}

interface WindowRunRow {
  status: string;
  window_start: number;
}

export interface SecurityEventCollectionWindow {
  readonly start: Date;
  readonly end: Date;
  readonly requestedStart: Date;
  readonly basis: SecurityEventWindowBasis;
  readonly overlapMinutes: number;
  readonly gapTruncated: boolean;
}

export interface SecurityEventQuery {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly search?: string;
  readonly region?: string;
  readonly eventName?: string;
  readonly limit?: number;
}

export async function securityEventCollectionWindow(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly now?: Date;
}): Promise<SecurityEventCollectionWindow> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const now = input.now ?? new Date();
  const source = await sourceRow(db, input.orgId, input.customerId, input.connectionId);
  const latestAttempt = await db.prepare(
    `SELECT status, window_start
       FROM security_event_runs
      WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        AND status <> 'PERSISTING'
      ORDER BY collected_at DESC, id DESC LIMIT 1`,
  ).bind(input.orgId, input.customerId, input.connectionId).first<WindowRunRow>();
  const lookbackHours = source?.lookback_hours ?? DEFAULT_LOOKBACK_HOURS;
  const overlapMinutes = source?.overlap_minutes ?? DEFAULT_OVERLAP_MINUTES;
  const resolved = resolveSecurityEventWindow({
    nowMillis: now.getTime(),
    lookbackHours,
    overlapMinutes,
    completeCheckpointEndMillis: source?.last_window_end ?? null,
    latestAttempt: latestAttempt === null
      ? null
      : {
          status: latestAttempt.status as AwsSecurityEventCollection["status"],
          windowStartMillis: Number(latestAttempt.window_start),
        },
  });
  return {
    start: new Date(resolved.startMillis),
    end: new Date(resolved.endMillis),
    requestedStart: new Date(resolved.requestedStartMillis),
    basis: resolved.basis,
    overlapMinutes: resolved.overlapMinutes,
    gapTruncated: resolved.gapTruncated,
  };
}

export async function persistSecurityEventCollection(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly actorId: string;
  readonly windowBasis: SecurityEventWindowBasis;
  readonly overlapMinutes: number;
  readonly gapTruncated: boolean;
  readonly payload: AwsSecurityEventCollection;
}): Promise<SecurityEventRun> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const payload = parseAwsSecurityEventCollection(input.payload, input.payload.accountId);
  const payloadJson = canonicalJson(payload);
  if (payloadJson.length > 4 * 1_024 * 1_024) throw new Error("The normalized security-event payload exceeds its persistence limit");
  const payloadSha256 = await sha256Hex(payloadJson);
  const runId = `serun_${crypto.randomUUID().replaceAll("-", "")}`;
  const sourceId = `sesrc_${(await sha256Hex(`${input.orgId}\u0000${input.connectionId}`)).slice(0, 48)}`;
  const collectedAt = Date.parse(payload.collectedAt);
  const windowStart = Date.parse(payload.windowStart);
  const windowEnd = Date.parse(payload.windowEnd);
  const finishedAt = Date.now();
  const lastErrorCode = payload.coverage.find((entry) => entry.status !== "SUCCEEDED")?.errorCode ??
    (payload.limitations.includes("CHECKPOINT_GAP_TRUNCATED_TO_24_HOURS")
      ? "CHECKPOINT_GAP_TRUNCATED_TO_24_HOURS"
      : null);

  const sourceInsert = await db.prepare(
    `INSERT OR IGNORE INTO security_event_sources
      (id, org_id, customer_id, connection_id, source, status, retention_days,
       lookback_hours, overlap_minutes, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'aws_cloudtrail_lookup_events', 'NOT_COLLECTED', 30, 1, 5, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM aws_connections
         WHERE id = ? AND org_id = ? AND customer_id = ?
           AND aws_account_id = ? AND source_kind = 'aws_trust_role'
      )`,
  ).bind(
    sourceId, input.orgId, input.customerId, input.connectionId, finishedAt, finishedAt,
    input.connectionId, input.orgId, input.customerId, payload.accountId,
  ).run();
  void sourceInsert;
  const source = await sourceRow(db, input.orgId, input.customerId, input.connectionId);
  if (source === null) throw new Error("The scoped security-event source could not be initialized");

  const runInsert = await db.prepare(
    `INSERT INTO security_event_runs
      (id, org_id, customer_id, connection_id, source, status, window_start,
       window_end, collected_at, finished_at, coverage_json, events_observed,
       events_inserted, duplicate_events, detections_observed, payload_sha256)
     SELECT ?, ?, ?, ?, 'aws_cloudtrail_lookup_events', 'PERSISTING', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM security_event_sources
         WHERE org_id = ? AND customer_id = ? AND connection_id = ?
      )`,
  ).bind(
    runId, input.orgId, input.customerId, input.connectionId,
    windowStart, windowEnd, collectedAt, finishedAt, JSON.stringify(payload.coverage),
    payload.events.length, payload.detections.length, payloadSha256,
    input.orgId, input.customerId, input.connectionId,
  ).run();
  if ((runInsert.meta?.changes ?? 0) !== 1) throw new Error("The scoped security-event run could not be persisted");

  let inserted = 0;
  const eventStatements = await Promise.all(payload.events.map(async (event) => db.prepare(
    `INSERT OR IGNORE INTO security_events
      (id, org_id, customer_id, connection_id, source_run_id, provider_event_id,
       account_id, region_key, event_time, event_name, event_source, read_only,
       management_event, event_category, username, identity_type, principal_arn,
       source_ip, user_agent, error_code, request_id, console_login_result,
       mfa_used, detail_status, resources_json, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `sevt_${(await sha256Hex(`${input.connectionId}\u0000${event.providerEventId}`)).slice(0, 48)}`,
    input.orgId, input.customerId, input.connectionId, runId, event.providerEventId,
    event.accountId, event.region, Date.parse(event.eventTime), event.eventName,
    event.eventSource, booleanInt(event.readOnly), booleanInt(event.managementEvent),
    event.eventCategory, event.username, event.identityType, event.principalArn,
    event.sourceIp, event.userAgent, event.errorCode, event.requestId,
    event.consoleLoginResult, booleanInt(event.mfaUsed), event.detailStatus,
    JSON.stringify(event.resources), finishedAt,
  )));
  for (const group of chunks(eventStatements, 50)) {
    const results = await db.batch(group);
    inserted += results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
  }
  for (const group of chunks(payload.events, 50)) {
    await db.batch(group.map((event) => db.prepare(
      `UPDATE security_events
          SET source_run_id = ?, ingested_at = ?
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND provider_event_id = ?
          AND EXISTS (
            SELECT 1 FROM security_event_runs r
             WHERE r.id = security_events.source_run_id AND r.org_id = security_events.org_id
               AND r.connection_id = security_events.connection_id AND r.status = 'PERSISTING'
          )`,
    ).bind(
      runId, finishedAt, input.orgId, input.customerId, input.connectionId,
      event.providerEventId,
    )));
  }

  const detectionStatements = await Promise.all(payload.detections.map(async (detection) => db.prepare(
    `INSERT OR IGNORE INTO security_event_detections
      (id, org_id, customer_id, connection_id, source_run_id, rule_key,
       rule_version, severity, status, title, summary, first_event_at,
       last_event_at, event_ids_json, evidence_json, limitation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `sdet_${(await sha256Hex(`${input.connectionId}\u0000${detection.detectionId}`)).slice(0, 48)}`,
    input.orgId, input.customerId, input.connectionId, runId, detection.ruleKey,
    detection.ruleVersion, detection.severity, detection.title, detection.summary,
    Date.parse(detection.firstEventAt), Date.parse(detection.lastEventAt),
    JSON.stringify(detection.eventIds), JSON.stringify(detection.evidence),
    detection.limitation, finishedAt, finishedAt,
  )));
  for (const group of chunks(detectionStatements, 50)) await db.batch(group);
  for (const group of chunks(payload.detections, 50)) {
    await db.batch(await Promise.all(group.map(async (detection) => db.prepare(
      `UPDATE security_event_detections
          SET source_run_id = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND EXISTS (
            SELECT 1 FROM security_event_runs r
             WHERE r.id = security_event_detections.source_run_id
               AND r.org_id = security_event_detections.org_id
               AND r.connection_id = security_event_detections.connection_id
               AND r.status = 'PERSISTING'
          )`,
    ).bind(
      runId, finishedAt,
      `sdet_${(await sha256Hex(`${input.connectionId}\u0000${detection.detectionId}`)).slice(0, 48)}`,
      input.orgId, input.customerId, input.connectionId,
    ))));
  }

  const duplicateEvents = payload.events.length - inserted;
  const cutoff = finishedAt - payload.retentionDays * 24 * 60 * 60 * 1_000;
  const expectedCheckpointStart = payload.status === "COMPLETE" ? windowStart : source.last_window_start;
  const expectedCheckpointEnd = payload.status === "COMPLETE" ? windowEnd : source.last_window_end;
  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
      `UPDATE security_event_runs
          SET status = ?, events_inserted = ?, duplicate_events = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = 'PERSISTING'`,
      ).bind(payload.status, inserted, duplicateEvents, runId, input.orgId, input.customerId, input.connectionId),
      db.prepare(
      `UPDATE security_event_sources
          SET status = ?, retention_days = ?,
              last_window_start = CASE WHEN ? = 'COMPLETE' THEN ? ELSE last_window_start END,
              last_window_end = CASE WHEN ? = 'COMPLETE' THEN ? ELSE last_window_end END,
              last_collected_at = ?, last_run_id = ?, last_error_code = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND updated_at = ?`,
      ).bind(
        payload.status, payload.retentionDays,
        payload.status, windowStart, payload.status, windowEnd, collectedAt,
        runId, lastErrorCode, finishedAt, source.id, input.orgId, input.customerId,
        input.connectionId, source.updated_at,
      ),
      db.prepare(
      `DELETE FROM security_events
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND event_time < ?`,
      ).bind(input.orgId, input.customerId, input.connectionId, cutoff),
      db.prepare(
      `DELETE FROM security_event_detections
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND last_event_at < ?`,
      ).bind(input.orgId, input.customerId, input.connectionId, cutoff),
    ],
    audit: {
      actorId: input.actorId,
      action: "aws.security_events.collected",
      targetType: "security_event_run",
      targetId: runId,
      customerId: input.customerId,
      outcome: "allowed",
      requestId: `aws.security_events.collected:${runId}`,
      metadata: {
        connectionId: input.connectionId,
        source: payload.source,
        status: payload.status,
        windowStart: payload.windowStart,
        windowEnd: payload.windowEnd,
        eventsObserved: payload.events.length,
        eventsInserted: inserted,
        duplicateEvents,
        detectionsObserved: payload.detections.length,
        payloadSha256,
        collectionWindowBasis: input.windowBasis,
        overlapMinutes: input.overlapMinutes,
        gapTruncated: input.gapTruncated,
      },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM security_event_runs r
              JOIN security_event_sources s
                ON s.org_id = r.org_id AND s.customer_id = r.customer_id
               AND s.connection_id = r.connection_id
             WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ? AND r.connection_id = ?
               AND r.status = ? AND r.events_inserted = ? AND r.duplicate_events = ?
               AND r.payload_sha256 = ?
               AND s.id = ? AND s.status = ? AND s.last_run_id = ?
               AND s.last_collected_at = ? AND s.updated_at = ?
               AND ((s.last_window_start = ?) OR (s.last_window_start IS NULL AND ? IS NULL))
               AND ((s.last_window_end = ?) OR (s.last_window_end IS NULL AND ? IS NULL))
               AND ((s.last_error_code = ?) OR (s.last_error_code IS NULL AND ? IS NULL))`,
      values: [
        runId, input.orgId, input.customerId, input.connectionId,
        payload.status, inserted, duplicateEvents, payloadSha256,
        source.id, payload.status, runId, collectedAt, finishedAt,
        expectedCheckpointStart, expectedCheckpointStart,
        expectedCheckpointEnd, expectedCheckpointEnd,
        lastErrorCode, lastErrorCode,
      ],
    },
    persistenceMessage: "The security-event publication and its audit evidence could not be committed atomically",
  });

  const stored = await runRow(db, input.orgId, input.customerId, input.connectionId, runId);
  if (stored === null) throw new Error("The scoped security-event run could not be loaded");
  return toRun(stored);
}

export async function getSecurityEventsWorkspace(query: SecurityEventQuery): Promise<SecurityEventsWorkspace> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) throw new Error("Security-event query limit is invalid");
  const conditions = ["org_id = ?", "customer_id = ?", "connection_id = ?"];
  const bindings: unknown[] = [query.orgId, query.customerId, query.connectionId];
  if (query.region !== undefined) {
    conditions.push("region_key = ?");
    bindings.push(query.region);
  }
  if (query.eventName !== undefined) {
    conditions.push("event_name = ?");
    bindings.push(query.eventName);
  }
  if (query.search !== undefined && query.search.length > 0) {
    conditions.push(`LOWER(event_name || ' ' || event_source || ' ' || COALESCE(username, '') || ' ' || COALESCE(principal_arn, '') || ' ' || COALESCE(source_ip, '') || ' ' || COALESCE(error_code, '')) LIKE ? ESCAPE '\\'`);
    bindings.push(`%${escapeLike(query.search.toLocaleLowerCase("en-US"))}%`);
  }
  const publishedEventRun = `EXISTS (
    SELECT 1 FROM security_event_runs r
     WHERE r.id = security_events.source_run_id
       AND r.org_id = security_events.org_id
       AND r.connection_id = security_events.connection_id
       AND r.status <> 'PERSISTING'
  )`;
  const publishedDetectionRun = `EXISTS (
    SELECT 1 FROM security_event_runs r
     WHERE r.id = security_event_detections.source_run_id
       AND r.org_id = security_event_detections.org_id
       AND r.connection_id = security_event_detections.connection_id
       AND r.status <> 'PERSISTING'
  )`;
  const [
    source, latestRun, eventResult, detectionResult,
    totalEventRow, matchingEventRow, totalDetectionRow, openDetectionRow,
  ] = await Promise.all([
    sourceRow(db, query.orgId, query.customerId, query.connectionId),
    db.prepare(
      `SELECT id, status, window_start, window_end, collected_at, finished_at,
              coverage_json, events_observed, events_inserted, duplicate_events,
              detections_observed, payload_sha256
         FROM security_event_runs
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND status <> 'PERSISTING'
        ORDER BY collected_at DESC, id DESC LIMIT 1`,
    ).bind(query.orgId, query.customerId, query.connectionId).first<RunRow>(),
    db.prepare(
      `SELECT provider_event_id, account_id, region_key, event_time, event_name,
              event_source, read_only, management_event, event_category, username,
              identity_type, principal_arn, source_ip, user_agent, error_code,
              request_id, console_login_result, mfa_used, detail_status,
              resources_json, ingested_at, source_run_id
         FROM security_events
        WHERE ${conditions.join(" AND ")}
          AND ${publishedEventRun}
        ORDER BY event_time DESC, provider_event_id DESC LIMIT ?`,
    ).bind(...bindings, limit).all<EventRow>(),
    db.prepare(
      `SELECT id, source_run_id, rule_key, rule_version, severity, status, title,
              summary, first_event_at, last_event_at, event_ids_json, evidence_json,
              limitation, note, actor_id, updated_at
         FROM security_event_detections
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND ${publishedDetectionRun}
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 last_event_at DESC, id DESC LIMIT 100`,
    ).bind(query.orgId, query.customerId, query.connectionId).all<DetectionRow>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM security_events
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND ${publishedEventRun}`,
    ).bind(query.orgId, query.customerId, query.connectionId).first<CountRow>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM security_events
        WHERE ${conditions.join(" AND ")}
          AND ${publishedEventRun}`,
    ).bind(...bindings).first<CountRow>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM security_event_detections
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND ${publishedDetectionRun}`,
    ).bind(query.orgId, query.customerId, query.connectionId).first<CountRow>(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM security_event_detections
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND status = 'open' AND ${publishedDetectionRun}`,
    ).bind(query.orgId, query.customerId, query.connectionId).first<CountRow>(),
  ]);
  return {
    source: source === null ? null : toSource(source),
    latestRun: latestRun === null ? null : toRun(latestRun),
    counts: {
      totalEvents: countValue(totalEventRow),
      matchingEvents: countValue(matchingEventRow),
      totalDetections: countValue(totalDetectionRow),
      openDetections: countValue(openDetectionRow),
    },
    events: (eventResult.results ?? []).map(toEvent),
    detections: (detectionResult.results ?? []).map(toDetection),
  };
}

function countValue(row: CountRow | null): number {
  const value = Number(row?.count ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Security-event count is invalid");
  return value;
}

export async function updateSecurityDetectionStatus(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly detectionId: string;
  readonly status: "open" | "acknowledged";
  readonly note: string | null;
  readonly actorId: string;
}): Promise<StoredSecurityDetection> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const current = await detectionRow(db, input.orgId, input.customerId, input.connectionId, input.detectionId);
  if (current === null) throw Object.assign(new Error("Security detection not found"), { code: "NOT_FOUND" });
  const now = Date.now();
  await commitAuditedStatements({
    db,
    statements: [db.prepare(
      `UPDATE security_event_detections
          SET status = ?, note = ?, actor_id = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND updated_at = ? AND status = ?
          AND EXISTS (
            SELECT 1 FROM security_event_runs r
             WHERE r.id = security_event_detections.source_run_id
               AND r.org_id = security_event_detections.org_id
               AND r.connection_id = security_event_detections.connection_id
               AND r.status <> 'PERSISTING'
          )`,
    ).bind(
      input.status, input.note, input.actorId, now, input.detectionId,
      input.orgId, input.customerId, input.connectionId, current.updated_at, current.status,
    )],
    audit: {
      actorId: input.actorId,
      action: `security_detection.${input.status}`,
      targetType: "security_event_detection",
      targetId: input.detectionId,
      customerId: input.customerId,
      outcome: "allowed",
      requestId: `security_detection.${input.status}:${input.detectionId}:${now}`,
      metadata: {
        connectionId: input.connectionId,
        ruleKey: current.rule_key,
        status: input.status,
        notePresent: input.note !== null,
      },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM security_event_detections d
              JOIN security_event_runs r
                ON r.id = d.source_run_id AND r.org_id = d.org_id
               AND r.customer_id = d.customer_id AND r.connection_id = d.connection_id
             WHERE d.id = ? AND d.org_id = ? AND d.customer_id = ? AND d.connection_id = ?
               AND d.status = ? AND d.actor_id = ? AND d.updated_at = ?
               AND ((d.note = ?) OR (d.note IS NULL AND ? IS NULL))
               AND r.status <> 'PERSISTING'`,
      values: [
        input.detectionId, input.orgId, input.customerId, input.connectionId,
        input.status, input.actorId, now, input.note, input.note,
      ],
    },
    persistenceMessage: "The security detection and its audit evidence could not be committed atomically",
  });
  const row = await detectionRow(db, input.orgId, input.customerId, input.connectionId, input.detectionId);
  if (row === null) throw new Error("The updated security detection could not be loaded");
  return toDetection(row);
}

async function detectionRow(
  db: D1Database,
  orgId: string,
  customerId: string,
  connectionId: string,
  detectionId: string,
): Promise<DetectionRow | null> {
  return db.prepare(
    `SELECT id, source_run_id, rule_key, rule_version, severity, status, title,
            summary, first_event_at, last_event_at, event_ids_json, evidence_json,
            limitation, note, actor_id, updated_at
       FROM security_event_detections
      WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
        AND EXISTS (
          SELECT 1 FROM security_event_runs r
           WHERE r.id = security_event_detections.source_run_id
             AND r.org_id = security_event_detections.org_id
             AND r.connection_id = security_event_detections.connection_id
             AND r.status <> 'PERSISTING'
        )
      LIMIT 1`,
  ).bind(detectionId, orgId, customerId, connectionId).first<DetectionRow>();
}

async function sourceRow(
  db: D1Database,
  orgId: string,
  customerId: string,
  connectionId: string,
): Promise<SourceRow | null> {
  return db.prepare(
    `SELECT id, org_id, customer_id, connection_id, source, status,
            retention_days, lookback_hours, overlap_minutes, last_window_start,
            last_window_end, last_collected_at, last_run_id, last_error_code, updated_at
       FROM security_event_sources
      WHERE org_id = ? AND customer_id = ? AND connection_id = ? LIMIT 1`,
  ).bind(orgId, customerId, connectionId).first<SourceRow>();
}

async function runRow(
  db: D1Database,
  orgId: string,
  customerId: string,
  connectionId: string,
  runId: string,
): Promise<RunRow | null> {
  return db.prepare(
    `SELECT id, status, window_start, window_end, collected_at, finished_at,
            coverage_json, events_observed, events_inserted, duplicate_events,
            detections_observed, payload_sha256
       FROM security_event_runs
      WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ? LIMIT 1`,
  ).bind(runId, orgId, customerId, connectionId).first<RunRow>();
}

function toSource(row: SourceRow): SecurityEventSourceState {
  return {
    sourceId: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    source: "AWS_CLOUDTRAIL_LOOKUP_EVENTS",
    status: row.status as SecurityEventSourceState["status"],
    retentionDays: Number(row.retention_days),
    lookbackHours: Number(row.lookback_hours),
    overlapMinutes: Number(row.overlap_minutes),
    lastWindowStart: iso(row.last_window_start),
    lastWindowEnd: iso(row.last_window_end),
    lastCollectedAt: iso(row.last_collected_at),
    lastRunId: row.last_run_id,
    lastErrorCode: row.last_error_code,
    updatedAt: iso(row.updated_at)!,
  };
}

function toRun(row: RunRow): SecurityEventRun {
  return {
    runId: row.id,
    status: row.status as SecurityEventRun["status"],
    windowStart: iso(row.window_start)!,
    windowEnd: iso(row.window_end)!,
    collectedAt: iso(row.collected_at)!,
    finishedAt: iso(row.finished_at)!,
    coverage: parseJson<SecurityEventRegionCoverage[]>(row.coverage_json, []),
    eventsObserved: Number(row.events_observed),
    eventsInserted: Number(row.events_inserted),
    duplicateEvents: Number(row.duplicate_events),
    detectionsObserved: Number(row.detections_observed),
    payloadSha256: row.payload_sha256,
  };
}

function toEvent(row: EventRow): StoredSecurityEvent {
  return {
    schemaVersion: "sutra.security-event.v1",
    providerEventId: row.provider_event_id,
    accountId: row.account_id,
    region: row.region_key,
    eventTime: iso(row.event_time)!,
    eventName: row.event_name,
    eventSource: row.event_source,
    readOnly: intBoolean(row.read_only),
    managementEvent: intBoolean(row.management_event),
    eventCategory: row.event_category,
    username: row.username,
    identityType: row.identity_type,
    principalArn: row.principal_arn,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    errorCode: row.error_code,
    requestId: row.request_id,
    consoleLoginResult: row.console_login_result === "Success" || row.console_login_result === "Failure" ? row.console_login_result : null,
    mfaUsed: intBoolean(row.mfa_used),
    detailStatus: row.detail_status === "AVAILABLE" ? "AVAILABLE" : "UNAVAILABLE",
    resources: parseJson<NormalizedSecurityEventResource[]>(row.resources_json, []),
    ingestedAt: iso(row.ingested_at)!,
    sourceRunId: row.source_run_id,
  };
}

function toDetection(row: DetectionRow): StoredSecurityDetection {
  return {
    detectionId: row.id,
    ruleKey: row.rule_key,
    ruleVersion: "1.0.0",
    severity: row.severity as StoredSecurityDetection["severity"],
    status: row.status === "acknowledged" ? "acknowledged" : "open",
    title: row.title,
    summary: row.summary,
    firstEventAt: iso(row.first_event_at)!,
    lastEventAt: iso(row.last_event_at)!,
    eventIds: parseJson<string[]>(row.event_ids_json, []),
    evidence: parseJson<Record<string, string | number | boolean>>(row.evidence_json, {}),
    limitation: row.limitation,
    note: row.note,
    actorId: row.actor_id,
    updatedAt: iso(row.updated_at)!,
    sourceRunId: row.source_run_id,
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function booleanInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

function intBoolean(value: number | null): boolean | null {
  return value === null ? null : Number(value) === 1;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(Number(value)).toISOString();
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
