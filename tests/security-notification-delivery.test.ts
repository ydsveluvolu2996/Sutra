import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverSecurityNotification,
  isPublicNotificationAddress,
  SecurityNotificationDeliveryError,
  type NotificationHttpResponse,
  type SecurityNotificationDeliveryDependencies,
} from "../lib/security-notification-delivery.ts";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../lib/security-notifications.ts";

const deliveryId = `notify_${"a".repeat(48)}`;

async function payloads(severity: "critical" | "high" | "medium" | "low" = "critical") {
  const event = normalizeSecurityNotificationEvent({
    eventId: deliveryId,
    orgId: "org_sutra",
    customerId: "cust_customer",
    clusterId: "cluster_customer",
    severity,
    title: "Runtime threat detected",
    summary: "A privileged shell was detected in the production namespace.",
    occurredAt: "2026-07-17T08:30:00.000Z",
    findingCount: 1,
    reportUrl: "https://app.sutracmdb.com/security/runtime/example",
    evidenceSha256: "b".repeat(64),
  }, "https://app.sutracmdb.com");
  return buildSecurityNotificationPayloads({
    event,
    emailRecipients: ["security@example.com"],
  });
}

const ROUTING_KEY = "a".repeat(32);

function pagerdutyDependencies(input: {
  readonly routingKey?: string | null;
  readonly withResolver?: boolean;
  readonly dnsAddresses?: readonly string[];
  readonly responseStatus?: number;
} = {}): {
  readonly dependencies: SecurityNotificationDeliveryDependencies;
  readonly calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const withResolver = input.withResolver ?? true;
  const routingKey = input.routingKey === undefined ? ROUTING_KEY : input.routingKey;
  return {
    calls,
    dependencies: {
      secrets: {
        async resolveWebhook() { return null; },
        ...(withResolver
          ? {
              async resolveRoutingKey({ channel }) {
                assert.equal(channel, "pagerduty");
                return routingKey === null ? null : { routingKey };
              },
            }
          : {}),
      },
      dns: {
        async resolve() { return input.dnsAddresses ?? ["8.8.8.8"]; },
      },
      http: {
        async post(request) {
          calls.push({ ...request });
          return successfulResponse(input.responseStatus ?? 202);
        },
      },
      ses: { async post() { return successfulResponse(200); } },
    },
  };
}

function successfulResponse(status = 200): NotificationHttpResponse {
  return { status, headers: {}, bodyBytes: Buffer.from("ok") };
}

function dependencies(overrides: Partial<SecurityNotificationDeliveryDependencies> = {}): {
  readonly dependencies: SecurityNotificationDeliveryDependencies;
  readonly calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    dependencies: {
      secrets: {
        async resolveWebhook({ channel }) {
          return channel === "slack" ? {
            webhookUrl: "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop",
            expectedHostname: "hooks.slack.com",
          } : {
            webhookUrl: "https://prod-00.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-10-01&sig=secret",
            expectedHostname: "prod-00.westus.logic.azure.com",
            idempotencyHeader: "Idempotency-Key",
          };
        },
      },
      dns: {
        async resolve() {
          return ["8.8.8.8", "2606:4700:4700::1111"];
        },
      },
      http: {
        async post(input) {
          calls.push({ kind: "webhook", ...input });
          return successfulResponse(200);
        },
      },
      ses: {
        async post(input) {
          calls.push({ kind: "ses", ...input });
          return successfulResponse(200);
        },
      },
      ...overrides,
    },
  };
}

