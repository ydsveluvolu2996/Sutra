import { env } from "cloudflare:workers";
import type { JobHandler, RunnableJob } from "../lib/background-job-runner.ts";
import { deliverItsmTicket } from "../lib/itsm-delivery.ts";
import type { CaseStatusLike, ItsmCaseLike } from "../lib/itsm-sync.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { buildAllocation, detectAnomalies, evaluateBudgets, type BudgetDefinition } from "../lib/finops-insights.ts";
import {
  deliverScheduledReport,
  type ReportDeliveryEnv,
  type ReportDeliveryResult,
  type ScheduledReportEnvelope,
} from "../lib/finops-report-delivery.ts";
import { nextRunAtIso } from "../lib/finops-report-schedule.ts";
import {
  describeFiredAlert,
  evaluateAlertRules,
  type AlertMetricMap,
  type AlertRule,
  type AlertRuleEvaluation,
  type AlertRuleScope,
} from "../lib/alert-rules.ts";
import {
  assembleAlertMetrics,
  DEFAULT_NEW_FINDING_WINDOW_MS,
  type AlertMetricSignals,
  type CloudFindingSignals,
  type OpenFindingSignal,
  type PostureSignal,
} from "../lib/alert-metrics.ts";
import { isKnownExploited, KEV_AS_OF } from "../lib/kev-snapshot.ts";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../lib/security-notifications.ts";
import { buildMspScorecard } from "../lib/kubernetes-posture-trend.ts";
import { addCaseNote } from "./case-repository";
import { AlertRuleRepository, type RecordAlertEventInput } from "./alert-rule-repository";
import { CloudVulnerabilityRepository } from "./cloud-vulnerability-repository";
import { FinopsScheduledReportRepository, type ReportDeliveryKind } from "./finops-scheduled-report-repository";
import { FinopsWorkspaceRepository } from "./finops-workspace-repository";
import { ItsmConnectorRepository } from "./itsm-connector-repository";
import { JobQueueRepository } from "./job-queue-repository";
import { KubernetesRepository } from "./kubernetes-repository";
import { getLatestConnectionForOrg, listConnectionsForOrg } from "./pilot-repository";
import { RetentionSweepRepository } from "./retention-sweep-repository";
import { SecurityNotificationRepository } from "./security-notification-repository";

const CASE_STATUSES: ReadonlySet<CaseStatusLike> = new Set<CaseStatusLike>([
  "open", "investigating", "resolved", "accepted_risk",
]);

interface ItsmDispatchPayload {
  readonly customerId: string;
  readonly connectionId: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly actorUserId: string;
  readonly itsmCase: ItsmCaseLike;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseItsmCase(value: unknown): ItsmCaseLike | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const caseId = asString(record.caseId);
  const title = asString(record.title);
  const severity = asString(record.severity);
  const priority = asString(record.priority);
  const summary = typeof record.summary === "string" ? record.summary : null;
  const status = record.status;
  if (
    caseId === null || title === null || severity === null || priority === null || summary === null ||
    typeof status !== "string" || !CASE_STATUSES.has(status as CaseStatusLike)
  ) return null;
  return { caseId, title, summary, severity, priority, status: status as CaseStatusLike };
}

function parseItsmDispatchPayload(payload: unknown): ItsmDispatchPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const customerId = asString(record.customerId);
  const connectionId = asString(record.connectionId);
  const connectorId = asString(record.connectorId);
  const connectorName = asString(record.connectorName);
  const actorUserId = asString(record.actorUserId);
  const itsmCase = parseItsmCase(record.itsmCase);
  if (customerId === null || connectionId === null || connectorId === null || connectorName === null || actorUserId === null || itsmCase === null) {
    return null;
  }
  return { customerId, connectionId, connectorId, connectorName, actorUserId, itsmCase };
}

function deliveryOutcome(result: { readonly delivered: boolean; readonly statusCode?: number; readonly error?: string }): string {
  if (result.delivered) return `delivered (${result.statusCode})`;
  if (result.statusCode === undefined) return `failed (${result.error ?? "dispatch-error"})`;
  return `rejected (${result.statusCode})`;
}

