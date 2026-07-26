import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { SecurityNotificationRepository } from "../../../../../db/security-notification-repository";
import { detectAnomalies } from "../../../../../lib/finops-insights";
import { buildBudgetBurndown } from "../../../../../lib/finops-budget-burndown";
import { evaluateFinopsAlerts, type FinopsAlert, type FinopsAlertSeverity } from "../../../../../lib/finops-alerts";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../../../../../lib/security-notifications";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DESTINATION_ID = /^ndest_[a-f0-9]{32}$/u;
const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);
const PUBLIC_ORIGIN = "https://app.sutracmdb.com";
const REPORT_URL = "https://app.sutracmdb.com/costs";

async function evidenceHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** How many days of the billing period the ingested lines actually cover. */
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

/** Evaluate current cost/budget alerts for a connection's selected period. */
async function evaluateForConnection(
  orgId: string,
  connectionId: string,
  period: string | null,
  minSeverity: FinopsAlertSeverity | undefined,
  customerId: string,
) {
  const workspace = new FinopsWorkspaceRepository();
  const scope = { orgId, customerId };
  const periods = await workspace.listPeriods(scope, connectionId);
  const selected = period ?? periods[0]?.period ?? null;
  if (selected === null) {
    return { periods, period: null, evaluation: evaluateFinopsAlerts({ anomalies: [], budgets: [], minSeverity }) };
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
    evaluation: evaluateFinopsAlerts({ anomalies, budgets: burndown.budgets, minSeverity }),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const period = url.searchParams.get("period");
    const minSeverity = url.searchParams.get("minSeverity");
    if (
      !CONNECTION_ID.test(connectionId) ||
      (period !== null && !BILLING_PERIOD.test(period)) ||
      (minSeverity !== null && !SEVERITIES.has(minSeverity))
    ) {
      throw Object.assign(new Error("The alerts request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const result = await evaluateForConnection(
      authenticated.subject.orgId, connectionId, period,
      (minSeverity ?? undefined) as FinopsAlertSeverity | undefined, connection.customerId,
    );
    return jsonResponse({ connectionId, period: result.period, periods: result.periods, ...result.evaluation });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The alerts request is invalid"), { code: "INVALID_INPUT" });
    }
    const { connectionId, destinationId, period, minSeverity } = body as {
      connectionId?: unknown; destinationId?: unknown; period?: unknown; minSeverity?: unknown;
    };
    if (
      typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId) ||
      typeof destinationId !== "string" || !DESTINATION_ID.test(destinationId) ||
      (period !== undefined && (typeof period !== "string" || !BILLING_PERIOD.test(period))) ||
      (minSeverity !== undefined && (typeof minSeverity !== "string" || !SEVERITIES.has(minSeverity)))
    ) {
      throw Object.assign(new Error("The alerts request is invalid"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    // Dispatch is a mutation: require manage on this customer.
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const orgId = authenticated.subject.orgId;
    const customerId = connection.customerId;

    const notifications = new SecurityNotificationRepository();
    // Resolve the chosen destination from the tenant's OWN destinations — never
    // trust a caller-supplied URL. A disabled or foreign destination resolves to
    // nothing and the dispatch is rejected.
    const destination = (await notifications.listDestinations(orgId, customerId))
      .find((candidate) => candidate.id === destinationId && candidate.enabled);
    if (destination === undefined) {
      throw Object.assign(new Error("No enabled notification destination matches"), { code: "NOT_FOUND" });
    }

    const result = await evaluateForConnection(
      orgId, connectionId, period ?? null,
      (minSeverity ?? undefined) as FinopsAlertSeverity | undefined, customerId,
    );
    const recipients = destination.configuration.channel === "email"
      ? destination.configuration.recipients
      : ["notifications@sutracmdb.com"];

    const dispatched = await Promise.allSettled(result.evaluation.alerts.map(async (alert: FinopsAlert) => {
      const eventId = `notify_${(await evidenceHash(`finops-alert\0${alert.id}`)).slice(0, 48)}`;
      const notificationEvent = normalizeSecurityNotificationEvent({
        eventId,
        orgId,
        customerId,
        clusterId: `finops:${connectionId}`,
        severity: alert.severity,
        title: alert.title,
        summary: alert.summary,
        occurredAt: new Date().toISOString(),
        findingCount: 1,
        reportUrl: REPORT_URL,
        evidenceSha256: await evidenceHash(`finops-alert-evidence\0${alert.id}\0${alert.summary}`),
      }, PUBLIC_ORIGIN);
      const payloads = await buildSecurityNotificationPayloads({ event: notificationEvent, emailRecipients: recipients });
      return notifications.enqueue({
        orgId,
        customerId,
        destinationId: destination.id,
        idempotencyKey: alert.id,
        event: notificationEvent,
        payloads,
      });
    }));

    return jsonResponse({
      connectionId,
      period: result.period,
      destination: { id: destination.id, channel: destination.channel },
      alertCount: result.evaluation.alerts.length,
      queued: dispatched.filter((entry) => entry.status === "fulfilled").length,
      queueFailures: dispatched.filter((entry) => entry.status === "rejected").length,
      counts: result.evaluation.counts,
      // Preview of what was routed — no secrets, no destination URL.
      alerts: result.evaluation.alerts,
      providerDeliveryAttempted: false,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