test("delivers SES v2, Slack, and Teams through bounded injected transports", async () => {
  const fixture = dependencies();
  const results = await deliverSecurityNotification({
    deliveryId,
    payloads: await payloads(),
    destinations: {
      email: { region: "ap-south-1", fromAddress: "alerts@sutracmdb.com" },
      slackSecretReference: "secret://notifications/slack/customer",
      microsoftTeamsSecretReference: "secret://notifications/teams/customer",
    },
    dependencies: fixture.dependencies,
  });
  assert.deepEqual(results.map((result) => [result.channel, result.status]), [
    ["email", "delivered"],
    ["slack", "delivered"],
    ["microsoft_teams", "delivered"],
  ]);

  const ses = fixture.calls.find((call) => call.kind === "ses");
  assert.equal(String(ses?.url), "https://email.ap-south-1.amazonaws.com/v2/email/outbound-emails");
  assert.equal(ses?.service, "ses");
  assert.equal(ses?.timeoutMs, 5_000);
  assert.equal(ses?.redirect, "error");
  assert.equal("accessKeyId" in (ses ?? {}), false);

  const webhooks = fixture.calls.filter((call) => call.kind === "webhook");
  assert.equal(webhooks.length, 2);
  assert.ok(webhooks.every((call) => call.timeoutMs === 5_000 && call.redirect === "error"));
  const teams = webhooks.find((call) => String(call.url).includes("logic.azure.com"));
  assert.equal((teams?.headers as Record<string, string>)["Idempotency-Key"], deliveryId);
  const slack = webhooks.find((call) => String(call.url).includes("hooks.slack.com"));
  assert.equal("Idempotency-Key" in (slack?.headers as Record<string, string>), false);
});

test("uses secret references only and rejects hostile provider destinations", async () => {
  const unsafeCases = [
    {
      webhookUrl: "http://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop",
      expectedHostname: "hooks.slack.com",
    },
    {
      webhookUrl: "https://hooks.slack.com.attacker.example/services/T12345678/B12345678/abcdefghijklmnop",
      expectedHostname: "hooks.slack.com.attacker.example",
    },
    {
      webhookUrl: "https://hooks.slack.com@attacker.example/services/T12345678/B12345678/abcdefghijklmnop",
      expectedHostname: "attacker.example",
    },
    {
      webhookUrl: "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop#leak",
      expectedHostname: "hooks.slack.com",
    },
  ];
  for (const resolved of unsafeCases) {
    const fixture = dependencies({
      secrets: { async resolveWebhook() { return resolved; } },
    });
    await assert.rejects(
      deliverSecurityNotification({
        deliveryId,
        payloads: await payloads(),
        destinations: { slackSecretReference: "secret://notifications/slack/customer" },
        dependencies: fixture.dependencies,
      }),
      (error: unknown) =>
        error instanceof SecurityNotificationDeliveryError &&
        error.code === "UNSAFE_DESTINATION",
    );
    assert.equal(fixture.calls.length, 0);
  }

  const fixture = dependencies();
  await assert.rejects(
    deliverSecurityNotification({
      deliveryId,
      payloads: await payloads(),
      destinations: {
        slackSecretReference: "https://hooks.slack.com/services/raw/secrets/forbidden",
      },
      dependencies: fixture.dependencies,
    }),
    SecurityNotificationDeliveryError,
  );
  assert.equal(fixture.calls.length, 0);
});

test("blocks private, link-local, loopback, documentation, and mixed DNS answers", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.20.1.2",
    "192.168.1.1",
    "192.0.2.1",
    "198.51.100.2",
    "203.0.113.3",
    "::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:ffff:7f00:1",
  ]) assert.equal(isPublicNotificationAddress(address), false, address);
  assert.equal(isPublicNotificationAddress("8.8.8.8"), true);
  assert.equal(isPublicNotificationAddress("2606:4700:4700::1111"), true);

  const fixture = dependencies({
    dns: { async resolve() { return ["8.8.8.8", "169.254.169.254"]; } },
  });
  await assert.rejects(
    deliverSecurityNotification({
      deliveryId,
      payloads: await payloads(),
      destinations: { slackSecretReference: "secret://notifications/slack/customer" },
      dependencies: fixture.dependencies,
    }),
    (error: unknown) =>
      error instanceof SecurityNotificationDeliveryError &&
      error.code === "UNSAFE_DESTINATION",
  );
  assert.equal(fixture.calls.length, 0);
});

test("sanitizes secret-store and DNS transport failures", async () => {
  const secretFailure = dependencies({
    secrets: {
      async resolveWebhook() {
        throw new Error("secret://notifications/slack/customer and raw vault details");
      },
    },
  });
  const [secretResult] = await deliverSecurityNotification({
    deliveryId,
    payloads: await payloads(),
    destinations: { slackSecretReference: "secret://notifications/slack/customer" },
    dependencies: secretFailure.dependencies,
  });
  assert.deepEqual(secretResult, {
    channel: "slack",
    status: "retryable_failure",
    providerStatus: null,
    errorCode: "TRANSPORT_FAILURE",
    retryAfterSeconds: null,
  });

  const dnsFailure = dependencies({
    dns: {
      async resolve() {
        throw new Error("resolver included private provider details");
      },
    },
  });
  const [dnsResult] = await deliverSecurityNotification({
    deliveryId,
    payloads: await payloads(),
    destinations: { slackSecretReference: "secret://notifications/slack/customer" },
    dependencies: dnsFailure.dependencies,
  });
  assert.equal(dnsResult.errorCode, "TRANSPORT_FAILURE");
  assert.equal("message" in dnsResult, false);
});