async function runItsmDispatch(job: RunnableJob): Promise<void> {
  const payload = parseItsmDispatchPayload(job.payload);
  if (payload === null) throw new Error("itsm-dispatch-payload-invalid");
  const connector = await new ItsmConnectorRepository().getForDispatch(
    { orgId: job.orgId, customerId: payload.customerId },
    payload.connectorId,
  );
  if (connector === null || !connector.enabled) throw new Error("itsm-connector-unavailable");
  const result = await deliverItsmTicket({
    connector: {
      baseUrl: connector.baseUrl,
      sharedSecret: connector.sharedSecret,
      connectorType: connector.connectorType,
      projectKey: connector.projectKey,
    },
    itsmCase: payload.itsmCase,
  });
  const outcome = deliveryOutcome(result);
  await addCaseNote({
    orgId: job.orgId,
    customerId: payload.customerId,
    connectionId: payload.connectionId,
    caseId: payload.itsmCase.caseId,
    actorUserId: payload.actorUserId,
    note: `ITSM dispatch (durable retry) to '${connector.name}' ${outcome}.`,
  });
  // Rethrow on a non-delivery so the queue's own backoff/dead-letter policy
  // decides the next attempt — the note above records what actually happened.
  if (!result.delivered) throw new Error(`itsm-dispatch ${outcome}`);
}

const REPORT_ID = /^fsr_[a-f0-9]{32}$/u;
const REPORT_CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

const SCHEDULED_REPORT_DISCLAIMER =
  "Scheduled cost report over the latest persisted billing period for this " +
  "connection. Currencies are never summed together; anomalies are statistical " +
  "signals, not billing truth; and the report is marked delivered only when the " +
  "configured transport returned a 2xx response.";

interface ScheduledReportPayload {
  readonly scheduleId: string;
  readonly connectionId: string;
  readonly name: string;
  readonly deliveryKind: ReportDeliveryKind;
  readonly deliveryTarget: string;
}

function parseScheduledReportPayload(payload: unknown): ScheduledReportPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const scheduleId = asString(record.scheduleId);
  const connectionId = asString(record.connectionId);
  const name = asString(record.name);
  const deliveryTarget = asString(record.deliveryTarget);
  const deliveryKind = record.deliveryKind;
  if (
    scheduleId === null || !REPORT_ID.test(scheduleId) ||
    connectionId === null || !REPORT_CONNECTION_ID.test(connectionId) ||
    name === null || deliveryTarget === null ||
    (deliveryKind !== "webhook" && deliveryKind !== "email")
  ) return null;
  return { scheduleId, connectionId, name, deliveryKind, deliveryTarget };
}

/** Compose the immutable report envelope from the pure FinOps engines. */
function buildReportEnvelope(input: {
  readonly name: string;
  readonly connectionId: string;
  readonly period: string | null;
  readonly lines: readonly NormalizedCurLine[];
  readonly budgets: readonly BudgetDefinition[];
  readonly nowMs: number;
}): ScheduledReportEnvelope {
  const allocation = buildAllocation(input.lines, "service");
  const budgetEvaluations = evaluateBudgets(input.lines, input.budgets);
  const anomalies = detectAnomalies(input.lines);
  return {
    schema: "sutra.finops-scheduled-report.v1",
    scheduleName: input.name,
    connectionId: input.connectionId,
    period: input.period,
    lineCount: input.lines.length,
    currencyTotals: allocation.map((entry) => ({ currency: entry.currency, totalMicros: entry.totalMicros })),
    budgetStates: budgetEvaluations.map((entry) => ({ name: entry.name, state: entry.state, spentMicros: entry.spentMicros })),
    anomalyCount: anomalies.anomalies.length,
    generatedAt: new Date(input.nowMs).toISOString(),
    disclaimer: SCHEDULED_REPORT_DISCLAIMER,
  };
}

/** Injectable dependencies so the render->deliver path is unit-testable. */
export interface ScheduledReportRunDeps {
  readonly scheduleRepo: Pick<FinopsScheduledReportRepository, "get">;
  readonly finopsRepo: Pick<FinopsWorkspaceRepository, "listPeriods" | "linesForPeriod" | "listBudgets">;
  readonly deliver: (
    kind: ReportDeliveryKind,
    target: string,
    envelope: ScheduledReportEnvelope,
  ) => Promise<ReportDeliveryResult>;
  readonly now: () => number;
}

