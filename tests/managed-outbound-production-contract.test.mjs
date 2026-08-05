import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  template,
  entrypoint,
  bulkRefresh,
  runtimeRefresh,
  notificationRuntime,
  notificationDelivery,
  itsmDelivery,
  itsmRoute,
  finopsDelivery,
  network,
  wranglerExample,
] = await Promise.all([
  readFile(new URL("../infrastructure/production-ha.yaml", import.meta.url), "utf8"),
  readFile(new URL("../deploy/production/entrypoint.sh", import.meta.url), "utf8"),
  readFile(new URL("../scripts/vuln-feed-refresh.mjs", import.meta.url), "utf8"),
  readFile(new URL("../lib/vuln-feed-runtime.ts", import.meta.url), "utf8"),
  readFile(new URL("../services/notification-worker/runtime-adapters.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/security-notification-delivery.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/itsm-delivery.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/v1/itsm/dispatch/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/finops-report-delivery.ts", import.meta.url), "utf8"),
  readFile(new URL("../infrastructure/production-network.yaml", import.meta.url), "utf8"),
  readFile(
    new URL(
      "../services/managed-outbound-gateway/wrangler.example.toml",
      import.meta.url,
    ),
    "utf8",
  ),
]);

const zohoCallers = await Promise.all([
  "../lib/invitation-delivery.ts",
  "../lib/password-reset-delivery.ts",
  "../lib/contact-delivery.ts",
  "../lib/finops-report-delivery.ts",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

const MANAGED_KEYS = [
  "SUTRA_MANAGED_OUTBOUND_URL",
  "SUTRA_MANAGED_OUTBOUND_KEY_ID",
  "SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY",
];

test("app, notification worker, and strict feed receive distinct managed outbound identities", () => {
  for (const key of MANAGED_KEYS) {
    const matches = template.match(new RegExp(`Name: ${key}`, "gu")) ?? [];
    assert.equal(matches.length, 3, `${key} must be present in all three outbound workloads`);
    assert.match(entrypoint, new RegExp(`^${key}$`, "mu"));
    assert.match(entrypoint, new RegExp(`"${key}=\\$${key}"`, "u"));
  }
  const feedRole = template.slice(
    template.indexOf("VulnerabilityFeedExecutionRole:"),
    template.indexOf("MigrationExecutionRole:"),
  );
  assert.match(feedRole, /!Ref ApplicationRuntimeSecretArn/u);
  for (const workload of ["APP", "WORKER", "FEED"]) {
    assert.match(
      template,
      new RegExp(`SUTRA_MANAGED_OUTBOUND_${workload}_KEY_ID`, "u"),
    );
    assert.match(
      template,
      new RegExp(`SUTRA_MANAGED_OUTBOUND_${workload}_PRIVATE_KEY`, "u"),
    );
  }
});

test("all production notification and ticket writes select the signed provider-bounded gateway", () => {
  assert.match(notificationRuntime, /new ManagedOutboundNotificationHttpTransport/u);
  assert.match(notificationRuntime, /requiredManagedOutboundFetch/u);
  assert.match(notificationDelivery, /classifyManagedProviderWebhookUrl/u);
  assert.match(itsmDelivery, /requiredManagedOutboundFetch/u);
  assert.match(itsmDelivery, /isManagedTicketWebhookUrl/u);
  assert.match(itsmRoute, /deliverItsmTicket/u);
  assert.doesNotMatch(itsmRoute, /fetch\(target/u);
  assert.match(finopsDelivery, /requiredManagedOutboundFetch/u);
  assert.match(finopsDelivery, /isManagedTicketWebhookUrl/u);
  for (const [providerDomain, providerPattern] of [
    ["hooks.slack.com", /^(?:[\s\S]*hooks\.slack\.com[\s\S]*)$/u],
    ["events.pagerduty.com", /^(?:[\s\S]*events\.pagerduty\.com[\s\S]*)$/u],
    ["logic.azure.com", /^(?:[\s\S]*logic\.azure\.com[\s\S]*)$/u],
    ["powerplatform.com", /^(?:[\s\S]*powerplatform\.com[\s\S]*)$/u],
    ["atlassian.com", /^(?:[\s\S]*atlassian\.com[\s\S]*)$/u],
    ["service-now.com", /^(?:[\s\S]*service-now\.com[\s\S]*)$/u],
  ]) {
    assert.doesNotMatch(
      network,
      providerPattern,
      `${providerDomain} must not be added to the production firewall`,
    );
  }
  assert.match(
    network,
    /^(?:[\s\S]*outbound\.sutracmdb\.com[\s\S]*)$/u,
  );
});

test("both vulnerability refresh paths select the signed adapter", () => {
  assert.match(bulkRefresh, /productionOutboundFetch\(process\.env\)/u);
  assert.match(runtimeRefresh, /productionOutboundFetch\(/u);
});

test("production Zoho call paths preserve an absent fetch injection for the adapter", () => {
  for (const source of zohoCallers) {
    assert.doesNotMatch(
      source,
      /fetchImpl:\s*typeof fetch\s*=\s*fetch/u,
      "a defaulted global fetch would bypass managed outbound selection",
    );
  }
  assert.ok(zohoCallers[3]?.includes("}, input.fetchImpl);"));
});

test("gateway configuration example documents the enforced authorization-record shape", () => {
  assert.match(wranglerExample, /"publicKey":/u);
  assert.match(wranglerExample, /"allowedTargets":/u);
  assert.match(wranglerExample, /"production-app":\s*\{/u);
  assert.doesNotMatch(
    wranglerExample,
    /"production-app":"<base64url raw 32-byte Ed25519 public key>"/u,
  );
});
