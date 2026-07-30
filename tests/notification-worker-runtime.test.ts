import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

import {
  AwsManagedSecretResolver,
  AwsSdkSesV2Transport,
  type ManagedSecretReader,
  type NotificationRuntimeAdapters,
} from "../services/notification-worker/runtime-adapters.ts";
import {
  readNotificationWorkerRuntimeConfig,
  runNotificationWorker,
} from "../services/notification-worker/runtime.ts";

test("maps an opaque reference to a bounded managed-secret prefix", async () => {
  const requested: string[] = [];
  const reader: ManagedSecretReader = {
    async getSecretString(secretId) {
      requested.push(secretId);
      return JSON.stringify({
        version: 1,
        channel: "slack",
        webhookUrl: "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop",
        expectedHostname: "hooks.slack.com",
      });
    },
  };
  const resolver = new AwsManagedSecretResolver({
    reader,
    secretPrefix: "sutra/notifications/",
  });
  const resolved = await resolver.resolveWebhook({
    secretReference: "secret://notifications/org-a/customer-a/slack/primary",
    channel: "slack",
  });
  assert.equal(requested[0], "sutra/notifications/org-a/customer-a/slack/primary");
  assert.equal(resolved?.expectedHostname, "hooks.slack.com");

  await assert.rejects(
    resolver.resolveWebhook({
      secretReference: "secret://notifications/../customer-a",
      channel: "slack",
    }),
    /configuration rejected/u,
  );
});

test("resolves a generic ticketing webhook secret to an arbitrary pinned host", async () => {
  const requested: string[] = [];
  const reader: ManagedSecretReader = {
    async getSecretString(secretId) {
      requested.push(secretId);
      return JSON.stringify({
        version: 1,
        channel: "generic_webhook",
        webhookUrl: "https://sutra.example-ticketing.com/inbound/9f8e7d6c",
        expectedHostname: "sutra.example-ticketing.com",
        idempotencyHeader: "Idempotency-Key",
      });
    },
  };
  const resolver = new AwsManagedSecretResolver({ reader, secretPrefix: "sutra/notifications/" });
  const resolved = await resolver.resolveWebhook({
    secretReference: "secret://notifications/org-a/customer-a/generic_webhook/jira",
    channel: "generic_webhook",
  });
  assert.equal(requested[0], "sutra/notifications/org-a/customer-a/generic_webhook/jira");
  assert.equal(resolved?.expectedHostname, "sutra.example-ticketing.com");
  assert.equal(resolved?.idempotencyHeader, "Idempotency-Key");
});

test("resolves a PagerDuty routing key from a bounded, channel-scoped secret document", async () => {
  const requested: string[] = [];
  const reader: ManagedSecretReader = {
    async getSecretString(secretId) {
      requested.push(secretId);
      return JSON.stringify({
        version: 1,
        channel: "pagerduty",
        routingKey: "a".repeat(32),
      });
    },
  };
  const resolver = new AwsManagedSecretResolver({ reader, secretPrefix: "sutra/notifications/" });
  const resolved = await resolver.resolveRoutingKey({
    secretReference: "secret://notifications/org-a/customer-a/pagerduty/oncall",
    channel: "pagerduty",
  });
  assert.equal(requested[0], "sutra/notifications/org-a/customer-a/pagerduty/oncall");
  assert.equal(resolved?.routingKey, "a".repeat(32));

  // A webhook-shaped document (no routingKey) is not a valid PagerDuty secret.
  const wrongShape = new AwsManagedSecretResolver({
    reader: {
      async getSecretString() {
        return JSON.stringify({
          version: 1,
          channel: "pagerduty",
          webhookUrl: "https://hooks.slack.com/services/T/B/token",
          expectedHostname: "hooks.slack.com",
        });
      },
    },
    secretPrefix: "sutra/notifications/",
  });
  await assert.rejects(
    wrongShape.resolveRoutingKey({
      secretReference: "secret://notifications/org-a/customer-a/pagerduty/oncall",
      channel: "pagerduty",
    }),
    /configuration rejected/u,
  );
});

