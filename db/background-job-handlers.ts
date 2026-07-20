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
import { addCaseNote } from "./case-repository";
import { FinopsScheduledReportRepository, type ReportDeliveryKind } from "./finops-scheduled-report-repository";
import { FinopsWorkspaceRepository } from "./finops-workspace-repository";
import { ItsmConnectorRepository } from "./itsm-connector-repository";
import { JobQueueRepository } from "./job-queue-repository";
import { RetentionSweepRepository } from "./retention-sweep-repository";

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
