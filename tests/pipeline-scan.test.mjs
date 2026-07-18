import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { combinePipelineGate } from "../scripts/pipeline-scan.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/pipeline-scan.mjs", import.meta.url));

test("combinePipelineGate passes only when no stage failed", () => {
  const gate = combinePipelineGate([
    { name: "secret-scan", status: "pass" },
    { name: "iac-scan", status: "skipped" },
    { name: "image-scan", status: "skipped" },
  ]);
  assert.equal(gate.passed, true);
  assert.equal(gate.exitCode, 0);
  assert.deepEqual(gate.counts, { passed: 1, failed: 0, skipped: 2 });
});

test("combinePipelineGate breaches (exit 2) when any stage failed; skips never fail it", () => {
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

test("end-to-end: runs the secret scan and honestly skips IaC and image when no inputs given", () => {
  const result = spawnSync(process.execPath, [RUNNER], { encoding: "utf8" });
  // The repo is clean of committed secrets, so the secret stage passes → gate 0.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /secret-scan/u);
  assert.match(result.stdout, /SKIPPED\s+iac-scan\s+no --terraform or --manifests provided/u);
  assert.match(result.stdout, /SKIPPED\s+image-scan\s+no --image provided/u);
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
  assert.match(result.stdout, /FAIL\s+iac-scan/u);
  assert.match(result.stdout, /Pipeline gate: FAILED/u);
});