test("classifies throttles, provider failures, permanent failures, and timeouts", async () => {
  for (const [status, expectedStatus, errorCode] of [
    [429, "retryable_failure", "PROVIDER_THROTTLED"],
    [503, "retryable_failure", "PROVIDER_UNAVAILABLE"],
    [403, "permanent_failure", "AUTHORIZATION_REJECTED"],
    [413, "permanent_failure", "PAYLOAD_REJECTED"],
  ] as const) {
    const fixture = dependencies({
      http: {
        async post() {
          return {
            status,
            headers: status === 429 ? { "retry-after": "30" } : {},
            bodyBytes: Buffer.from("provider details that are never returned"),
          };
        },
      },
    });
    const [result] = await deliverSecurityNotification({
      deliveryId,
      payloads: await payloads(),
      destinations: { slackSecretReference: "secret://notifications/slack/customer" },
      dependencies: fixture.dependencies,
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.errorCode, errorCode);
    assert.equal("message" in result, false);
    assert.equal(result.retryAfterSeconds, status === 429 ? 30 : null);
  }

  const fixture = dependencies({
    http: {
      async post() {
        throw new DOMException("the URL and secret must not escape", "TimeoutError");
      },
    },
  });
  const [timeout] = await deliverSecurityNotification({
    deliveryId,
    payloads: await payloads(),
    destinations: { slackSecretReference: "secret://notifications/slack/customer" },
    dependencies: fixture.dependencies,
  });
  assert.equal(timeout.errorCode, "REQUEST_TIMEOUT");
  assert.equal(timeout.status, "retryable_failure");
});

test("delivers a generic ticketing webhook to any pinned public host and sends the ticket envelope", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const built = await payloads();
  const results = await deliverSecurityNotification({
    deliveryId,
    payloads: built,
    destinations: { genericWebhookSecretReference: "secret://notifications/org_sutra/cust_customer/generic_webhook/jira" },
    dependencies: {
      // A generic webhook has no fixed provider host, so an arbitrary — but
      // pinned and public — hostname must be accepted. Safety comes from the
      // expectedHostname pin plus public-address enforcement, not an allowlist.
      secrets: {
        async resolveWebhook({ channel }) {
          assert.equal(channel, "generic_webhook");
          return {
            webhookUrl: "https://sutra.example-ticketing.com/inbound/9f8e7d6c",
            expectedHostname: "sutra.example-ticketing.com",
            idempotencyHeader: "Idempotency-Key",
          };
        },
      },
      dns: { async resolve() { return ["8.8.8.8"]; } },
      http: {
        async post(input) {
          calls.push({ ...input });
          return successfulResponse(202);
        },
      },
      ses: { async post() { return successfulResponse(200); } },
    },
  });
  assert.deepEqual(results.map((result) => [result.channel, result.status]), [
    ["generic_webhook", "delivered"],
  ]);
  const call = calls[0];
  assert.equal(String(call?.url), "https://sutra.example-ticketing.com/inbound/9f8e7d6c");
  assert.equal((call?.headers as Record<string, string>)["Idempotency-Key"], deliveryId);
  const body = JSON.parse(new TextDecoder().decode(call?.body as Uint8Array));
  assert.equal(body.schema, "sutra.ticket.v1");
  assert.equal(body.source, "sutra");
  assert.equal(body.severity, "critical");
  assert.equal(body.title, "Runtime threat detected");
  assert.equal(body.reportUrl, "https://app.sutracmdb.com/security/runtime/example");
});

