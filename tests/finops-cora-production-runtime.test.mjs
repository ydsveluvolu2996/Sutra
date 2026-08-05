import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./cloudflare-loader.mjs", import.meta.url));

const production = await import("../lib/finops-cora-production-composition.ts");
const broker = await import("../lib/finops-cora-signed-broker.ts");

test("ADD-01 production contract pins .8.14, exact official inventory, and honest shared-hook state", () => {
  assert.deepEqual(production.CORA_PRODUCTION_COMPOSITION_STATUS, {
    schemaVersion: "sutra.cora-production-composition.v1", pinnedOfficialContract: "v0.0.11",
    exactSheets: 5, exactVisuals: 28, exactControlPlacements: 52,
    credentialOwningProviderAdapterImplemented: true, signedBrokerImplemented: true,
    defaultSdkParquetFactoryImplemented: false,
    immutableExportReplayImplemented: true, durableProviderLeaseImplemented: true,
    immutableDashboardHistoryImplemented: true,
    deterministicDailySchedulerImplemented: true, identityOnlyQueuePayload: true,
    commitmentOptionMatricesImplemented: true, requiredPermissionPack: "standard-2026-08.14",
    sharedWorkerRegistered: false, sqliteMigrationRegistered: false, postgresMigrationRegistered: false,
    activationState: "AWAITING_SHARED_MIGRATION_AND_REGISTRY_HOOKS",
  });
});

test("ADD-01 scheduler uses one deterministic UTC identity-only job per connection", async () => {
  const calls = []; const scopes = [
    { organizationId: "org_cora", customerId: "customer_cora", connectionId: `conn_${"b".repeat(32)}` },
    { organizationId: "org_cora", customerId: "customer_cora", connectionId: `conn_${"a".repeat(32)}` },
  ];
  const result = await production.scheduleCoraCollections({ scheduledAtMs: Date.parse("2026-08-02T23:59:59.999Z"), listEligibleScopes: async () => scopes, queue: { enqueue: async (value) => { calls.push(value); return value; } } });
  assert.deepEqual(result, { scheduledWindow: "2026-08-02T00:00:00.000Z", enqueued: 2 });
  assert.deepEqual(calls.map((item) => item.connectionId), [`conn_${"a".repeat(32)}`, `conn_${"b".repeat(32)}`]);
  assert.ok(calls.every((item) => JSON.stringify(item.payload) === '{"scheduledWindow":"2026-08-02T00:00:00.000Z"}' && item.maxAttempts === 5 && item.idempotencyKey === `cora:${item.connectionId}:2026-08-02T00:00:00.000Z`));
  await assert.rejects(production.scheduleCoraCollections({ scheduledAtMs: Date.parse("2026-08-02T00:00:00.000Z"), listEligibleScopes: async () => [scopes[0], scopes[0]], queue: { enqueue: async () => ({}) } }), /DUPLICATE_ELIGIBLE_SCOPE/u);
});

test("ADD-01 signed broker refuses downgrade origins before any credentialed request", () => {
  const signing = { clientKeyId: "client", clientPrivateKey: "invalid", brokerKeyId: "broker", brokerPublicKey: "invalid" };
  for (const brokerOrigin of ["http://collector.example.com", "https://user:pass@collector.example.com", "https://collector.example.com/path", "not-a-url"]) {
    assert.throws(() => broker.createCoraSignedBroker({ configuration: { brokerOrigin, signing }, boundaryForRequest: async () => { throw new Error("must-not-run"); } }), (error) => error.code === "BROKER_UNAVAILABLE" && !String(error.message).includes(brokerOrigin));
  }
});
