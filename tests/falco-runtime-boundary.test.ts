import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FalcoRuntimeBoundaryError,
  parseFalcoRuntimePayload,
} from "../lib/falco-runtime-boundary.ts";
import { falcoCaseCandidate, projectFalcoTimeline } from "../lib/falco-runtime-types.ts";

const clusterId = `kcluster_${"a".repeat(48)}`;

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

const falcosidekickEvent = {
  output: "Sensitive command output that must never be retained",
  priority: "Critical",
  rule: "Terminal shell in container",
  time: "2026-07-17T07:01:02.345678Z",
  source: "syscall",
  hostname: "ip-10-0-0-12",
  tags: ["container", "mitre_execution"],
  output_fields: {
    "k8s.ns.name": "payments",
    "k8s.pod.name": "api-75d9",
    "k8s.pod.uid": "pod-123",
    "container.id": "8ac77f",
    "container.name": "api",
    "container.image.repository": "example/api",
    "container.image.tag": "42",
    "proc.name": "sh",
    "proc.exepath": "/bin/sh",
    "proc.pid": 812,
    "proc.ppid": "701",
    "proc.cmdline": "sh -c super-secret",
    "proc.env": "TOKEN=secret",
    "evt.arg.data": "secret file content",
    "user.name": "app",
    "user.uid": "10001",
    "evt.type": "execve",
  },
};

test("normalizes a Falcosidekick webhook while discarding unsafe raw fields", () => {
  const [event] = parseFalcoRuntimePayload({
    clusterId,
    body: bytes(falcosidekickEvent),
  });
  assert.equal(event.rule, "Terminal shell in container");
  assert.equal(event.priority, "critical");
  assert.equal(event.containerImage, "example/api:42");
  assert.deepEqual(event.process, {
    name: "sh",
    executable: "/bin/sh",
    pid: 812,
    parentPid: 701,
    userName: "app",
    userId: "10001",
    eventType: "execve",
  });
  const serialized = JSON.stringify(event);
  for (const secret of ["Sensitive command", "super-secret", "TOKEN=", "secret file"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(event.eventId, /^frte_[a-f0-9]{48}$/u);
  assert.match(event.evidenceSha256, /^[a-f0-9]{64}$/u);
});

test("supports a bounded batch and produces stable idempotency evidence", () => {
  const first = parseFalcoRuntimePayload({
    clusterId,
    body: bytes({ events: [falcosidekickEvent, { ...falcosidekickEvent, output: "different raw text" }] }),
  });
  assert.equal(first.length, 2);
  assert.equal(first[0].eventId, first[1].eventId);
  assert.equal(first[0].evidenceSha256, first[1].evidenceSha256);
});

test("rejects malformed and oversized input", () => {
  assert.throws(
    () => parseFalcoRuntimePayload({
      clusterId,
      body: bytes({ ...falcosidekickEvent, priority: "NotARealPriority" }),
    }),
    (error: unknown) =>
      error instanceof FalcoRuntimeBoundaryError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => parseFalcoRuntimePayload({
      clusterId,
      body: new Uint8Array(256 * 1024 + 1),
    }),
    (error: unknown) =>
      error instanceof FalcoRuntimeBoundaryError && error.code === "BODY_TOO_LARGE",
  );
});

test("timeline and case projections are explicit and never auto-contain", () => {
  const [event] = parseFalcoRuntimePayload({ clusterId, body: bytes(falcosidekickEvent) });
  assert.equal(projectFalcoTimeline(event).subject, "payments/api-75d9/api");
  assert.deepEqual(falcoCaseCandidate(event), {
    sourceType: "falco_runtime_event",
    sourceId: event.eventId,
    title: "Runtime detection: Terminal shell in container",
    severity: "critical",
    occurredAt: event.occurredAt,
    evidenceSha256: event.evidenceSha256,
    requiresHumanApproval: true,
    automaticContainment: false,
    permittedNextAction: "create_case",
  });
});
