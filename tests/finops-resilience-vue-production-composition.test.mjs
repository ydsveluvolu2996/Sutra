import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const { createResilienceVueProductionComposition, resilienceVueScheduledWindow,
  RESILIENCE_VUE_PRODUCTION_COMPOSITION_STATUS } = await import("../lib/finops-resilience-vue-production-composition.ts");

const environment = { SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY: Buffer.alloc(32, 7).toString("base64url"),
  SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION: "resilience-v1" };

test("ADV-10 production composition pins the deterministic daily window and explicit shared hook", () => {
  assert.equal(resilienceVueScheduledWindow(Date.parse("2026-08-02T22:12:00.000Z")), "2026-08-02T00:00:00.000Z");
  assert.throws(() => resilienceVueScheduledWindow(-1), /RESILIENCE_VUE_SCHEDULE_INVALID/u);
  assert.equal(RESILIENCE_VUE_PRODUCTION_COMPOSITION_STATUS.durableReplayRepositoryImplemented, true);
  assert.equal(RESILIENCE_VUE_PRODUCTION_COMPOSITION_STATUS.sharedWorkerRegistered, true);
  assert.equal(RESILIENCE_VUE_PRODUCTION_COMPOSITION_STATUS.activationState,
    "REGISTERED_LOCAL_RUNTIME");
});

test("ADV-10 production composition requires exactly one authenticated adapter path", async () => {
  await assert.rejects(createResilienceVueProductionComposition({ env: environment }),
    /RESILIENCE_VUE_EXACTLY_ONE_ADAPTER_REQUIRED/u);
  await assert.rejects(createResilienceVueProductionComposition({ env: environment,
    adapter: { collect: async () => { throw new Error("not-called"); } },
    brokerConfiguration: { brokerOrigin: "https://collector.example.com", signing: {
      clientKeyId: "test", clientPrivateKey: "not-a-key", brokerKeyId: "test",
      brokerPublicKey: "not-a-key",
    } } }), /RESILIENCE_VUE_EXACTLY_ONE_ADAPTER_REQUIRED/u);
});
