import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const production = await import("../lib/finops-amazon-connect-cost-production-composition.ts");

const dependencies = { database: {}, loadBoundary: async () => null, listEligibleScopes: async () => [],
  evidence: { archive: async () => { throw new Error("not used"); } },
  sealer: { seal: async () => { throw new Error("not used"); } },
  materializer: { collect: async () => { throw new Error("not used"); } } };

test("ADD-11 production composition pins official totals and honest unavailable contracts", () => {
  assert.deepEqual({ sheets: production.AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS.pinnedOfficialSheets,
    visuals: production.AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS.pinnedOfficialVisuals,
    controls: production.AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS.pinnedOfficialControls },
  { sheets: 8, visuals: 121, controls: 61 });
  assert.equal(production.AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS.resourceConnectViewDatasetPublished, false);
  assert.equal(production.AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS.supportingServiceEvidenceState,
    "UNAVAILABLE_SEPARATE_AUTHORITATIVE_EVIDENCE_REQUIRED");
  assert.equal(production.AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS.exactContactLookupState,
    "UNAVAILABLE_APPROVAL_AUDIT_GRANT_ROUTE_REQUIRED");
  assert.equal(production.AMAZON_CONNECT_COST_PRODUCTION_COMPOSITION_STATUS.requiredPermissionPack,
    "standard-2026-08.16");
});

test("ADD-11 daily schedule is deterministic and production requires exactly one transport", () => {
  assert.equal(production.amazonConnectCostScheduledWindow(Date.parse("2026-08-02T23:59:59.999Z")),
    "2026-08-02T00:00:00.000Z");
  assert.throws(() => production.amazonConnectCostScheduledWindow(-1), /SCHEDULE_INVALID/u);
  assert.throws(() => production.createAmazonConnectCostProductionComposition(
    { ...dependencies, materializer: undefined }), /EXACTLY_ONE/u);
  assert.throws(() => production.createAmazonConnectCostProductionComposition(
    { ...dependencies, brokerConfiguration: { brokerOrigin: "https://collector.example.com",
      signing: { clientKeyId: "client", clientPrivateKey: "A".repeat(40),
        brokerKeyId: "broker", brokerPublicKey: "B".repeat(40) } } }), /EXACTLY_ONE/u);
  const composition = production.createAmazonConnectCostProductionComposition(dependencies);
  assert.equal(composition.schemaVersion, "sutra.amazon-connect-cost-production-composition.v1");
  assert.equal(typeof composition.handler, "function");
});
