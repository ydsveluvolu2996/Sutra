import assert from "node:assert/strict";
import test from "node:test";

import {
  ManagedOutboundNotificationHttpTransport,
} from "../services/notification-worker/runtime-adapters.ts";
import {
  classifyManagedProviderWebhookUrl,
} from "../lib/managed-provider-webhooks.ts";

const PROVIDERS = [
  [
    "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop",
    "slack-webhook",
  ],
  [
    "https://prod-00.westus.logic.azure.com/workflows/01234567-89ab-cdef-0123-456789abcdef/triggers/manual/paths/invoke?api-version=2016-10-01&sig=secret",
    "teams-logic-workflow",
  ],
  [
    "https://tenant.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/01234567-89ab-cdef-0123-456789abcdef/triggers/manual/paths/invoke?api-version=1&sig=secret",
    "teams-powerplatform-workflow",
  ],
  [
    "https://events.pagerduty.com/v2/enqueue",
    "pagerduty-events",
  ],
  [
    "https://automation.atlassian.com/pro/hooks/0123456789abcdef0123456789abcdef",
    "jira-cloud-webhook",
  ],
  [
    "https://customer.service-now.com/api/x_sutra/security/incidents",
    "servicenow-webhook",
  ],
] as const;

test("every supported notification provider is signed for the one managed gateway", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const privateKey = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  ).toString("base64url");
  const requests: Request[] = [];
  let nonce = 0;
  const transport = new ManagedOutboundNotificationHttpTransport({
    SUTRA_MANAGED_OUTBOUND_URL: "https://outbound.sutracmdb.com",
    SUTRA_MANAGED_OUTBOUND_KEY_ID: "production-notification-worker",
    SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY: privateKey,
  }, {
    now: () => 1_785_369_600_000,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++nonce).padStart(12, "0")}`,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response("ok", { status: 202 });
    },
  });

  for (const [url, target] of PROVIDERS) {
    assert.equal(classifyManagedProviderWebhookUrl(url), target);
    const response = await transport.post({
      url: new URL(url),
      headers: { "content-type": "application/json; charset=utf-8" },
      body: new TextEncoder().encode('{"schema":"test"}'),
      validatedAddresses: ["8.8.8.8"],
      redirect: "error",
      timeoutMs: 5_000,
      maximumResponseBytes: 16_384,
      gatewayIdempotencyKey: `notify_${String(nonce + 1).padStart(48, "a")}`,
    });
    assert.equal(response.status, 202);
  }

  assert.equal(requests.length, PROVIDERS.length);
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    assert.equal(request?.url, "https://outbound.sutracmdb.com/v1/fetch");
    assert.equal(request?.headers.has("x-sutra-signature"), true);
    const envelope = await request?.json() as {
      readonly target: string;
      readonly targetOrigin: string;
      readonly idempotencyKey: string;
    };
    assert.equal(envelope.target, PROVIDERS[index]?.[1]);
    assert.equal(
      envelope.targetOrigin,
      new URL(PROVIDERS[index]?.[0] ?? "https://invalid").origin,
    );
    assert.match(envelope.idempotencyKey, /^notify_[a-f0-9]{48}$/u);
  }
});

test("lookalikes, arbitrary hosts, alternate methods, ports, and paths fail closed", () => {
  for (const url of [
    "https://hooks.slack.com.attacker.example/services/T12345678/B12345678/abcdefghijklmnop",
    "https://automation.atlassian.com.attacker.example/pro/hooks/0123456789abcdef",
    "https://customer.service-now.com.evil.example/api/x/y",
    "https://customer.example/webhook",
    "https://events.pagerduty.com:444/v2/enqueue",
    "https://customer.service-now.com/not-api/hook",
    "https://automation.atlassian.com/pro/hooks/short",
  ]) {
    assert.equal(classifyManagedProviderWebhookUrl(url), null, url);
  }
  assert.equal(
    classifyManagedProviderWebhookUrl(
      "https://events.pagerduty.com/v2/enqueue",
      "GET",
    ),
    null,
  );
});
