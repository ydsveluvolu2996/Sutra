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
  buildAnomalyAlerts,
  buildBudgetAlerts,
  combineFinopsAlerts,
  type FinopsAlert,
  type FinopsAlertEvaluation,
  type FinopsAlertSeverity,
} from "../lib/finops-alerts.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
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
 * Evaluate a CUSTOMER's cost/budget alerts for a billing period.
 *
 * The two signal families have different natural scopes, and conflating them was
 * a real defect:
 * - Anomalies are per-account: each connection's lines are evaluated on their
 *   own, and each resulting alert id carries that connection so two AWS accounts
 *   spiking on the same service/day stay distinct alerts.
 * - Budgets are customer-wide: every connection's lines for the period are
 *   COMBINED and the burn-down runs ONCE. Evaluating a customer-wide limit
 *   against a single connection's slice understates consumption and misses
 *   breaches.
 *
 * Pure engines over tenant-scoped reads; no dispatch here.
 */
export async function evaluateFinopsAlertsForCustomer(
  orgId: string,
  customerId: string,
  /** EVERY connection of this customer — budget spend is combined across all of them. */
  connectionIds: readonly string[],
  options: {
    readonly period?: string | null;
    readonly minSeverity?: FinopsAlertSeverity;
    /**
     * Restrict which connections contribute ANOMALY alerts (budgets always use
     * the full `connectionIds` set). The costs page passes the one connection the
     * operator selected; the background sweep leaves this undefined to cover all.
     */
    readonly anomalyConnectionIds?: readonly string[];
  } = {},
  workspace: FinopsWorkspaceRepository = new FinopsWorkspaceRepository(),
): Promise<FinopsAlertPeriodResult> {
  const scope = { orgId, customerId };
  // Union the periods present across every connection; line COUNTS may be summed.
  const periodCounts = new Map<string, number>();
  for (const connectionId of connectionIds) {
    for (const entry of await workspace.listPeriods(scope, connectionId)) {
      periodCounts.set(entry.period, (periodCounts.get(entry.period) ?? 0) + entry.lineCount);
    }
  }
  const periods = [...periodCounts.entries()]
    .map(([period, lineCount]) => ({ period, lineCount }))
    .sort((a, b) => b.period.localeCompare(a.period, "en-US"));
  const selected = options.period ?? periods[0]?.period ?? null;
  if (selected === null) {
    return { periods, period: null, evaluation: combineFinopsAlerts([], { minSeverity: options.minSeverity }) };
  }

  const anomalyScope = options.anomalyConnectionIds === undefined
    ? new Set(connectionIds)
    : new Set(options.anomalyConnectionIds);
  const alerts: FinopsAlert[] = [];
  const combinedLines: NormalizedCurLine[] = [];
  let anomalyCount = 0;
  for (const connectionId of connectionIds) {
    const lines = await workspace.linesForPeriod(scope, connectionId, selected);
    // Every connection's lines feed the customer-wide budget burn-down…
    combinedLines.push(...lines);
    // …but anomalies only for the connections the caller asked about.
    if (!anomalyScope.has(connectionId)) continue;
    const anomalies = detectAnomalies(lines).anomalies;
    anomalyCount += anomalies.length;
    alerts.push(...buildAnomalyAlerts(anomalies, { connectionId, period: selected }));
  }

  // ONE customer-wide burn-down over every connection's combined spend.
  const budgets = await workspace.listBudgets(scope);
  const burndown = buildBudgetBurndown({
    budgets,
    dailyLines: combinedLines,
    period: selected,
    asOfDayIndex: asOfDayIndex(combinedLines),
    daysInMonth: daysInMonth(selected),
  });
  alerts.push(...buildBudgetAlerts(burndown.budgets, selected));

  return {
    periods,
    period: selected,
    evaluation: combineFinopsAlerts(alerts, {
      minSeverity: options.minSeverity,
      evaluated: { anomalies: anomalyCount, budgets: burndown.budgets.length },
    }),
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
