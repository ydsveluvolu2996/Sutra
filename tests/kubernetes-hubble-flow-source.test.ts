import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HubbleExportFileFlowSource,
  normalizeHubbleExportLines,
} from "../services/kubernetes-collector/src/hubble-flow-source.ts";
import { normalizeHubbleFlowBatch } from "../lib/hubble-flow-evidence.ts";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function exportLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    flow: {
      time: "2026-07-17T11:59:00.000000000Z",
      verdict: "FORWARDED",
      traffic_direction: "EGRESS",
      l4: { TCP: { source_port: 34_512, destination_port: 8080 } },
      source: {
        namespace: "payments",
        pod_name: "frontend-abc",
        labels: ["k8s:app=frontend"],
        workloads: [{ name: "frontend", kind: "Deployment" }],
      },
      destination: {
        namespace: "payments",
        pod_name: "backend-xyz",
        labels: ["k8s:app=backend"],
        workloads: [{ name: "backend", kind: "Deployment" }],
      },
      destination_service: { name: "backend", namespace: "payments" },
      ...overrides,
    },
    node_name: "ip-10-0-1-10",
    time: "2026-07-17T11:59:00.000000000Z",
  });
}

test("hubble export lines normalize into bounded aggregated flow metadata", () => {
  const { flows, flowsSkipped } = normalizeHubbleExportLines({
    lines: [
      exportLine(),
      exportLine(),
      exportLine({ verdict: "DROPPED", traffic_direction: "INGRESS" }),
      exportLine({
        destination: { labels: ["reserved:world"] },
        destination_service: undefined,
        l4: { UDP: { destination_port: 53 } },
      }),
      exportLine({ l4: { ICMPv4: {} } }),
      "not-json",
      JSON.stringify({ flow: { time: "2026-07-17T11:59:00Z", source: {}, destination: {} } }),
      "",
    ],
    now: NOW,
  });
  assert.equal(flowsSkipped, 2);
  assert.equal(flows.length, 4);

  const forwarded = flows.find((flow) => flow.verdict === "forwarded" && flow.protocol === "TCP");
  assert.ok(forwarded !== undefined);
  assert.equal(forwarded.observations, 2, "identical tuples must aggregate");
  assert.equal(forwarded.destinationPort, 8080);
  assert.equal(forwarded.direction, "egress");
  assert.deepEqual(forwarded.source, {
    namespace: "payments",
    workloadKind: "Deployment",
    workloadName: "frontend",
    serviceName: null,
    world: false,
  });
  assert.equal(forwarded.destination.serviceName, "backend");

  const world = flows.find((flow) => flow.destination.world);
  assert.ok(world !== undefined);
  assert.equal(world.protocol, "UDP");
  assert.equal(world.destinationPort, 53);
  assert.deepEqual(world.destination, {
    namespace: null,
    workloadKind: null,
    workloadName: null,
    serviceName: null,
    world: true,
  });

  const icmp = flows.find((flow) => flow.protocol === "ICMP");
  assert.ok(icmp !== undefined);
  assert.equal(icmp.destinationPort, null);

  const dropped = flows.find((flow) => flow.verdict === "dropped");
  assert.ok(dropped !== undefined);
  assert.equal(dropped.direction, "ingress");
});

test("normalized export flows pass the control-plane batch normalizer end to end", async () => {
  const { flows } = normalizeHubbleExportLines({
    lines: [exportLine(), exportLine({ verdict: "DROPPED" })],
    now: NOW,
  });
  const batch = await normalizeHubbleFlowBatch({
    clusterId: "cluster_demo",
    value: {
      collectedAt: new Date(NOW).toISOString(),
      hubbleVersion: "1.19.5",
      flows,
    },
  });
  assert.equal(batch.schemaVersion, "sutra.hubble-flow-batch.v1");
  assert.equal(batch.flows.length, 2);
  assert.ok(batch.flows.every((flow) => flow.evidenceSha256.length === 64));
});

test("endpoints without workload, service, or world identity are skipped, never invented", () => {
  const { flows, flowsSkipped } = normalizeHubbleExportLines({
    lines: [
      exportLine({ source: { labels: ["reserved:host"] } }),
      exportLine({ destination: { namespace: "kube-system", labels: [] }, destination_service: undefined }),
      exportLine({ time: "2027-01-01T00:00:00Z" }),
    ],
    now: NOW,
  });
  assert.equal(flows.length, 0);
  assert.equal(flowsSkipped, 3);
});

test("pod-only endpoints fall back to the Pod workload kind", () => {
  const { flows } = normalizeHubbleExportLines({
    lines: [exportLine({ source: { namespace: "payments", pod_name: "job-runner-1", labels: [] } })],
    now: NOW,
  });
  assert.equal(flows.length, 1);
  assert.deepEqual(flows[0]?.source, {
    namespace: "payments",
    workloadKind: "Pod",
    workloadName: "job-runner-1",
    serviceName: null,
    world: false,
  });
});

test("export file source reads a bounded tail, reports missing files as not configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-hubble-"));
  try {
    const path = join(directory, "events.log");
    const missing = new HubbleExportFileFlowSource({ path, hubbleVersion: "1.19.5" });
    assert.equal(await missing.collect({ now: NOW }), null, "missing file means not configured");

    await writeFile(path, [exportLine(), exportLine(), ""].join("\n"), "utf8");
    const source = new HubbleExportFileFlowSource({ path, hubbleVersion: "1.19.5" });
    const collection = await source.collect({ now: NOW });
    assert.ok(collection !== null);
    assert.equal(collection.hubbleVersion, "1.19.5");
    assert.equal(collection.flows.length, 1);
    assert.equal(collection.flows[0]?.observations, 2);
    assert.equal(collection.flowsSkipped, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("flow source rejects invalid configuration", () => {
  assert.throws(() => new HubbleExportFileFlowSource({ path: "", hubbleVersion: "1.19.5" }));
  assert.throws(() => new HubbleExportFileFlowSource({ path: "/var/run/hubble/events.log", hubbleVersion: "not valid!" }));
});
