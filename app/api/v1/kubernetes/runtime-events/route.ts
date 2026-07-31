import { FalcoRuntimeRepository } from "../../../../../db/falco-runtime-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { RuntimeEventCaseRepository } from "../../../../../db/runtime-event-case-repository";
import { SecurityNotificationRepository } from "../../../../../db/security-notification-repository";
import {
  assertSessionCapability,
  requiredConfiguredPublicOrigin,
  requireApiSession,
} from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { parseCasePriority } from "../../../../../lib/case-management";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../../../../../lib/security-notifications";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const EVENT_ID = /^frte_[a-f0-9]{48}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function invalid(): never {
  throw Object.assign(new Error("Runtime event query rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId", "limit"].includes(key))) {
      invalid();
    }
    const connectionId = url.searchParams.get("connectionId");
    const clusterId = url.searchParams.get("clusterId");
    const limitText = url.searchParams.get("limit") ?? "100";
    if (
      connectionId === null || !CONNECTION_ID.test(connectionId) ||
      clusterId === null || !CLUSTER_ID.test(clusterId) ||
      !/^\d{1,3}$/u.test(limitText)
    ) invalid();
    const limit = Number(limitText);
    if (limit < 1 || limit > 500) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      clusterId,
    };
    const [workspace, cases] = await Promise.all([
      new FalcoRuntimeRepository().workspace(scope, limit),
      new RuntimeEventCaseRepository().list({
        ...scope,
        connectionId,
      }),
    ]);
    const casesByEvent = new Map(cases.map((item) => [item.sourceId, item]));
    return jsonResponse({
      ...workspace,
      timeline: workspace.timeline.map((item) => ({
        ...item,
        caseId: casesByEvent.get(item.id)?.id ?? null,
        caseNumber: casesByEvent.get(item.id)?.caseNumber ?? null,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function evidenceHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, 8 * 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const input = body as Record<string, unknown>;
    const allowed = ["operation", "connectionId", "clusterId", "eventId", "evidenceSha256", "priority"];
    if (
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      allowed.some((key) => !(key in input)) ||
      input.operation !== "create_case" ||
      typeof input.connectionId !== "string" || !CONNECTION_ID.test(input.connectionId) ||
      typeof input.clusterId !== "string" || !CLUSTER_ID.test(input.clusterId) ||
      typeof input.eventId !== "string" || !EVENT_ID.test(input.eventId) ||
      typeof input.evidenceSha256 !== "string" || !HASH.test(input.evidenceSha256)
    ) invalid();
    const priority = parseCasePriority(input.priority);
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      input.connectionId,
    );
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "finding:manage", connection.customerId);
    const created = await new RuntimeEventCaseRepository().create({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: input.connectionId,
      clusterId: input.clusterId,
      eventId: input.eventId,
      evidenceSha256: input.evidenceSha256,
      priority,
      actorUserId: authenticated.subject.userId,
    });

    const notifications = new SecurityNotificationRepository();
    const destinations = (await notifications.listDestinations(
      authenticated.subject.orgId,
      connection.customerId,
    )).filter((destination) => destination.enabled);
    const notificationEventId = `notify_${(await evidenceHash(`case\0${created.id}`)).slice(0, 48)}`;
    const publicOrigin = requiredConfiguredPublicOrigin();
    const notificationEvent = normalizeSecurityNotificationEvent({
      eventId: notificationEventId,
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      clusterId: created.clusterId,
      severity: created.priority,
      title: created.title,
      summary: `A human-approved case ${created.caseNumber} was created from immutable Falco runtime evidence. Automatic containment remains disabled.`,
      occurredAt: created.createdAt,
      findingCount: 1,
      reportUrl:
        `${publicOrigin}/kubernetes/runtime?connectionId=${encodeURIComponent(input.connectionId)}`
        + `#runtime-event-${encodeURIComponent(created.sourceId)}`,
      evidenceSha256: created.evidenceSha256,
    }, publicOrigin);
    const queued = await Promise.allSettled(destinations.map(async (destination) => {
      const recipients = destination.configuration.channel === "email"
        ? destination.configuration.recipients
        : ["notifications@sutracmdb.com"];
      const payloads = await buildSecurityNotificationPayloads({
        event: notificationEvent,
        emailRecipients: recipients,
      });
      return notifications.enqueue({
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
        destinationId: destination.id,
        idempotencyKey: `runtime-case:${created.id}`,
        event: notificationEvent,
        payloads,
      });
    }));
    return jsonResponse({
      case: created,
      notificationRouting: {
        configuredDestinations: destinations.length,
        queued: queued.filter((result) => result.status === "fulfilled").length,
        queueFailures: queued.filter((result) => result.status === "rejected").length,
        providerDeliveryAttempted: false,
      },
      automaticContainment: false,
      humanApproved: true,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
