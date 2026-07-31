import { getConnectionForOrg, listConnectionsForOrg } from "../../../../../db/pilot-repository";
import { SecurityNotificationRepository } from "../../../../../db/security-notification-repository";
import {
  enqueueFinopsAlert,
  evaluateFinopsAlertsForCustomer,
  recipientsForDestination,
} from "../../../../../db/finops-alert-service";
import type { FinopsAlertSeverity } from "../../../../../lib/finops-alerts";
import {
  assertSessionCapability,
  requiredConfiguredPublicOrigin,
  requireApiSession,
} from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DESTINATION_ID = /^ndest_[a-f0-9]{32}$/u;
const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);

/**
 * Every connection belonging to this customer. Budgets are customer-wide, so the
 * burn-down must see all of them even when the operator selected just one.
 */
async function customerConnectionIds(orgId: string, customerId: string, selected: string): Promise<readonly string[]> {
  const owned = (await listConnectionsForOrg(orgId))
    .filter((connection) => connection.customerId === customerId && CONNECTION_ID.test(connection.id))
    .map((connection) => connection.id);
  return owned.includes(selected) ? owned : [...owned, selected];
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
    const orgId = authenticated.subject.orgId;
    const result = await evaluateFinopsAlertsForCustomer(
      orgId,
      connection.customerId,
      await customerConnectionIds(orgId, connection.customerId, connectionId),
      {
        period,
        minSeverity: (minSeverity ?? undefined) as FinopsAlertSeverity | undefined,
        anomalyConnectionIds: [connectionId],
      },
    );
    // Surface the enabled destinations so the panel can offer a send target
    // without a second round-trip (customer resolved from the connection).
    const destinations = (await new SecurityNotificationRepository().listDestinations(orgId, connection.customerId))
      .filter((destination) => destination.enabled)
      .map((destination) => ({ id: destination.id, channel: destination.channel, displayName: destination.displayName }));
    return jsonResponse({ connectionId, period: result.period, periods: result.periods, destinations, ...result.evaluation });
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

    const result = await evaluateFinopsAlertsForCustomer(
      orgId,
      customerId,
      await customerConnectionIds(orgId, customerId, connectionId),
      {
        period: period ?? null,
        minSeverity: (minSeverity ?? undefined) as FinopsAlertSeverity | undefined,
        anomalyConnectionIds: [connectionId],
      },
    );
    const recipients = recipientsForDestination(destination);
    const dispatched = await Promise.allSettled(result.evaluation.alerts.map((alert) =>
      enqueueFinopsAlert(notifications, {
        orgId,
        customerId,
        connectionId,
        destinationId: destination.id,
        recipients,
        alert,
        publicOrigin: requiredConfiguredPublicOrigin(),
      }),
    ));

    return jsonResponse({
      connectionId,
      period: result.period,
      destination: { id: destination.id, channel: destination.channel },
      alertCount: result.evaluation.alerts.length,
      queued: dispatched.filter((entry) => entry.status === "fulfilled").length,
      queueFailures: dispatched.filter((entry) => entry.status === "rejected").length,
      counts: result.evaluation.counts,
      alerts: result.evaluation.alerts,
      providerDeliveryAttempted: false,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