test("still rejects a generic webhook whose resolved host does not match the pin or is not public", async () => {
  const built = await payloads();
  // Hostname does not match the recorded expectedHostname pin.
  const mismatched = {
    secrets: {
      async resolveWebhook() {
        return { webhookUrl: "https://attacker.example/inbound", expectedHostname: "tickets.example.com" };
      },
    },
    dns: { async resolve() { return ["8.8.8.8"]; } },
    http: { async post() { return successfulResponse(200); } },
    ses: { async post() { return successfulResponse(200); } },
  };
  await assert.rejects(
    deliverSecurityNotification({
      deliveryId,
      payloads: built,
      destinations: { genericWebhookSecretReference: "secret://notifications/org_sutra/cust_customer/generic_webhook/jira" },
      dependencies: mismatched,
    }),
    (error: unknown) => error instanceof SecurityNotificationDeliveryError && error.code === "UNSAFE_DESTINATION",
  );

  // Correct pin, but DNS resolves to a private/metadata address.
  const privateAddress = {
    secrets: {
      async resolveWebhook() {
        return { webhookUrl: "https://tickets.example.com/inbound", expectedHostname: "tickets.example.com" };
      },
    },
    dns: { async resolve() { return ["169.254.169.254"]; } },
    http: { async post() { return successfulResponse(200); } },
    ses: { async post() { return successfulResponse(200); } },
  };
  await assert.rejects(
    deliverSecurityNotification({
      deliveryId,
      payloads: built,
      destinations: { genericWebhookSecretReference: "secret://notifications/org_sutra/cust_customer/generic_webhook/jira" },
      dependencies: privateAddress,
    }),
    (error: unknown) => error instanceof SecurityNotificationDeliveryError && error.code === "UNSAFE_DESTINATION",
  );
});

test("sends the Slack incoming-webhook message body ({text, blocks}) on 2xx only", async () => {
  const fixture = dependencies();
  const built = await payloads();
  const results = await deliverSecurityNotification({
    deliveryId,
    payloads: built,
    destinations: { slackSecretReference: "secret://notifications/slack/customer" },
    dependencies: fixture.dependencies,
  });
  assert.deepEqual(results.map((result) => [result.channel, result.status]), [
    ["slack", "delivered"],
  ]);
  const call = fixture.calls.find((entry) => entry.kind === "webhook");
  assert.equal(String(call?.url), "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop");
  const body = JSON.parse(new TextDecoder().decode(call?.body as Uint8Array));
  assert.equal(body.text, built.slack.text);
  assert.ok(Array.isArray(body.blocks) && body.blocks.length === 4);
  assert.equal(body.blocks[0].type, "header");
});

test("rejects a Slack destination whose resolved URL is non-https or loopback-pinned", async () => {
  const unsafe = [
    { webhookUrl: "http://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop", expectedHostname: "hooks.slack.com" },
    { webhookUrl: "https://127.0.0.1/services/T12345678/B12345678/abcdefghijklmnop", expectedHostname: "127.0.0.1" },
  ];
  for (const resolved of unsafe) {
    const fixture = dependencies({ secrets: { async resolveWebhook() { return resolved; } } });
    await assert.rejects(
      deliverSecurityNotification({
        deliveryId,
        payloads: await payloads(),
        destinations: { slackSecretReference: "secret://notifications/slack/customer" },
        dependencies: fixture.dependencies,
      }),
      (error: unknown) =>
        error instanceof SecurityNotificationDeliveryError &&
        error.code === "UNSAFE_DESTINATION",
    );
    assert.equal(fixture.calls.length, 0);
  }
});

test("delivers a PagerDuty Events v2 trigger with the injected routing key and mapped severity", async () => {
  const fixture = pagerdutyDependencies();
  const built = await payloads("medium");
  // The routing key is a credential and must never be persisted in the payload.
  assert.equal("routing_key" in (built.pagerduty as Record<string, unknown>), false);

  const results = await deliverSecurityNotification({
    deliveryId,
    payloads: built,
    destinations: { pagerdutySecretReference: "secret://notifications/org_sutra/cust_customer/pagerduty/oncall" },
    dependencies: fixture.dependencies,
  });
  assert.deepEqual(results.map((result) => [result.channel, result.status]), [
    ["pagerduty", "delivered"],
  ]);
  const call = fixture.calls[0];
  assert.equal(String(call?.url), "https://events.pagerduty.com/v2/enqueue");
  assert.equal(call?.timeoutMs, 5_000);
  assert.equal(call?.redirect, "error");
  const body = JSON.parse(new TextDecoder().decode(call?.body as Uint8Array));
  assert.equal(body.routing_key, ROUTING_KEY);
  assert.equal(body.event_action, "trigger");
  assert.equal(body.dedup_key, deliveryId);
  assert.equal(body.payload.source, "sutra");
  assert.equal(body.payload.severity, "warning"); // medium -> warning
  assert.match(body.payload.summary, /^\[Sutra MEDIUM\]/u);
});

