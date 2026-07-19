#!/usr/bin/env node
// CI/CD scan-gate CLI. Reads security stage results (produced by the pipeline's
// scanners), evaluates the severity-aware gate, optionally writes a JUnit XML
// report for the CI system to publish, prints a human summary, and exits with
// the gate's code (0 = pass, 2 = breached). Pure decision logic lives in the
// tested lib/ci-scan-gate.ts engine; this is a thin, side-effecting shell.
//
// Usage:
//   node scripts/ci-gate.mjs --stages stages.json [--fail-on high] [--junit gate.xml]
//   cat stages.json | node scripts/ci-gate.mjs --stages -   # read stdin
//
// stages.json is a JSON array of:
//   { "name": "image-vulns", "status": "pass|fail|skipped",
//     "findings": 3, "highestSeverity": "critical|high|medium|low|null",
//     "detail": "..." }
import { readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateCiGate, renderCiGateJUnit, renderCiGateSummary } from "../lib/ci-scan-gate.ts";

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const STATUSES = new Set(["pass", "fail", "skipped"]);

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function fail(message) {
  process.stderr.write(`ci-gate: ${message}\n`);
  process.exit(1);
}

function parseStages(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("--stages input is not valid JSON");
  }
  if (!Array.isArray(parsed)) return fail("--stages input must be a JSON array");
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) return fail(`stage ${index} is not an object`);
    const { name, status, findings, highestSeverity, detail } = entry;
    if (typeof name !== "string" || name.length === 0) return fail(`stage ${index} has no name`);
    if (!STATUSES.has(status)) return fail(`stage ${index} (${name}) has invalid status`);
    if (findings !== undefined && (!Number.isInteger(findings) || findings < 0)) {
      return fail(`stage ${index} (${name}) has invalid findings`);
    }
    if (
      highestSeverity !== undefined && highestSeverity !== null && !SEVERITIES.has(highestSeverity)
    ) return fail(`stage ${index} (${name}) has invalid highestSeverity`);
    if (detail !== undefined && typeof detail !== "string") return fail(`stage ${index} (${name}) has invalid detail`);
    return { name, status, findings, highestSeverity, detail };
  });
}

function main() {
  const stagesPath = arg("--stages");
  if (stagesPath === undefined) return fail("--stages <file|-> is required");
  const failOn = arg("--fail-on") ?? "high";
  if (!SEVERITIES.has(failOn)) return fail("--fail-on must be critical|high|medium|low");
  const junitPath = arg("--junit");

  const raw = stagesPath === "-" ? readFileSync(0, "utf8") : readFileSync(stagesPath, "utf8");
  const stages = parseStages(raw);
  const decision = evaluateCiGate(stages, { failOn });

  if (junitPath !== undefined) writeFileSync(junitPath, renderCiGateJUnit(decision), "utf8");
  process.stdout.write(`${renderCiGateSummary(decision)}\n`);
  process.exit(decision.exitCode);
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
