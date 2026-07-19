import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGate, toSarif } from "../scripts/iac-scan.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/iac-scan.mjs", import.meta.url));

function report(overrides = {}) {
  return {
    schema: "sutra.iac-misconfiguration.v1",
    tenant: null,
    findings: [],
    summary: { resources: 0, findings: 0, critical: 0, high: 0, medium: 0, low: 0, notEvaluated: 0 },
    coverage: { evaluatedKinds: [], notEvaluated: [] },
    disclaimer: "d",
    ...overrides,
  };
}

test("evaluateGate: clean report passes at every threshold with exit 0", () => {
  const gate = evaluateGate(report(), { failOn: "low" });
  assert.equal(gate.breached, false);
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.count, 0);
});

test("evaluateGate: counts only severities at or above the threshold", () => {
  const summary = { resources: 4, findings: 4, critical: 1, high: 1, medium: 1, low: 1, notEvaluated: 0 };
  // default high: critical + high = 2
  assert.equal(evaluateGate(report({ summary })).count, 2);
  assert.equal(evaluateGate(report({ summary }), { failOn: "high" }).breached, true);
  // critical only: 1
  assert.equal(evaluateGate(report({ summary }), { failOn: "critical" }).count, 1);
  // medium: critical + high + medium = 3
  assert.equal(evaluateGate(report({ summary }), { failOn: "medium" }).count, 3);
  // low: all 4
  assert.equal(evaluateGate(report({ summary }), { failOn: "low" }).count, 4);
});

test("evaluateGate: a report with only medium findings passes a high gate", () => {
  const summary = { resources: 1, findings: 1, critical: 0, high: 0, medium: 1, low: 0, notEvaluated: 0 };
  const gate = evaluateGate(report({ summary }), { failOn: "high" });
  assert.equal(gate.breached, false);
  assert.equal(gate.exitCode, 0);
});

test("toSarif: maps findings to SARIF 2.1.0 results and dedupes rules, never leaking config values", () => {
  const findings = [
    { ruleId: "RDS_PUBLICLY_ACCESSIBLE", severity: "high", kind: "aws_db_instance", resourceName: "db", message: "publicly accessible", remediationHint: "set false", evidencePath: "config.publicly_accessible", sourceRef: { file: "main.tf", line: 12 } },
    { ruleId: "RDS_PUBLICLY_ACCESSIBLE", severity: "high", kind: "aws_db_instance", resourceName: "db2", message: "publicly accessible", remediationHint: "set false", evidencePath: "config.publicly_accessible" },
    { ruleId: "S3_PUBLIC_ACL", severity: "critical", kind: "aws_s3_bucket", resourceName: "b", message: "public acl", remediationHint: "make private", evidencePath: "config.acl" },
  ];
  const sarif = toSarif(report({ findings }));
  assert.equal(sarif.version, "2.1.0");
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, "sutra-iac-scan");
  assert.equal(run.tool.driver.rules.length, 2, "two distinct ruleIds → two rules");
  assert.equal(run.results.length, 3);
  assert.equal(run.results[0].level, "error");
  assert.equal(run.results[0].locations[0].physicalLocation.region.startLine, 12);
  // a finding without sourceRef falls back to a synthetic uri and omits region
  assert.equal(run.results[1].locations[0].physicalLocation.artifactLocation.uri, "aws_db_instance/db2");
  assert.equal(run.results[1].locations[0].physicalLocation.region, undefined);
});

test("end-to-end: a publicly-accessible unencrypted RDS plan fails the default high gate with exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "iac-scan-"));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify({
    planned_values: { root_module: { resources: [
      { type: "aws_db_instance", name: "db", address: "aws_db_instance.db", values: { publicly_accessible: true, storage_encrypted: false } },
    ] } },
  }));
  const result = spawnSync(process.execPath, [RUNNER, "--terraform", planPath, "--format", "json"], { encoding: "utf8" });
  assert.equal(result.status, 2, `expected gate breach exit 2, got ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.findings.some((f) => f.ruleId === "RDS_PUBLICLY_ACCESSIBLE"));
  assert.equal(parsed.gate.breached, true);
  assert.equal(parsed.gate.failOn, "high");
});

test("end-to-end: --fail-on critical lets a high-only plan pass with exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "iac-scan-"));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, JSON.stringify({
    planned_values: { root_module: { resources: [
      { type: "aws_db_instance", name: "db", address: "aws_db_instance.db", values: { publicly_accessible: true, storage_encrypted: true } },
    ] } },
  }));
  const result = spawnSync(process.execPath, [RUNNER, "--terraform", planPath, "--fail-on", "critical"], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected pass exit 0, got ${result.status}: ${result.stderr}`);
});

test("end-to-end: no input is a runtime error (exit 1), distinct from a gate breach (exit 2)", () => {
  const result = spawnSync(process.execPath, [RUNNER], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Provide --terraform/u);
});