test("maps every Sutra severity onto the PagerDuty severity scale", async () => {
  for (const [sutra, pagerduty] of [
    ["critical", "critical"],
    ["high", "error"],
    ["medium", "warning"],
    ["low", "info"],
  ] as const) {
    const fixture = pagerdutyDependencies();
    await deliverSecurityNotification({
      deliveryId,
      payloads: await payloads(sutra),
      destinations: { pagerdutySecretReference: "secret://notifications/org_sutra/cust_customer/pagerduty/oncall" },
      dependencies: fixture.dependencies,
    });
    const body = JSON.parse(new TextDecoder().decode(fixture.calls[0]?.body as Uint8Array));
    assert.equal(body.payload.severity, pagerduty, sutra);
  }
});

test("never fakes PagerDuty delivery: non-2xx, missing key, and unconfigured resolver", async () => {
  // Non-2xx from the provider is not a delivery.
  const throttled = pagerdutyDependencies({ responseStatus: 429 });
  const [throttledResult] = await deliverSecurityNotification({
    deliveryId,
    payloads: await payloads(),
    destinations: { pagerdutySecretReference: "secret://notifications/org_sutra/cust_customer/pagerduty/oncall" },
    dependencies: throttled.dependencies,
  });
  assert.equal(throttledResult.status, "retryable_failure");
  assert.equal(throttledResult.errorCode, "PROVIDER_THROTTLED");

  // Secret resolves to nothing -> permanent failure, no transport call.
  const missing = pagerdutyDependencies({ routingKey: null });
  const [missingResult] = await deliverSecurityNotification({
    deliveryId,
    payloads: await payloads(),
    destinations: { pagerdutySecretReference: "secret://notifications/org_sutra/cust_customer/pagerduty/oncall" },
    dependencies: missing.dependencies,
  });
  assert.equal(missingResult.status, "permanent_failure");
  assert.equal(missingResult.errorCode, "DESTINATION_REJECTED");
  assert.equal(missing.calls.length, 0);

  // No routing-key resolver wired at all -> honest "adapter not configured".
  const unconfigured = pagerdutyDependencies({ withResolver: false });
  const [unconfiguredResult] = await deliverSecurityNotification({
    deliveryId,
    payloads: await payloads(),
    destinations: { pagerdutySecretReference: "secret://notifications/org_sutra/cust_customer/pagerduty/oncall" },
    dependencies: unconfigured.dependencies,
  });
  assert.equal(unconfiguredResult.status, "permanent_failure");
  assert.equal(unconfiguredResult.errorCode, "DESTINATION_REJECTED");
  assert.equal(unconfigured.calls.length, 0);
});

test("SSRF-screens the PagerDuty endpoint against a poisoned DNS answer", async () => {
  const fixture = pagerdutyDependencies({ dnsAddresses: ["169.254.169.254"] });
  await assert.rejects(
    deliverSecurityNotification({
      deliveryId,
      payloads: await payloads(),
      destinations: { pagerdutySecretReference: "secret://notifications/org_sutra/cust_customer/pagerduty/oncall" },
      dependencies: fixture.dependencies,
    }),
    (error: unknown) =>
      error instanceof SecurityNotificationDeliveryError &&
      error.code === "UNSAFE_DESTINATION",
  );
  assert.equal(fixture.calls.length, 0);
});

test("rejects oversized payloads before a transport call", async () => {
  const fixture = dependencies();
  const valid = await payloads();
  const oversized = {
    ...valid,
    slack: { ...valid.slack, text: "x".repeat(50 * 1024) },
  };
  await assert.rejects(
    deliverSecurityNotification({
      deliveryId,
      payloads: oversized,
      destinations: { slackSecretReference: "secret://notifications/slack/customer" },
      dependencies: fixture.dependencies,
    }),
    SecurityNotificationDeliveryError,
  );
  assert.equal(fixture.calls.length, 0);
});
