import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const {
  KUBECOST_ACCEPTED_PERMISSION_PACKS,
  KUBECOST_PRODUCTION_COMPOSITION_STATUS,
  createKubecostProductionComposition,
  isKubecostPermissionPackAccepted,
  kubecostScheduledWindow,
} = await import("../lib/finops-kubecost-production-composition.ts");

test("ADD-06 production contract floors deterministic six-hour windows", () => {
  assert.equal(kubecostScheduledWindow(Date.parse("2026-08-02T13:59:59.999Z")), "2026-08-02T12:00:00.000Z");
  assert.equal(kubecostScheduledWindow(Date.parse("2026-08-02T17:59:59.999Z")), "2026-08-02T12:00:00.000Z");
  assert.equal(kubecostScheduledWindow(Date.parse("2026-08-02T18:00:00.000Z")), "2026-08-02T18:00:00.000Z");
  assert.throws(() => kubecostScheduledWindow(-1), /KUBECOST_SCHEDULE_INVALID/u);
});

test("permission compatibility is a closed successor allow-list, never lexical", () => {
  assert.deepEqual(KUBECOST_ACCEPTED_PERMISSION_PACKS, [
    "standard-2026-08.9", "standard-2026-08.10", "standard-2026-08.11",
    "standard-2026-08.12", "standard-2026-08.13", "standard-2026-08.14",
  ]);
  for (const value of KUBECOST_ACCEPTED_PERMISSION_PACKS) assert.equal(isKubecostPermissionPackAccepted(value), true);
  for (const value of ["standard-2026-08.8", "standard-2026-08.90", "standard-2027-01.1", "attacker"]) assert.equal(isKubecostPermissionPackAccepted(value), false);
});

test("production composition exposes every unique closed vertical dependency", () => {
  assert.equal(KUBECOST_PRODUCTION_COMPOSITION_STATUS.officialArtifactCount, 8);
  assert.equal(KUBECOST_PRODUCTION_COMPOSITION_STATUS.officialDatasetColumnCount, 62);
  assert.equal(KUBECOST_PRODUCTION_COMPOSITION_STATUS.requiredSdk, "@aws-sdk/client-s3@3.1087.0");
  for (const key of ["credentialOwningProviderAdapterImplemented", "signedBrokerImplemented",
    "versionPinnedObjectReadsImplemented", "immutableAttemptReplayImplemented",
    "immutableCompleteHeadImplemented", "deterministicSixHourSchedulerImplemented",
    "identityOnlyQueuePayload", "nodeCapacityAndInstanceDimensionsImplemented",
    "explicitRuntimeStatesImplemented"]) assert.equal(KUBECOST_PRODUCTION_COMPOSITION_STATUS[key], true, key);
  assert.throws(() => createKubecostProductionComposition({ database: {}, loadEligibleContexts: async () => [], loadRuntimeContext: async () => { throw new Error("unused"); } }), /KUBECOST_EXACTLY_ONE_BROKER_REQUIRED/u);
  const composition = createKubecostProductionComposition({ database: {}, broker: { collect: async () => { throw new Error("unused"); } }, loadEligibleContexts: async () => [], loadRuntimeContext: async () => { throw new Error("unused"); } });
  assert.equal(typeof composition.handler, "function"); assert.equal(typeof composition.scheduleTick, "function");
});
