import assert from "node:assert/strict";
import test from "node:test";
import { buildContainmentPlan } from "../lib/kubernetes-containment.ts";
import type { FalcoPriority, NormalizedFalcoRuntimeEvent } from "../lib/falco-runtime-types.ts";

function event(over: Partial<NormalizedFalcoRuntimeEvent> = {}): NormalizedFalcoRuntimeEvent {
  return {
    schemaVersion: "sutra.falco.runtime-event.v1",
    eventId: "frte_" + "a".repeat(48),
    clusterId: "cluster_prod",
    occurredAt: "2026-07-18T00:00:00.000Z",
    rule: "Terminal shell in container",
    priority: "critical",
    source: "syscall",
    nodeName: "ip-10-0-1-5",
    namespace: "payments",
    podName: "api-abc123",
    podUid: null,
    containerId: null,
    containerName: "api",
    containerImage: "registry/api@sha256:" + "d".repeat(64),
    process: { name: null, executable: null, pid: null, parentPid: null, userName: null, userId: null, eventType: null },
    evidenceSha256: "b".repeat(64),
    ...over,
  };
}

test("critical events plan isolate + cordon + terminate, all approval-gated", () => {
  const plan = buildContainmentPlan({ event: event({ priority: "critical" }) });
  assert.equal(plan.severity, "critical");
  assert.equal(plan.automaticApply, false);
  assert.equal(plan.requiresHumanApproval, true);
  const kinds = plan.actions.map((action) => action.kind);
  assert.deepEqual(kinds, ["isolate-pod", "cordon-node", "terminate-pod"]);
  assert.ok(plan.actions.every((action) => action.requiresApproval === true));
});

test("high events plan isolate + cordon but not terminate", () => {
  const plan = buildContainmentPlan({ event: event({ priority: "error" }) });
  assert.equal(plan.severity, "high");
  assert.deepEqual(plan.actions.map((a) => a.kind), ["isolate-pod", "cordon-node"]);
});

test("medium events plan pod isolation only", () => {
  const plan = buildContainmentPlan({ event: event({ priority: "warning" }) });
  assert.equal(plan.severity, "medium");
  assert.deepEqual(plan.actions.map((a) => a.kind), ["isolate-pod"]);
});

test("low events plan no containment (case creation only)", () => {
  for (const priority of ["notice", "informational", "debug"] as FalcoPriority[]) {
    const plan = buildContainmentPlan({ event: event({ priority }) });
    assert.equal(plan.severity, "low");
    assert.deepEqual(plan.actions, []);
  }
});

test("omits actions whose target identity is absent (never synthesized)", () => {
  // No node → no cordon, even at critical.
  const noNode = buildContainmentPlan({ event: event({ priority: "critical", nodeName: null }) });
  assert.deepEqual(noNode.actions.map((a) => a.kind), ["isolate-pod", "terminate-pod"]);
  // No pod identity → no pod actions at all.
  const noPod = buildContainmentPlan({ event: event({ priority: "critical", namespace: null, podName: null }) });
  assert.deepEqual(noPod.actions.map((a) => a.kind), ["cordon-node"]);
});

test("never emits an auto-apply path and scopes the isolation policy to the pod", () => {
  const plan = buildContainmentPlan({ event: event({ priority: "critical" }) });
  const serialized = JSON.stringify(plan);
  assert.equal(/"automaticApply":true/u.test(serialized), false);
  const isolate = plan.actions.find((a) => a.kind === "isolate-pod");
  assert.match(isolate?.content ?? "", /sutra\.io\/quarantine/u);
  assert.match(isolate?.appliesTo ?? "", /^payments\/api-abc123$/u);
});
