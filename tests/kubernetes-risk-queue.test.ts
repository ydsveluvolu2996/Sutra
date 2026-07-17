import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKubernetesRiskQueue,
  toRiskQueueCsv,
  type RiskPostureInput,
  type RiskScannerInput,
} from "../lib/kubernetes-risk-queue.ts";
import type { AttackGraphNode, KubernetesAttackPath } from "../lib/kubernetes-attack-paths.ts";

function node(key: string): AttackGraphNode {
  return { key, label: key, kind: "aws_resource", resourceKey: key };
}

function path(overrides: Partial<KubernetesAttackPath> & { id: string }): KubernetesAttackPath {
  return {
    id: overrides.id,
    type: "cloud_to_kubernetes",
    title: overrides.title ?? overrides.id,
    nodes: overrides.nodes ?? [node("wl"), node("aws")],
    edges: [],
    findings: [],
    factors: [],
    score: overrides.score ?? 50,
    risk: overrides.risk ?? "medium",
    blastRadius: overrides.blastRadius ?? [],
    observedFrom: null,
    observedTo: null,
    remediations: overrides.remediations ?? [],
  };
}

function posture(overrides: Partial<RiskPostureInput> & { controlId: string }): RiskPostureInput {
  return {
    controlId: overrides.controlId,
    subject: overrides.subject ?? "default/workload",
    state: overrides.state ?? "FAIL",
    severity: overrides.severity ?? "HIGH",
    message: overrides.message ?? "control failed",
  };
}

function scanner(overrides: Partial<RiskScannerInput> & { fingerprint: string }): RiskScannerInput {
  return {
    fingerprint: overrides.fingerprint,
    severity: overrides.severity ?? "high",
    title: overrides.title ?? "finding",
    cveId: overrides.cveId ?? null,
    checkId: overrides.checkId ?? null,
    fixedVersion: overrides.fixedVersion ?? null,
    packageName: overrides.packageName ?? null,
    affectedResource: overrides.affectedResource ?? { namespace: "default", name: "workload" },
  };
}

test("merges all three evidence sources into one ranked queue", () => {
  const summary = buildKubernetesRiskQueue({
    attackPaths: [path({ id: "p1", risk: "high", score: 80, blastRadius: [node("a"), node("b")] })],
    postureFindings: [posture({ controlId: "K8S-WORKLOAD-NO-PRIVILEGED", severity: "CRITICAL" })],
    scannerFindings: [scanner({ fingerprint: "f1", severity: "medium", cveId: "CVE-2026-1" })],
  });
  assert.equal(summary.schema, "sutra.kubernetes-risk-queue.v1");
  assert.equal(summary.items.length, 3);
  assert.deepEqual(
    [...new Set(summary.items.map((item) => item.source))].sort(),
    ["attack_path", "posture", "scanner"],
  );
  assert.equal(summary.totals.items, 3);
  assert.equal(summary.totals.critical, 1);
});

test("a blast-radius-heavy attack path outranks an isolated same-severity finding", () => {
  const summary = buildKubernetesRiskQueue({
    attackPaths: [path({ id: "p1", risk: "high", score: 90, blastRadius: [node("a"), node("b"), node("c"), node("d")] })],
    postureFindings: [posture({ controlId: "C1", severity: "HIGH" })],
    scannerFindings: [],
  });
  assert.equal(summary.items[0]?.source, "attack_path");
  assert.ok(summary.items[0].priority > (summary.items[1]?.priority ?? 0));
  assert.equal(summary.items[0].blastRadius, 4);
});

test("a critical isolated finding still outranks a low-severity broad path", () => {
  const summary = buildKubernetesRiskQueue({
    attackPaths: [path({ id: "p1", risk: "low", score: 20, blastRadius: [node("a"), node("b"), node("c")] })],
    postureFindings: [posture({ controlId: "C1", severity: "CRITICAL" })],
    scannerFindings: [],
  });
  assert.equal(summary.items[0]?.severity, "critical");
});

test("passing posture controls and unknown-severity scanner findings are excluded", () => {
  const summary = buildKubernetesRiskQueue({
    attackPaths: [],
    postureFindings: [
      posture({ controlId: "PASSING", state: "PASS", severity: "HIGH" }),
      posture({ controlId: "UNKNOWN-STATE", state: "UNKNOWN", severity: "HIGH" }),
    ],
    scannerFindings: [scanner({ fingerprint: "f1", severity: "unknown" })],
  });
  assert.equal(summary.items.length, 0);
  assert.equal(summary.totals.items, 0);
});

test("scanner recommendation names the fixed version when known", () => {
  const summary = buildKubernetesRiskQueue({
    attackPaths: [],
    postureFindings: [],
    scannerFindings: [scanner({ fingerprint: "f1", packageName: "openssl", fixedVersion: "3.2.1" })],
  });
  assert.match(summary.items[0]?.recommendation ?? "", /Upgrade openssl to 3\.2\.1 or later/u);
});

test("CSV export escapes commas and quotes and carries a stable header", () => {
  const summary = buildKubernetesRiskQueue({
    attackPaths: [path({ id: "p1", title: "Exposure, privilege \"escalation\"", risk: "critical", blastRadius: [node("a")] })],
    postureFindings: [],
    scannerFindings: [],
  });
  const csv = toRiskQueueCsv(summary);
  const [header, firstRow] = csv.split("\r\n");
  assert.equal(header, "priority,severity,source,title,subject,blast_radius,recommendation,evidence_ref");
  assert.match(firstRow, /"Exposure, privilege ""escalation"""/u);
});

test("queue ordering is deterministic for identical input", () => {
  const build = () => buildKubernetesRiskQueue({
    attackPaths: [path({ id: "p2", risk: "high" }), path({ id: "p1", risk: "high" })],
    postureFindings: [posture({ controlId: "C1", severity: "high" as unknown as "HIGH" })],
    scannerFindings: [scanner({ fingerprint: "f1", severity: "high" })],
  });
  assert.deepEqual(build(), build());
});