/**
 * Build the latest-period cost summary for a due schedule and deliver it. The
 * FinOps computation is REUSED from the pure engines (buildAllocation /
 * evaluateBudgets / detectAnomalies) over the persisted CUR lines — nothing is
 * recomputed here. Delivery honesty: a configured transport that did not accept
 * the report rethrows so the queue governs the retry; an unconfigured transport
 * ('none') is an honest non-delivery with nothing to retry.
 */
export async function runScheduledReportJob(job: RunnableJob, deps: ScheduledReportRunDeps): Promise<void> {
  const payload = parseScheduledReportPayload(job.payload);
  if (payload === null) throw new Error("finops-scheduled-report-payload-invalid");
  if (job.customerId === null) throw new Error("finops-scheduled-report-requires-customer");
  const scope = { orgId: job.orgId, customerId: job.customerId };
  const schedule = await deps.scheduleRepo.get(scope, payload.scheduleId);
  // Disabled or removed between enqueue and run: honest no-op, nothing to send.
  if (schedule === null || !schedule.enabled) return;
  const periods = await deps.finopsRepo.listPeriods(scope, payload.connectionId);
  const period = periods[0]?.period ?? null;
  const lines = period === null
    ? []
    : await deps.finopsRepo.linesForPeriod(scope, payload.connectionId, period);
  const budgets = await deps.finopsRepo.listBudgets(scope);
  const envelope = buildReportEnvelope({
    name: schedule.name,
    connectionId: payload.connectionId,
    period,
    lines,
    budgets,
    nowMs: deps.now(),
  });
  const result = await deps.deliver(payload.deliveryKind, payload.deliveryTarget, envelope);
  if (!result.delivered && result.transport !== "none") {
    throw new Error(`finops-scheduled-report delivery via ${result.transport} was not accepted`);
  }
}

function reportDeliveryEnv(): ReportDeliveryEnv {
  return env as unknown as ReportDeliveryEnv;
}

// --- Metric alerting -------------------------------------------------------

export interface AlertDispatchInput {
  readonly scope: AlertRuleScope;
  readonly evaluation: AlertRuleEvaluation;
  readonly message: string;
  readonly firedAtMs: number;
}

export interface AlertDispatchOutcome {
  readonly deliveryState: "queued" | "no_destination";
  readonly destinationCount: number;
}

/** Injected dependencies so the evaluate -> record -> dispatch path is unit-testable. */
export interface AlertEvaluationRunDeps {
  readonly loadEnabledRules: (scope: AlertRuleScope) => Promise<readonly AlertRule[]>;
  readonly loadMetrics: (scope: AlertRuleScope) => Promise<AlertMetricMap>;
  readonly recordEvent: (input: RecordAlertEventInput) => Promise<unknown>;
  readonly dispatch: (input: AlertDispatchInput) => Promise<AlertDispatchOutcome>;
  readonly now: () => number;
}

export interface AlertEvaluationSummary {
  readonly rulesEvaluated: number;
  readonly fired: number;
  readonly dispatched: number;
}

const MAX_ALERT_MESSAGE = 2_000;
const ALERT_PUBLIC_ORIGIN = "https://app.sutracmdb.com";

/**
 * Evaluate a tenant's enabled alert rules against freshly assembled metrics,
 * record each firing, and dispatch it through the EXISTING notification system.
 * Honesty is enforced by the pure evaluator (an unavailable metric never fires)
 * and preserved here: the delivery_state recorded is exactly what dispatch
 * reported — a firing with no configured destination is recorded as
 * 'no_destination', never faked as delivered.
 */
