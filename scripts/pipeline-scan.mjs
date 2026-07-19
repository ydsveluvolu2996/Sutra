#!/usr/bin/env node
// Combined CI/CD pipeline security gate. Composes the security scanners a
// pipeline should run before shipping into a single pass/fail decision:
//   1. Repository secret scan  (scripts/check-repository-secrets.mjs)
//   2. IaC misconfiguration gate (scripts/iac-scan.mjs, when IaC inputs given)
//   3. Container image vuln scan (Trivy, when --image given and trivy is present)
// Each stage reports pass / fail / skipped; the gate fails (exit 2) if ANY stage
// failed. A stage is only "skipped" when its input or tool is genuinely absent —
// a skipped stage is reported honestly and never silently treated as a pass.
//
// Usage:
//   node scripts/pipeline-scan.mjs [--terraform plan.json] [--manifests m.json]
//     [--image repo@sha256:...] [--fail-on critical|high|medium|low]
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Pure aggregation: the gate passes only when no stage failed. Skipped stages
 * (absent input/tool) never fail the gate but are surfaced. Exit 2 = gate
 * breached (a stage failed), distinct from 1 = runtime error.
 */
export function combinePipelineGate(stages) {
  const failed = stages.filter((stage) => stage.status === "fail");
  const skipped = stages.filter((stage) => stage.status === "skipped");
  const passed = stages.filter((stage) => stage.status === "pass");
  const breached = failed.length > 0;
  return {
    passed: !breached,
    breached,
    exitCode: breached ? 2 : 0,
    counts: { passed: passed.length, failed: failed.length, skipped: skipped.length },
    stages,
  };
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : undefined;
}

function toolAvailable(tool) {
  const probe = spawnSync(tool, ["--version"], { encoding: "utf8" });
  return !probe.error && (probe.status === 0 || probe.status === null);
}

function runNode(scriptRelative, args) {
  return spawnSync(process.execPath, [resolve(here, scriptRelative), ...args], { encoding: "utf8" });
}

function main() {
  const failOn = arg("fail-on") ?? "high";
  const terraform = arg("terraform");
  const manifests = arg("manifests");
  const image = arg("image");
  const stages = [];

  // 1. Secret scan — always runs; the repo checker exits non-zero on a finding.
  const secrets = runNode("check-repository-secrets.mjs", []);
  stages.push({ name: "secret-scan", status: secrets.status === 0 ? "pass" : "fail", detail: secrets.status === 0 ? "no committed secrets" : "committed secret or local state detected" });

  // 2. IaC gate — only when IaC inputs are supplied.
  if (terraform !== undefined || manifests !== undefined) {
    const iacArgs = ["--fail-on", failOn];
    if (terraform !== undefined) iacArgs.push("--terraform", terraform);
    if (manifests !== undefined) iacArgs.push("--manifests", manifests);
    const iac = runNode("iac-scan.mjs", iacArgs);
    stages.push({ name: "iac-scan", status: iac.status === 0 ? "pass" : iac.status === 2 ? "fail" : "fail", detail: iac.status === 2 ? `findings at or above ${failOn}` : iac.status === 0 ? "clean" : (iac.stderr || "iac scan error").trim() });
  } else {
    stages.push({ name: "iac-scan", status: "skipped", detail: "no --terraform or --manifests provided" });
  }

  // 3. Image vuln scan — only when an image is given and Trivy is installed.
  if (image === undefined) {
    stages.push({ name: "image-scan", status: "skipped", detail: "no --image provided" });
  } else if (!toolAvailable("trivy")) {
    stages.push({ name: "image-scan", status: "skipped", detail: "trivy not installed on PATH" });
  } else {
    const severities = failOn === "critical" ? "CRITICAL" : failOn === "high" ? "HIGH,CRITICAL" : failOn === "medium" ? "MEDIUM,HIGH,CRITICAL" : "LOW,MEDIUM,HIGH,CRITICAL";
    const scan = spawnSync("trivy", ["image", "--quiet", "--severity", severities, "--exit-code", "1", "--ignore-unfixed", image], { encoding: "utf8" });
    stages.push({ name: "image-scan", status: scan.status === 0 ? "pass" : "fail", detail: scan.status === 0 ? "no fixable vulns at or above threshold" : `fixable vulns at or above ${failOn}` });
  }

  const gate = combinePipelineGate(stages);
  // Optional machine-readable handoff: write the stage results as JSON so a
  // downstream tool (e.g. scripts/ci-gate.mjs for JUnit publishing in Jenkins)
  // can consume them without re-running the scanners.
  const jsonPath = arg("json");
  if (jsonPath !== undefined) writeFileSync(jsonPath, `${JSON.stringify(gate.stages, null, 2)}\n`, "utf8");
  for (const stage of gate.stages) {
    process.stdout.write(`${stage.status.toUpperCase().padEnd(8)} ${stage.name}  ${stage.detail}\n`);
  }
  process.stdout.write(`\nPipeline gate: ${gate.passed ? "PASSED" : "FAILED"} (${gate.counts.passed} passed · ${gate.counts.failed} failed · ${gate.counts.skipped} skipped)\n`);
  process.exitCode = gate.exitCode;
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error.message ?? error);
    process.exitCode = 1;
  }
}
