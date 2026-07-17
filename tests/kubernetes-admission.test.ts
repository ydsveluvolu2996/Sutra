import assert from "node:assert/strict";
import test from "node:test";

import {
  KubernetesAdmissionEvidenceError,
  normalizeKyvernoPolicyReport,
} from "../lib/kubernetes-admission.ts";

const report = {
  apiVersion: "wgpolicyk8s.io/v1alpha2",
  kind: "PolicyReport",
  metadata: {
    name: "policy-report-demo",
    namespace: "payments",
    labels: { customerSecret: "must-not-survive" },
  },
  results: [{
    policy: "require-non-root",
    rule: "run-as-non-root",
    result: "fail",
    severity: "high",
    category: "Pod Security",
    source: "kyverno",
    timestamp: { seconds: 1_784_233_800 },
    message: "raw upstream message must not be retained",
    resources: [{
      apiVersion: "v1",
      kind: "Pod",
      namespace: "payments",
      name: "checkout-api",
      uid: "5fe70d17-671d-4a7b-a166-b477cab6d1cb",
    }],
  }],
} as const;

test("normalizes bounded Kyverno policy evidence without retaining raw content", async () => {
  const normalized = await normalizeKyvernoPolicyReport({
    clusterId: "738663485493:ap-south-1:customer-cluster",
    collectedAt: "2026-07-17T14:30:00.000Z",
    mode: "audit",
    report,
  });

  assert.equal(normalized.summary.FAIL, 1);
  assert.equal(normalized.results[0]?.policy, "require-non-root");
  assert.equal(normalized.results[0]?.resources[0]?.name, "checkout-api");
  assert.match(normalized.evidenceSha256, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes("raw upstream message"), false);
  assert.equal(serialized.includes("customerSecret"), false);
  assert.equal(serialized.includes("must-not-survive"), false);
});

test("produces deterministic evidence independent of unretained report fields", async () => {
  const first = await normalizeKyvernoPolicyReport({
    clusterId: "738663485493:ap-south-1:customer-cluster",
    collectedAt: "2026-07-17T14:30:00.000Z",
    mode: "audit",
    report,
  });
  const second = await normalizeKyvernoPolicyReport({
    clusterId: "738663485493:ap-south-1:customer-cluster",
    collectedAt: "2026-07-17T14:30:00.000Z",
    mode: "audit",
    report: {
      ...report,
      metadata: { ...report.metadata, labels: { customerSecret: "different" } },
      results: [{ ...report.results[0], message: "different unretained message" }],
    },
  });

  assert.equal(first.evidenceSha256, second.evidenceSha256);
});

test("rejects unsupported reports, excessive resources, and malformed identity", async () => {
  await assert.rejects(
    normalizeKyvernoPolicyReport({
      clusterId: "customer-cluster",
      collectedAt: "2026-07-17T14:30:00.000Z",
      mode: "audit",
      report: { ...report, apiVersion: "wgpolicyk8s.io/v1alpha1" },
    }),
    KubernetesAdmissionEvidenceError,
  );
  await assert.rejects(
    normalizeKyvernoPolicyReport({
      clusterId: "customer-cluster",
      collectedAt: "2026-07-17T14:30:00.000Z",
      mode: "enforce",
      report: {
        ...report,
        results: [{
          ...report.results[0],
          resources: Array.from({ length: 17 }, () => report.results[0].resources[0]),
        }],
      },
    }),
    KubernetesAdmissionEvidenceError,
  );
  await assert.rejects(
    normalizeKyvernoPolicyReport({
      clusterId: "unsafe cluster id",
      collectedAt: "2026-07-17T14:30:00.000Z",
      mode: "audit",
      report,
    }),
    KubernetesAdmissionEvidenceError,
  );
});