export async function runAlertEvaluationJob(
  job: RunnableJob,
  deps: AlertEvaluationRunDeps,
): Promise<AlertEvaluationSummary> {
  if (job.customerId === null) throw new Error("alert-evaluation-requires-customer");
  const scope: AlertRuleScope = { orgId: job.orgId, customerId: job.customerId };
  const rules = await deps.loadEnabledRules(scope);
  if (rules.length === 0) return { rulesEvaluated: 0, fired: 0, dispatched: 0 };
  const metrics = await deps.loadMetrics(scope);
  const evaluations = evaluateAlertRules(rules, metrics);
  let fired = 0;
  let dispatched = 0;
  for (const evaluation of evaluations) {
    // The pure evaluator already refuses to fire on an unavailable metric; the
    // observedValue guard is a belt-and-braces check before we persist a number.
    if (!evaluation.fired || evaluation.observedValue === null) continue;
    fired += 1;
    const firedAtMs = deps.now();
    const message = describeFiredAlert(evaluation).slice(0, MAX_ALERT_MESSAGE);
    const outcome = await deps.dispatch({ scope, evaluation, message, firedAtMs });
    if (outcome.deliveryState === "queued") dispatched += 1;
    await deps.recordEvent({
      orgId: scope.orgId,
      customerId: scope.customerId,
      ruleId: evaluation.rule.id,
      observedValue: evaluation.observedValue,
      message,
      deliveryState: outcome.deliveryState,
      destinationCount: outcome.destinationCount,
    });
  }
  return { rulesEvaluated: evaluations.length, fired, dispatched };
}

async function safeSignal<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    // A source that cannot be read is honestly reported as unavailable (the
    // metric it backs never fires) rather than failing the whole tenant's tick.
    return undefined;
  }
}

/**
 * Live metric collector: reuse the pure FinOps engines over the latest ingested
 * billing period, the cloud vulnerability findings joined to the CISA KEV
 * catalog, and the Kubernetes posture scorecard. Each source is best-effort and
 * only contributes a signal when it genuinely has data; missing sources leave
 * their metrics unavailable, which the assembler discloses.
 */
export async function collectLiveTenantMetrics(scope: AlertRuleScope): Promise<AlertMetricMap> {
  const nowMs = Date.now();
  const signals: {
    budgets?: AlertMetricSignals["budgets"];
    anomalies?: AlertMetricSignals["anomalies"];
    cloudFindings?: CloudFindingSignals;
    posture?: PostureSignal;
  } = {};

  const finops = await safeSignal(async () => {
    const connection = await getLatestConnectionForOrg(scope.orgId);
    if (connection === null || connection.customerId !== scope.customerId) return null;
    const repo = new FinopsWorkspaceRepository();
    const budgets = await repo.listBudgets(scope);
    const periods = await repo.listPeriods(scope, connection.id);
    const lines = periods.length > 0
      ? await repo.linesForPeriod(scope, connection.id, periods[0].period)
      : [];
    return { budgets: evaluateBudgets(lines, budgets), anomalies: detectAnomalies(lines) };
  });
  if (finops !== null && finops !== undefined) {
    signals.budgets = finops.budgets;
    signals.anomalies = finops.anomalies;
  }

  const cloudFindings = await safeSignal(async () => {
    const connections = (await listConnectionsForOrg(scope.orgId))
      .filter((connection) => connection.customerId === scope.customerId);
    if (connections.length === 0) return undefined;
    const repo = new CloudVulnerabilityRepository();
    const openFindings: OpenFindingSignal[] = [];
    for (const connection of connections) {
      const findings = await repo.listForConnection(scope, connection.id);
      for (const finding of findings) {
        openFindings.push({
          severity: finding.severity,
          firstSeenMs: finding.firstSeenMs,
          knownExploited: isKnownExploited(finding.cveId),
        });
      }
    }
    // An empty set cannot be distinguished from "never scanned", so we do not
    // claim a 0 observation; the metric stays unavailable instead.
    if (openFindings.length === 0) return undefined;
    return {
      openFindings,
      asOfMs: nowMs,
      newWindowMs: DEFAULT_NEW_FINDING_WINDOW_MS,
      kevAsOf: KEV_AS_OF,
    } satisfies CloudFindingSignals;
  });
  if (cloudFindings !== undefined) signals.cloudFindings = cloudFindings;

  const posture = await safeSignal(async () => {
    const repo = new KubernetesRepository();
    const clusters = await repo.listClusters(scope);
    if (clusters.length === 0) return undefined;
    const scorecardClusters = await Promise.all(clusters.map(async (cluster) => ({
      clusterId: cluster.id,
      clusterName: cluster.name,
      points: (await repo.listPostureTrend(scope, cluster.id)).map((point) => ({
        scanId: point.scanId,
        collectedAt: point.collectedAt,
        status: point.status,
        resourceCount: point.resourceCount,
        findingCount: point.findingCount,
        coverageCount: point.coverageCount,
        severity: point.severity,
      })),
    })));
    const scorecard = buildMspScorecard({ clusters: scorecardClusters });
    return {
      averageScore: scorecard.fleet.averageScore,
      scoredClusterCount: scorecard.clusters.filter((row) => row.score !== null).length,
    } satisfies PostureSignal;
  });
  if (posture !== undefined) signals.posture = posture;

  return assembleAlertMetrics(signals);
}

