/* eslint-disable @typescript-eslint/no-explicit-any -- persistence race doubles model opaque sealed repository values */
import assert from "node:assert/strict";
import test from "node:test";

import { persistComputeOptimizerReadyPlansReadBeforeSealCore } from
  "../lib/finops-compute-optimizer-plan-persistence.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const RUN = `cor_${"b".repeat(64)}`;
const PLAN = `cope_${"c".repeat(64)}`;
const nowMs = Date.parse("2026-08-02T12:00:00.000Z");
const plan = Object.freeze({
  schemaVersion: "sutra.compute-optimizer-export-plan.v1",
  planId: PLAN,
  contentSha256: "c".repeat(64),
  scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION },
  requesterAccountId: "123456789012",
  partition: "aws",
  regions: ["us-east-1"],
  exportFamilies: ["EC2_INSTANCE"],
  targets: [{ marker: "immutable-target" }],
});
const input: any = Object.freeze({
  activation: {
    scope: plan.scope,
  },
  checkpoint: { planSet: { planSetId: `copes_${"d".repeat(64)}`, plans: [plan] } },
  regionalPlans: [plan],
  regionalPlanDiscoveryReferences: [{
    region: "us-east-1", planId: PLAN, discoveryRunId: RUN,
  }],
  regionContracts: [{ marker: "opaque" }],
});
const boundary = () => ({ signal: new AbortController().signal, deadlineAtMs: nowMs + 10_000 });

function stored(sealedEnvelope: unknown, discoveryRunId = RUN): any {
  return { planId: PLAN, contentSha256: plan.contentSha256, discoveryRunId, sealedEnvelope };
}

test("insert race rereads and authenticates winner without a second randomized seal", async () => {
  const winnerEnvelope = { ciphertext: "winner", keyVersion: "v1" };
  const calls: string[] = [];
  let reads = 0;
  let seals = 0;
  await persistComputeOptimizerReadyPlansReadBeforeSealCore(input, boundary(), {
    planRepository: {
      getPlan: async () => {
        calls.push("read");
        reads += 1;
        return reads === 1 ? null : stored(winnerEnvelope);
      },
      recordPlan: async () => { calls.push("insert-race"); throw new Error("immutable conflict"); },
    } as any,
    planSetRepository: {
      recordPlanSet: async () => { calls.push("plan-set"); return {} as any; },
    },
    activationRepository: {
      stageReadyAndOutbox: async () => { calls.push("stage-outbox"); return {} as any; },
    },
    envelope: {
      seal: async () => { calls.push("seal"); seals += 1; return { ciphertext: "loser", keyVersion: "v1" } as any; },
      open: async (value) => { calls.push(`open-${(value as any).ciphertext}`); return plan as any; },
    },
    nowMs: () => nowMs,
  });
  assert.equal(seals, 1);
  assert.deepEqual(calls, ["read", "seal", "insert-race", "read", "open-winner", "plan-set", "stage-outbox"]);
});

test("existing immutable plan is read and authenticated before sealing or staging", async () => {
  const calls: string[] = [];
  await persistComputeOptimizerReadyPlansReadBeforeSealCore(input, boundary(), {
    planRepository: {
      getPlan: async () => { calls.push("read"); return stored({ ciphertext: "existing" }); },
      recordPlan: async () => { throw new Error("must not insert"); },
    } as any,
    planSetRepository: { recordPlanSet: async () => { calls.push("plan-set"); return {} as any; } },
    activationRepository: { stageReadyAndOutbox: async () => { calls.push("stage-outbox"); return {} as any; } },
    envelope: {
      seal: async () => { throw new Error("must not seal"); },
      open: async () => { calls.push("open"); return plan as any; },
    },
    nowMs: () => nowMs,
  });
  assert.deepEqual(calls, ["read", "open", "plan-set", "stage-outbox"]);
});

test("winner substitution fails closed before plan-set/outbox side effects", async () => {
  let staged = 0;
  await assert.rejects(persistComputeOptimizerReadyPlansReadBeforeSealCore(input, boundary(), {
    planRepository: {
      getPlan: async () => stored({ ciphertext: "substituted" }),
      recordPlan: async () => undefined as any,
    } as any,
    planSetRepository: { recordPlanSet: async () => { staged += 1; return {} as any; } },
    activationRepository: { stageReadyAndOutbox: async () => { staged += 1; return {} as any; } },
    envelope: {
      seal: async () => ({}) as any,
      open: async () => ({ ...plan, requesterAccountId: "999999999999" }) as any,
    },
    nowMs: () => nowMs,
  }), /replay-conflict/u);
  assert.equal(staged, 0);
});

test("closed boundary starts no read or persistence operation", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(persistComputeOptimizerReadyPlansReadBeforeSealCore(input, {
    signal: controller.signal,
    deadlineAtMs: nowMs + 10_000,
  }, {
    planRepository: { getPlan: async () => { calls += 1; return null; }, recordPlan: async () => { calls += 1; return {} as any; } } as any,
    planSetRepository: { recordPlanSet: async () => { calls += 1; return {} as any; } },
    activationRepository: { stageReadyAndOutbox: async () => { calls += 1; return {} as any; } },
    envelope: { seal: async () => { calls += 1; return {} as any; }, open: async () => { calls += 1; return plan as any; } },
    nowMs: () => nowMs,
  }), /boundary-aborted/u);
  assert.equal(calls, 0);
});
