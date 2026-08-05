import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { combinePipelineGate } from "../scripts/pipeline-scan.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/pipeline-scan.mjs", import.meta.url));

test("combinePipelineGate passes only when every requested stage passed", () => {
  const gate = combinePipelineGate([
    { name: "secret-scan", status: "pass" },
    { name: "dependency-scan", status: "pass" },
    { name: "configuration-scan", status: "pass" },
  ]);
  assert.equal(gate.passed, true);
  assert.equal(gate.exitCode, 0);
  assert.deepEqual(gate.counts, { passed: 3, failed: 0, skipped: 0 });
});

test("combinePipelineGate breaches when a stage fails or is unexpectedly skipped", () => {
  const gate = combinePipelineGate([
    { name: "secret-scan", status: "pass" },
    { name: "iac-scan", status: "fail" },
    { name: "image-scan", status: "skipped" },
  ]);
  assert.equal(gate.passed, false);
  assert.equal(gate.breached, true);
  assert.equal(gate.exitCode, 2);
  assert.equal(gate.counts.failed, 1);
});

test("end-to-end: always runs repository secret, dependency, and configuration gates", () => {
  const result = spawnSync(process.execPath, [RUNNER], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS\s+secret-scan/u);
  assert.match(result.stdout, /PASS\s+dependency-scan/u);
  assert.match(result.stdout, /PASS\s+configuration-scan/u);
  assert.doesNotMatch(result.stdout, /SKIPPED/u);
  assert.match(result.stdout, /Pipeline gate: PASSED/u);
});

test("end-to-end: a misconfigured IaC input fails the pipeline gate with exit 2", () => {
  const plan = JSON.stringify({ planned_values: { root_module: { resources: [
    { type: "aws_db_instance", name: "db", address: "aws_db_instance.db", values: { publicly_accessible: true, storage_encrypted: false } },
  ] } } });
  const planPath = join(mkdtempSync(join(tmpdir(), "pipeline-")), "plan.json");
  writeFileSync(planPath, plan);
  const result = spawnSync(process.execPath, [RUNNER, "--terraform", planPath], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL\s+structured-iac-scan/u);
  assert.match(result.stdout, /Pipeline gate: FAILED/u);
});

test("end-to-end: missing required Trivy fails closed instead of skipping", () => {
  const result = spawnSync(process.execPath, [RUNNER], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL\s+dependency-scan\s+required scanner unavailable/u);
  assert.match(result.stdout, /FAIL\s+configuration-scan\s+required scanner unavailable/u);
  assert.doesNotMatch(result.stdout, /SKIPPED/u);
});