function alertEventId(): string {
  return `notify_${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 48)}`;
}

async function alertEvidenceHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function alertText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, maximum).trim();
}

/**
 * Dispatch a fired alert by enqueuing it into the EXISTING security-notification
 * outbox for each of the tenant's enabled destinations (optionally narrowed to
 * the rule's destinationRef). No new transport is introduced — the outbox worker
 * performs delivery. With no configured destination this returns 'no_destination'
 * so the caller records an honest non-delivery.
 */
export async function dispatchFiredAlert(input: AlertDispatchInput): Promise<AlertDispatchOutcome> {
  const repository = new SecurityNotificationRepository();
  const enabled = (await repository.listDestinations(input.scope.orgId, input.scope.customerId))
    .filter((destination) => destination.enabled);
  const ref = input.evaluation.rule.destinationRef;
  const targets = ref === undefined || ref === null
    ? enabled
    : enabled.filter((destination) => destination.id === ref);
  if (targets.length === 0) return { deliveryState: "no_destination", destinationCount: 0 };
  const rule = input.evaluation.rule;
  const title = alertText(rule.name, 200);
  const summary = alertText(input.message, 1_000);
  let enqueued = 0;
  for (const destination of targets) {
    const event = normalizeSecurityNotificationEvent({
      eventId: alertEventId(),
      orgId: input.scope.orgId,
      customerId: input.scope.customerId,
      clusterId: `alert:${rule.metric}`,
      severity: rule.severity,
      title,
      summary,
      occurredAt: new Date(input.firedAtMs).toISOString(),
      findingCount: 1,
      reportUrl: `${ALERT_PUBLIC_ORIGIN}/alerts`,
      evidenceSha256: await alertEvidenceHash(
        `${input.scope.orgId}\u0000${input.scope.customerId}\u0000${rule.id}\u0000${input.firedAtMs}\u0000${input.evaluation.observedValue}`,
      ),
    }, ALERT_PUBLIC_ORIGIN);
    const emailRecipients = destination.configuration.channel === "email"
      ? destination.configuration.recipients
      : ["notifications@sutracmdb.com"];
    const payloads = await buildSecurityNotificationPayloads({ event, emailRecipients });
    await repository.enqueue({
      orgId: input.scope.orgId,
      customerId: input.scope.customerId,
      destinationId: destination.id,
      idempotencyKey: `alert.${rule.id}.${input.firedAtMs}.${destination.id}`,
      event,
      payloads,
    });
    enqueued += 1;
  }
  return { deliveryState: "queued", destinationCount: enqueued };
}

/**
 * The app-side registry of durable job handlers. Each handler does real work and
 * throws on failure — nothing is fabricated, and the runner completes a job only
 * when its handler returns without throwing.
 */
export function buildJobHandlers(): Record<string, JobHandler> {
  return {
    "retention-sweep": async (job) => {
      await new RetentionSweepRepository().sweep(job.orgId);
    },
    "itsm-dispatch": runItsmDispatch,
    "finops-scheduled-report": (job) => runScheduledReportJob(job, {
      scheduleRepo: new FinopsScheduledReportRepository(),
      finopsRepo: new FinopsWorkspaceRepository(),
      deliver: (kind, target, envelope) =>
        deliverScheduledReport({ kind, target, envelope, env: reportDeliveryEnv() }),
      now: Date.now,
    }),
    "alert-evaluation": async (job) => {
      await runAlertEvaluationJob(job, {
        loadEnabledRules: (scope) => new AlertRuleRepository().listEnabled(scope),
        loadMetrics: (scope) => collectLiveTenantMetrics(scope),
        recordEvent: (input) => new AlertRuleRepository().recordEvent(input),
        dispatch: dispatchFiredAlert,
        now: Date.now,
      });
    },
  };
}

