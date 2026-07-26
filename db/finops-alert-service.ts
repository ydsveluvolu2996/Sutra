// Shared FinOps alert evaluation + dispatch, used by BOTH the on-demand
// /api/v1/finops/alerts route and the periodic `finops-alert-sweep` background
// job. Keeping one path means the preview a user sees and the alert a schedule
// sends are computed identically, and the notification mapping never drifts.
//
// Evaluation reuses the existing pure engines (detectAnomalies + budget
// burn-down → evaluateFinopsAlerts). Dispatch reuses the existing durable
// notification outbox (SecurityNotificationRepository.enqueue) with the same
// SecurityNotificationEvent shape every other Sutra notification uses — no new
// outbound transport and no new secrets. Idempotency is keyed on the alert's
// stable content id, so re-dispatching the same alert to the same destination
// never produces a duplicate.
import { FinopsWorkspaceRepository } from "./finops-workspace-repository";
import { SecurityNotificationRepository } from "./security-notification-repository";
import { detectAnomalies } from "../lib/finops-insights.ts";
import { buildBudgetBurndown } from "../lib/finops-budget-burndown.ts";
import {
  evaluateFinopsAlerts,
  type FinopsAlert,
  type FinopsAlertEvaluation,
  type FinopsAlertSeverity,
} from "../lib/finops-alerts.ts";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../lib/security-notifications.ts";

const PUBLIC_ORIGIN = "https://app.sutracmdb.com";
const REPORT_URL = "https://app.sutracmdb.com/costs";

export async function evidenceHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function daysInMonth(period: string): number {
  const [year, month] = period.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function asOfDayIndex(lines: readonly { usageStartIso: string }[]): number {
  let max = 0;
  for (const line of lines) {
    const day = Number(line.usageStartIso.slice(8, 10));
    if (Number.isFinite(day) && day > max) max = day;
  }
  return Math.max(1, max);
}

export interface FinopsAlertPeriodResult {
  readonly periods: readonly { period: string; lineCount: number }[];
  readonly period: string | null;
  readonly evaluation: FinopsAlertEvaluation;
}

/**
 * Evaluate current cost/budget alerts for a connection's selected billing
 * period (defaulting to the latest ingested period). Pure engines over the
 * tenant-scoped CUR lines + budgets — no I/O beyond the two repository reads.
 */
export async function evaluateFinopsAlertsForConnection(
  orgId: string,
  customerId: string,
  connectionId: string,
  options: { period?: string | null; minSeverity?: FinopsAlertSeverity } = {},
  workspace: FinopsWorkspaceRepository = new FinopsWorkspaceRepository(),
): Promise<FinopsAlertPeriodResult> {
  const scope = { orgId, customerId };
  const periods = await workspace.listPeriods(scope, connectionId);
  const selected = options.period ?? periods[0]?.period ?? null;
  if (selected === null) {
    return { periods, period: null, evaluation: evaluateFinopsAlerts({ anomalies: [], budgets: [], minSeverity: options.minSeverity }) };
  }
  const lines = await workspace.linesForPeriod(scope, connectionId, selected);
  const budgets = await workspace.listBudgets(scope);
  const anomalies = detectAnomalies(lines).anomalies;
  const burndown = buildBudgetBurndown({
    budgets,
    dailyLines: lines,
    period: selected,
    asOfDayIndex: asOfDayIndex(lines),
    daysInMonth: daysInMonth(selected),
  });
  return {
    periods,
    period: selected,
    evaluation: evaluateFinopsAlerts({ anomalies, budgets: burndown.budgets, minSeverity: options.minSeverity }),
  };
}

/**
 * Enqueue a single alert to one destination through the durable outbox. Builds
 * the SecurityNotificationEvent + provider payloads exactly as every other Sutra
 * notification does; the routing key / webhook URL is resolved by the delivery
 * worker from the managed secret store, never here.
 */
export async function enqueueFinopsAlert(
  notifications: SecurityNotificationRepository,
  args: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly destinationId: string;
    readonly recipients: readonly string[];
    readonly alert: FinopsAlert;
  },
): Promise<void> {
  const eventId = `notify_${(await evidenceHash(`finops-alert\0${args.alert.id}`)).slice(0, 48)}`;
  const event = normalizeSecurityNotificationEvent({
    eventId,
    orgId: args.orgId,
    customerId: args.customerId,
    clusterId: `finops:${args.connectionId}`,
    severity: args.alert.severity,
    title: args.alert.title,
    summary: args.alert.summary,
    occurredAt: new Date().toISOString(),
    findingCount: 1,
    reportUrl: REPORT_URL,
    evidenceSha256: await evidenceHash(`finops-alert-evidence\0${args.alert.id}\0${args.alert.summary}`),
  }, PUBLIC_ORIGIN);
  const payloads = await buildSecurityNotificationPayloads({ event, emailRecipients: [...args.recipients] });
  await notifications.enqueue({
    orgId: args.orgId,
    customerId: args.customerId,
    destinationId: args.destinationId,
    // Idempotent per (alert, destination): the same signal re-dispatched to the
    // same destination collapses to one outbox row.
    idempotencyKey: args.alert.id,
    event,
    payloads,
  });
}

/** Email destinations carry their own recipients; other channels use the shared address. */
export function recipientsForDestination(destination: {
  configuration: { channel: string; recipients?: readonly string[] };
}): readonly string[] {
  return destination.configuration.channel === "email" && Array.isArray(destination.configuration.recipients)
    ? destination.configuration.recipients
    : ["notifications@sutracmdb.com"];
}
