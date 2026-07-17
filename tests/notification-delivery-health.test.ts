import assert from "node:assert/strict";
import test from "node:test";

import { assessNotificationDeliveryHealth } from "../lib/notification-delivery-health.ts";
import type {
  NotificationDestination,
  NotificationOutboxJob,
} from "../lib/notification-destination-types.ts";

const destination: NotificationDestination = {
  id: `ndest_${"a".repeat(32)}`,
  orgId: "org_sutra",
  customerId: "cust_customer",
  channel: "email",
  displayName: "Security email",
  enabled: true,
  configuration: {
    channel: "email",
    recipients: ["security@example.com"],
    fromAddress: "alerts@example.com",
    sesRegion: "ap-south-1",
  },
  deliveryReadiness: "configured",
  createdAt: "2026-07-17T08:00:00.000Z",
  updatedAt: "2026-07-17T08:00:00.000Z",
};

function job(
  status: NotificationOutboxJob["status"],
  createdAt = "2026-07-17T08:59:00.000Z",
): NotificationOutboxJob {
  return {
    id: `njob_${"b".repeat(32)}`,
    destinationId: destination.id,
    channel: "email",
    status,
    attemptCount: status === "delivered" ? 1 : 0,
    nextAttemptAt: createdAt,
    lastErrorCode: null,
    createdAt,
    deliveredAt: status === "delivered" ? createdAt : null,
  };
}

test("reports healthy only when worker and enabled destination adapters are ready", () => {
  const health = assessNotificationDeliveryHealth({
    destinations: [destination],
    jobs: [job("delivered")],
    workerConfigured: true,
    now: Date.parse("2026-07-17T09:00:00.000Z"),
  });
  assert.equal(health.state, "healthy");
  assert.equal(health.delivered, 1);
});

test("reports blocked delivery without claiming provider readiness", () => {
  const health = assessNotificationDeliveryHealth({
    destinations: [{ ...destination, deliveryReadiness: "adapter_not_configured" }],
    jobs: [job("not_configured")],
    workerConfigured: false,
    now: Date.parse("2026-07-17T09:00:00.000Z"),
  });
  assert.equal(health.state, "blocked");
  assert.equal(health.adapterMissing, 1);
  assert.match(health.message, /not configured/u);
});

test("reports delayed and dead-lettered delivery as degraded", () => {
  const health = assessNotificationDeliveryHealth({
    destinations: [destination],
    jobs: [job("pending", "2026-07-17T08:50:00.000Z"), job("dead_letter")],
    workerConfigured: true,
    now: Date.parse("2026-07-17T09:00:00.000Z"),
  });
  assert.equal(health.state, "degraded");
  assert.equal(health.oldestActionableAgeSeconds, 600);
  assert.equal(health.deadLetter, 1);
});
