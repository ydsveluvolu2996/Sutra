#!/usr/bin/env node
// Combined CI/CD pipeline security gate. Composes the security scanners a
// pipeline should run before shipping into a single pass/fail decision:
//   1. Repository secret scan  (scripts/check-repository-secrets.mjs)
//   2. Repository dependency vulnerability scan (Trivy, always required)
//   3. Repository IaC/configuration scan (Trivy, always required)
//   4. Structured IaC evidence scan (scripts/iac-scan.mjs, when inputs are given)
//   5. Container image vulnerability scan (Trivy, when --image is given)
// A requested scanner is fail-closed: a missing executable, invalid input, or
// scanner error is a failed stage. Optional stages are omitted rather than being
// reported as a successful build.
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
 * Pure aggregation: the gate passes only when every requested stage passed.
 * Legacy/foreign callers that supply a "skipped" stage are failed closed.
 * Exit 2 = gate breached, distinct from 1 = an uncaught runner error.
 */
export function combinePipelineGate(stages) {
  const failed = stages.filter((stage) => stage.status === "fail");
  const skipped = stages.filter((stage) => stage.status === "skipped");
  const passed = stages.filter((stage) => stage.status === "pass");
  const breached = failed.length > 0 || skipped.length > 0;
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

function detailFrom(result, fallback) {
  return (result.stderr || result.stdout || fallback).trim().split("\n").at(-1) || fallback;
}

function emitFailureEvidence(result) {
  const evidence = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  if (evidence.length > 0) process.stderr.write(`${evidence}\n`);
}

function main() {
  const failOn = arg("fail-on") ?? "high";
  const terraform = arg("terraform");
  const manifests = arg("manifests");
  const image = arg("image");
  const repository = resolve(arg("repository") ?? resolve(here, ".."));
  const stages = [];
  const severities = failOn === "critical" ? "CRITICAL" : failOn === "high" ? "HIGH,CRITICAL" : failOn === "medium" ? "MEDIUM,HIGH,CRITICAL" : failOn === "low" ? "LOW,MEDIUM,HIGH,CRITICAL" : undefined;
  if (severities === undefined) throw new Error("--fail-on must be one of critical|high|medium|low");

  // 1. Secret scan — always runs; the repo checker exits non-zero on a finding.
  const secrets = runNode("check-repository-secrets.mjs", []);
  stages.push({
    name: "secret-scan",
    status: secrets.status === 0 ? "pass" : "fail",
    detail: secrets.status === 0 ? "no committed secrets" : detailFrom(secrets, "committed secret, local state, or scanner error detected"),
  });

  // 2–3. The repository scanners are mandatory. Tool absence is not a pass.
  if (!toolAvailable("trivy")) {
    stages.push({ name: "dependency-scan", status: "fail", detail: "required scanner unavailable: trivy is not installed on PATH" });
    stages.push({ name: "configuration-scan", status: "fail", detail: "required scanner unavailable: trivy is not installed on PATH" });
  } else {
    const dependencies = spawnSync("trivy", [
      "fs", "--quiet", "--scanners", "vuln", "--severity", severities,
      "--exit-code", "1", "--ignore-unfixed", repository,
    ], { encoding: "utf8" });
    if (dependencies.status !== 0) emitFailureEvidence(dependencies);
    stages.push({
      name: "dependency-scan",
      status: dependencies.status === 0 ? "pass" : "fail",
      detail: dependencies.status === 0
        ? `no fixable dependency vulnerabilities at or above ${failOn}`
        : `dependency vulnerability or scanner error at or above ${failOn}; see scanner evidence above`,
    });

    const configuration = spawnSync("trivy", [
      "config", "--quiet", "--severity", severities, "--exit-code", "1",
      "--ignorefile", resolve(repository, ".trivyignore.yaml"), repository,
    ], { encoding: "utf8" });
    if (configuration.status !== 0) emitFailureEvidence(configuration);
    stages.push({
      name: "configuration-scan",
      status: configuration.status === 0 ? "pass" : "fail",
      detail: configuration.status === 0
        ? `no IaC/configuration findings at or above ${failOn}`
        : `IaC/configuration finding or scanner error at or above ${failOn}; see scanner evidence above`,
    });
  }

  // 4. The Sutra structured IaC engine is an additional gate when an exported
  // Terraform plan or Kubernetes JSON manifest is supplied.
  if (terraform !== undefined || manifests !== undefined) {
    const iacArgs = ["--fail-on", failOn];
    if (terraform !== undefined) iacArgs.push("--terraform", terraform);
    if (manifests !== undefined) iacArgs.push("--manifests", manifests);
    const iac = runNode("iac-scan.mjs", iacArgs);
    stages.push({
      name: "structured-iac-scan",
      status: iac.status === 0 ? "pass" : "fail",
      detail: iac.status === 0 ? "clean" : detailFrom(iac, `structured IaC finding or scanner error at or above ${failOn}`),
    });
  }

  // 5. Image scanning becomes mandatory as soon as an immutable image reference
  // is supplied. The release workflow passes digest references, never mutable tags.
  if (image !== undefined) {
    if (!toolAvailable("trivy")) {
      stages.push({ name: "image-scan", status: "fail", detail: "required scanner unavailable: trivy is not installed on PATH" });
    } else {
      const scan = spawnSync("trivy", [
        "image", "--quiet", "--pkg-types", "os,library", "--severity", severities,
        "--exit-code", "1", "--ignore-unfixed", image,
      ], { encoding: "utf8" });
      if (scan.status !== 0) emitFailureEvidence(scan);
      stages.push({
        name: "image-scan",
        status: scan.status === 0 ? "pass" : "fail",
        detail: scan.status === 0
          ? "no fixable image vulnerabilities at or above threshold"
          : `image vulnerability or scanner error at or above ${failOn}; see scanner evidence above`,
      });
    }
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