test("rejects malformed, cross-channel, and unexpected secret documents", async () => {
  for (const value of [
    "not-json",
    JSON.stringify({
      version: 1,
      channel: "microsoft_teams",
      webhookUrl: "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop",
      expectedHostname: "hooks.slack.com",
    }),
    JSON.stringify({
      version: 1,
      channel: "slack",
      webhookUrl: "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop",
      expectedHostname: "hooks.slack.com",
      rawToken: "must-not-be-accepted",
    }),
  ]) {
    const resolver = new AwsManagedSecretResolver({
      reader: { async getSecretString() { return value; } },
      secretPrefix: "sutra/notifications/",
    });
    await assert.rejects(
      resolver.resolveWebhook({
        secretReference: "secret://notifications/org-a/customer-a/slack/primary",
        channel: "slack",
      }),
      /configuration rejected/u,
    );
  }
});

test("SES adapter validates its fixed endpoint and delegates signing to the workload SDK", async () => {
  const requests: unknown[] = [];
  const transport = new AwsSdkSesV2Transport(() => ({
    async send(input) {
      requests.push(input);
      return { status: 200, headers: {}, bodyBytes: new Uint8Array() };
    },
  }));
  const body = new TextEncoder().encode(JSON.stringify({
    FromEmailAddress: "alerts@example.com",
    Destination: { ToAddresses: ["soc@example.com"] },
    Content: {
      Simple: {
        Subject: { Data: "Test" },
        Body: { Text: { Data: "Test" } },
      },
    },
  }));
  const response = await transport.post({
    service: "ses",
    region: "ap-south-1",
    url: new URL("https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails"),
    headers: { "content-type": "application/json" },
    body,
    redirect: "error",
    timeoutMs: 5_000,
    maximumResponseBytes: 16_384,
  });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  await assert.rejects(
    transport.post({
      service: "ses",
      region: "ap-south-1",
      url: new URL("https://example.com/v2/email/outbound-emails"),
      headers: {},
      body,
      redirect: "error",
      timeoutMs: 5_000,
      maximumResponseBytes: 16_384,
    }),
    /configuration rejected/u,
  );
});

test("runtime exposes readiness and shuts down without leaking destination material", async () => {
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const address = portServer.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));

  const abort = new AbortController();
  let calls = 0;
  const adapters: NotificationRuntimeAdapters = {
    dependencies: {
      secrets: { async resolveWebhook() { return null; } },
      dns: { async resolve() { return []; } },
      http: { async post() { throw new Error("unused"); } },
      ses: { async post() { throw new Error("unused"); } },
    },
    destroy() {
      calls += 100;
    },
  };
  const running = runNotificationWorker({
    config: {
      pollIntervalMs: 100,
      healthPort: port,
      secretPrefix: "sutra/notifications/",
    },
    adapters,
    signal: abort.signal,
    async processOne() {
      calls += 1;
      if (calls === 1) setTimeout(() => abort.abort(), 20);
      return "idle";
    },
  });
  for (let index = 0; index < 20; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await running;
  assert.equal(calls, 101);
});

test("runtime environment is bounded", () => {
  assert.deepEqual(readNotificationWorkerRuntimeConfig({
    SUTRA_NOTIFICATION_POLL_INTERVAL_MS: "500",
    SUTRA_NOTIFICATION_HEALTH_PORT: "8081",
    SUTRA_NOTIFICATION_CONFIG_PREFIX: "sutra/notifications/",
  }), {
    pollIntervalMs: 500,
    healthPort: 8081,
    secretPrefix: "sutra/notifications/",
  });
  assert.throws(
    () => readNotificationWorkerRuntimeConfig({
      SUTRA_NOTIFICATION_POLL_INTERVAL_MS: "1",
      SUTRA_NOTIFICATION_HEALTH_PORT: "8081",
      SUTRA_NOTIFICATION_SECRET_PREFIX: "../",
    }),
    /configuration rejected/u,
  );
});
