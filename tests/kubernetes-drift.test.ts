import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkloadDrift, type DriftContainer, type DriftWorkload } from "../lib/kubernetes-drift.ts";

function container(over: Partial<DriftContainer> = {}): DriftContainer {
  return { name: "app", image: "registry/app@sha256:aaa", privileged: false, allowPrivilegeEscalation: false, runAsNonRoot: true, capabilitiesAdd: [], ...over };
}
function workload(over: Partial<DriftWorkload> = {}): DriftWorkload {
  return { namespace: "payments", name: "frontend", workloadKind: "Deployment", hostNetwork: false, hostPid: false, hostIpc: false, hasHostPath: false, runAsNonRoot: true, containers: [container()], ...over };
}

test("a container becoming privileged is critical drift", () => {
  const report = buildWorkloadDrift({
    previous: [workload()],
    current: [workload({ containers: [container({ privileged: true })] })],
  });
  const change = report.changes.find((c) => c.kind === "privileged-enabled");
  assert.ok(change !== undefined);
  assert.equal(change.severity, "critical");
  assert.equal(change.from, "no");
  assert.equal(change.to, "yes");
  assert.equal(report.summary.critical, 1);
});

test("an image reference change is flagged as image drift", () => {
  const report = buildWorkloadDrift({
    previous: [workload({ containers: [container({ image: "registry/app@sha256:aaa" })] })],
    current: [workload({ containers: [container({ image: "registry/app@sha256:bbb" })] })],
  });
  const change = report.changes.find((c) => c.kind === "image-changed");
  assert.ok(change !== undefined);
  assert.equal(change.container, "app");
  assert.match(change.from, /aaa/u);
  assert.match(change.to, /bbb/u);
});

test("lost run-as-non-root and host access are high drift; regressions need the safer prior value", () => {
  const report = buildWorkloadDrift({
    previous: [workload({ runAsNonRoot: true, hostNetwork: false })],
    current: [workload({ runAsNonRoot: false, hostNetwork: true })],
  });
  assert.ok(report.changes.some((c) => c.kind === "run-as-non-root-lost" && c.severity === "high"));
  assert.ok(report.changes.some((c) => c.kind === "host-network-enabled" && c.severity === "high"));

  // If the workload was ALREADY privileged/host-network, that is not drift.
  const noDrift = buildWorkloadDrift({
    previous: [workload({ hostNetwork: true })],
    current: [workload({ hostNetwork: true })],
  });
  assert.equal(noDrift.changes.length, 0);
});

test("added capabilities are reported with the new caps named", () => {
  const report = buildWorkloadDrift({
    previous: [workload({ containers: [container({ capabilitiesAdd: [] })] })],
    current: [workload({ containers: [container({ capabilitiesAdd: ["NET_ADMIN", "SYS_ADMIN"] })] })],
  });
  const change = report.changes.find((c) => c.kind === "capabilities-added");
  assert.ok(change !== undefined);
  assert.match(change.detail, /NET_ADMIN, SYS_ADMIN/u);
});

test("workloads added and removed between scans are informational", () => {
  const report = buildWorkloadDrift({
    previous: [workload({ name: "frontend" })],
    current: [workload({ name: "backend" })],
  });
  assert.ok(report.changes.some((c) => c.kind === "workload-added" && c.workload.includes("backend") && c.severity === "low"));
  assert.ok(report.changes.some((c) => c.kind === "workload-removed" && c.workload.includes("frontend") && c.severity === "low"));
});

test("no previous scan yields no drift, only the baseline", () => {
  const report = buildWorkloadDrift({ previous: null, current: [workload({ containers: [container({ privileged: true })] })] });
  assert.equal(report.hasPrevious, false);
  assert.equal(report.changes.length, 0);
  assert.match(report.disclaimer, /two most recent scans/u);
});

test("an unchanged workload produces no drift and output is deterministic", () => {
  const build = () => buildWorkloadDrift({ previous: [workload()], current: [workload()] });
  const report = build();
  assert.equal(report.changes.length, 0);
  assert.equal(report.summary.workloadsDrifted, 0);
  assert.deepEqual(build(), report);
});