/**
 * Ensure every given org has at most one in-flight retention sweep. For each org
 * with no queued/leased `retention-sweep`, enqueue one. Idempotent: a second call
 * before the first sweep drains enqueues nothing. Returns the number enqueued.
 */
export async function ensureRetentionSweepsEnqueued(
  queue: JobQueueRepository,
  orgIds: readonly string[],
  now = Date.now(),
): Promise<number> {
  let enqueued = 0;
  for (const orgId of orgIds) {
    const existing = await queue.list(orgId, null);
    const active = existing.some(
      (job) => job.kind === "retention-sweep" && (job.status === "queued" || job.status === "leased"),
    );
    if (active) continue;
    await queue.enqueue({ orgId, customerId: null, kind: "retention-sweep", payload: { orgId } }, now);
    enqueued += 1;
  }
  return enqueued;
}

/**
 * The scheduled-report tick: enqueue one `finops-scheduled-report` job per DUE
 * schedule across all tenants, mirroring the collection-schedule cadence model.
 * Each due schedule is advanced to its next run FIRST (markRun) so a failed
 * enqueue never leaves it perpetually due looping the queue; a missed window
 * self-heals on the next cadence. Returns the number of jobs enqueued.
 */
export async function ensureDueScheduledReportsEnqueued(
  queue: JobQueueRepository,
  reports: FinopsScheduledReportRepository,
  now = Date.now(),
): Promise<number> {
  const due = await reports.listDue(now);
  let enqueued = 0;
  for (const report of due) {
    const advanced = await reports.markRun(report.id, now, nextRunAtIso(report.cadence, now), now);
    if (!advanced) continue;
    try {
      await queue.enqueue({
        orgId: report.orgId,
        customerId: report.customerId,
        kind: "finops-scheduled-report",
        payload: {
          scheduleId: report.id,
          connectionId: report.connectionId,
          name: report.name,
          deliveryKind: report.deliveryKind,
          deliveryTarget: report.deliveryTarget,
        },
      }, now);
      enqueued += 1;
    } catch {
      // A schedule whose customer is no longer active cannot be enqueued; the
      // row was already advanced, so it is simply re-evaluated next cadence.
    }
  }
  return enqueued;
}

/**
 * The alert-evaluation tick: ensure every tenant that has at least one enabled
 * alert rule has at most one in-flight `alert-evaluation` job. Mirrors the
 * retention-sweep cadence model — a tenant with an already queued/leased
 * evaluation enqueues nothing, so a slow tick never piles up duplicate work.
 * Rules are discovered with the ONE system-level scan; each carries its own
 * tenant scope, so every enqueued job runs strictly within that tenant. Returns
 * the number of jobs enqueued.
 */
export async function ensureDueAlertEvaluationsEnqueued(
  queue: JobQueueRepository,
  rules: AlertRuleRepository,
  now = Date.now(),
): Promise<number> {
  const enabled = await rules.listEnabledForAllTenants(now);
  const tenants = new Map<string, { readonly orgId: string; readonly customerId: string }>();
  for (const rule of enabled) {
    tenants.set(`${rule.scope.orgId} ${rule.scope.customerId}`, rule.scope);
  }
  let enqueued = 0;
  for (const tenant of tenants.values()) {
    const existing = await queue.list(tenant.orgId, tenant.customerId);
    const active = existing.some(
      (job) => job.kind === "alert-evaluation" && (job.status === "queued" || job.status === "leased"),
    );
    if (active) continue;
    try {
      await queue.enqueue(
        { orgId: tenant.orgId, customerId: tenant.customerId, kind: "alert-evaluation", payload: {} },
        now,
      );
      enqueued += 1;
    } catch {
      // A tenant whose customer is no longer active cannot be enqueued; it is
      // simply re-evaluated on the next tick.
    }
  }
  return enqueued;
}
