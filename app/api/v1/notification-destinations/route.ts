import {
  SecurityNotificationRepository,
} from "../../../../db/security-notification-repository";
import {
  assertNotificationSecretScope,
  normalizeNotificationDestinationConfig,
} from "../../../../lib/notification-destination-boundary";
import { appendAuditEvent } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import type { NotificationDestinationConfig } from "../../../../lib/notification-destination-types";
import { assessNotificationDeliveryHealth } from "../../../../lib/notification-delivery-health";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../../../../lib/security-notifications";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;
const DESTINATION_ID = /^ndest_[a-f0-9]{32}$/u;
const CHANNELS = new Set(["email", "slack", "microsoft_teams", "generic_webhook", "pagerduty"]);

function invalid(message = "The notification destination request is invalid"): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT", status: 400 });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in record))
  ) invalid();
  return record;
}

function customerId(value: unknown): string {
  if (typeof value !== "string" || !CUSTOMER_ID.test(value)) invalid();
  return value;
}

function configuration(value: unknown): NotificationDestinationConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const config = value as Record<string, unknown>;
  if (config.channel === "email") {
    const parsed = exact(config, ["channel", "recipients", "fromAddress", "sesRegion"]);
    if (
      !Array.isArray(parsed.recipients) ||
      !parsed.recipients.every((item) => typeof item === "string") ||
      typeof parsed.fromAddress !== "string" ||
      typeof parsed.sesRegion !== "string"
    ) invalid();
    return normalizeNotificationDestinationConfig({
      channel: "email",
      recipients: parsed.recipients,
      fromAddress: parsed.fromAddress,
      sesRegion: parsed.sesRegion,
    });
  }
  if (
    config.channel === "slack" ||
    config.channel === "microsoft_teams" ||
    config.channel === "generic_webhook" ||
    config.channel === "pagerduty"
  ) {
    const parsed = exact(config, ["channel", "secretReference"]);
    if (typeof parsed.secretReference !== "string") invalid();
    return normalizeNotificationDestinationConfig({
      channel: config.channel,
      secretReference: parsed.secretReference,
    });
  }
  return invalid();
}

async function evidenceHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "customerId")) invalid();
    const scopedCustomerId = customerId(url.searchParams.get("customerId"));
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:read", scopedCustomerId);
    const repository = new SecurityNotificationRepository();
    const [storedDestinations, jobs] = await Promise.all([
      repository.listDestinations(authenticated.subject.orgId, scopedCustomerId),
      repository.listJobs(authenticated.subject.orgId, scopedCustomerId),
    ]);
    const workerConfigured = process.env.SUTRA_NOTIFICATION_WORKER_CONFIGURED === "true";
    const destinations = storedDestinations.map((destination) => ({
      ...destination,
      deliveryReadiness: workerConfigured
        ? "configured" as const
        : "adapter_not_configured" as const,
    }));
    return jsonResponse({
      destinations,
      jobs,
      worker: {
        configured: workerConfigured,
        message: workerConfigured
          ? "The notification worker is configured. Delivery outcomes remain visible in the durable outbox."
          : "Delivery remains queued until the notification worker receives managed-secret and workload-IAM adapters.",
      },
      health: assessNotificationDeliveryHealth({
        destinations,
        jobs,
        workerConfigured,
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, 32 * 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;
    if (record.operation === "save") {
      const input = exact(record, [
        "operation", "customerId", "displayName", "enabled", "configuration",
      ]);
      const scopedCustomerId = customerId(input.customerId);
      assertSessionCapability(authenticated, "connection:manage", scopedCustomerId);
      if (
        typeof input.displayName !== "string" ||
        typeof input.enabled !== "boolean"
      ) invalid();
      const parsedConfiguration = configuration(input.configuration);
      if (!CHANNELS.has(parsedConfiguration.channel)) invalid();
      assertNotificationSecretScope(
        parsedConfiguration,
        authenticated.subject.orgId,
        scopedCustomerId,
      );
      const destination = await new SecurityNotificationRepository().upsertDestination({
        orgId: authenticated.subject.orgId,
        customerId: scopedCustomerId,
        actorId: authenticated.subject.userId,
        displayName: input.displayName,
        enabled: input.enabled,
        configuration: parsedConfiguration,
      });
      await appendAuditEvent({
        orgId: authenticated.subject.orgId,
        actorId: authenticated.subject.userId,
        action: "security.notification_destination.saved",
        targetType: "notification_destination",
        targetId: destination.id,
        customerId: scopedCustomerId,
        outcome: "allowed",
        requestId: `notification.destination.saved:${destination.id}:${destination.updatedAt}`,
        metadata: {
          channel: destination.channel,
          enabled: destination.enabled,
          secretReferenceStored: destination.channel !== "email",
          rawWebhookStored: false,
        },
      });
      return jsonResponse({ destination }, { status: 201 });
    }
    if (record.operation === "test") {
      const input = exact(record, ["operation", "customerId", "destinationId", "idempotencyKey"]);
      const scopedCustomerId = customerId(input.customerId);
      assertSessionCapability(authenticated, "connection:manage", scopedCustomerId);
      if (
        typeof input.destinationId !== "string" ||
        !DESTINATION_ID.test(input.destinationId) ||
        typeof input.idempotencyKey !== "string"
      ) invalid();
      const repository = new SecurityNotificationRepository();
      const destination = (await repository.listDestinations(
        authenticated.subject.orgId,
        scopedCustomerId,
      )).find((candidate) => candidate.id === input.destinationId && candidate.enabled);
      if (destination === undefined) {
        throw Object.assign(new Error("Notification destination not found"), { code: "NOT_FOUND" });
      }
      const eventId = `notify_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const publicOrigin = "https://app.sutracmdb.com";
      const event = normalizeSecurityNotificationEvent({
        eventId,
        orgId: authenticated.subject.orgId,
        customerId: scopedCustomerId,
        clusterId: "notification-test",
        severity: "medium",
        title: "Sutra notification delivery test",
        summary: "This bounded test confirms that the destination is queued correctly. It does not invoke a provider from the web request.",
        occurredAt: new Date().toISOString(),
        findingCount: 1,
        reportUrl: `${publicOrigin}/settings/notifications`,
        evidenceSha256: await evidenceHash(`${authenticated.subject.orgId}\0${scopedCustomerId}\0${input.idempotencyKey}`),
      }, publicOrigin);
      const emailRecipients = destination.configuration.channel === "email"
        ? destination.configuration.recipients
        : ["notifications@sutracmdb.com"];
      const payloads = await buildSecurityNotificationPayloads({ event, emailRecipients });
      const job = await repository.enqueue({
        orgId: authenticated.subject.orgId,
        customerId: scopedCustomerId,
        destinationId: destination.id,
        idempotencyKey: input.idempotencyKey,
        event,
        payloads,
      });
      await appendAuditEvent({
        orgId: authenticated.subject.orgId,
        actorId: authenticated.subject.userId,
        action: "security.notification_test.queued",
        targetType: "notification_outbox_job",
        targetId: job.id,
        customerId: scopedCustomerId,
        outcome: "allowed",
        requestId: `notification.test.queued:${job.id}`,
        metadata: { destinationId: destination.id, channel: destination.channel },
      });
      return jsonResponse({ job }, { status: 202 });
    }
    return invalid();
  } catch (error) {
    return errorResponse(error);
  }
}
