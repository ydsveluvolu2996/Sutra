import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNotificationSecretScope,
  normalizeNotificationDestinationConfig,
  NotificationDestinationValidationError,
} from "../lib/notification-destination-boundary.ts";

test("normalizes bounded email destination configuration", () => {
  assert.deepEqual(normalizeNotificationDestinationConfig({
    channel: "email",
    recipients: ["SECURITY@EXAMPLE.COM", "security@example.com", "soc@example.com"],
    fromAddress: "ALERTS@EXAMPLE.COM",
    sesRegion: "ap-south-1",
  }), {
    channel: "email",
    recipients: ["security@example.com", "soc@example.com"],
    fromAddress: "alerts@example.com",
    sesRegion: "ap-south-1",
  });
});

test("requires webhook secret references to remain inside the tenant and channel scope", () => {
  assert.doesNotThrow(() => assertNotificationSecretScope({
    channel: "slack",
    secretReference: "secret://notifications/org-a/customer-a/slack/primary",
  }, "org-a", "customer-a"));
  for (const reference of [
    "secret://notifications/org-a/customer-b/slack/primary",
    "secret://notifications/org-a/customer-a/microsoft_teams/primary",
    "secret://notifications/org-a/customer-a/slack/../customer-b",
  ]) {
    assert.throws(
      () => assertNotificationSecretScope({
        channel: "slack",
        secretReference: reference,
      }, "org-a", "customer-a"),
      NotificationDestinationValidationError,
    );
  }
});

test("allows opaque secret references and rejects raw provider URLs", () => {
  assert.deepEqual(normalizeNotificationDestinationConfig({
    channel: "slack",
    secretReference: "secret://notifications/slack/customer-a",
  }), {
    channel: "slack",
    secretReference: "secret://notifications/slack/customer-a",
  });
  for (const raw of [
    "https://hooks.slack.com/services/T/B/token",
    "https://prod-00.westus.logic.azure.com/workflows/example?sig=secret",
    "javascript:alert(1)",
  ]) {
    assert.throws(
      () => normalizeNotificationDestinationConfig({
        channel: "microsoft_teams",
        secretReference: raw,
      }),
      (error: unknown) =>
        error instanceof NotificationDestinationValidationError &&
        error.code === "INVALID_INPUT",
    );
  }
});

test("rejects unbounded recipients and invalid SES regions", () => {
  assert.throws(
    () => normalizeNotificationDestinationConfig({
      channel: "email",
      recipients: Array.from({ length: 21 }, (_, index) => `person-${index}@example.com`),
      fromAddress: "alerts@example.com",
      sesRegion: "ap-south-1",
    }),
    NotificationDestinationValidationError,
  );
  assert.throws(
    () => normalizeNotificationDestinationConfig({
      channel: "email",
      recipients: ["soc@example.com"],
      fromAddress: "alerts@example.com",
      sesRegion: "http://169.254.169.254",
    }),
    NotificationDestinationValidationError,
  );
});
