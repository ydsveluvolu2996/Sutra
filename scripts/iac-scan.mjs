#!/usr/bin/env node
// Shift-left IaC misconfiguration gate for CI/CD. Runs the same tested, pure
// engines as the in-browser /iac-scan tool (lib/iac-scan-input + iac-normalizer +
// iac-misconfiguration) over a Terraform plan JSON (`terraform show -json`) and/or
// Kubernetes manifest JSON, prints a human/JSON/SARIF report, and exits non-zero
// when findings at or above a severity threshold are present — so a pipeline can
// block a merge before the misconfiguration ships. No network, DB, or cluster:
// everything is evaluated locally from the provided files.
//
// Usage:
//   node scripts/iac-scan.mjs --terraform tfplan.json [--manifests manifests.json]
//     [--fail-on critical|high|medium|low] (default high)
//     [--format human|json|sarif] (default human) [--out report.json]
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseIacScanInput } from "../lib/iac-scan-input.ts";
import { normalizeIac } from "../lib/iac-normalizer.ts";
import { scanIacResources } from "../lib/iac-misconfiguration.ts";

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const SARIF_LEVEL = { critical: "error", high: "error", medium: "warning", low: "note" };

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : undefined;
}

/**
 * Pure CI gate: a build breaches when the count of findings at or above the
 * failOn severity is greater than zero. Returns the counts and the exit code
 * (2 = gate breached, 0 = clean) so the decision is unit-testable in isolation.
 */
export function evaluateGate(report, { failOn = "high" } = {}) {
  const threshold = SEVERITY_RANK[failOn] ?? SEVERITY_RANK.high;
  const counted = Object.entries(SEVERITY_RANK)
    .filter(([, rank]) => rank <= threshold)
    .reduce((sum, [severity]) => sum + (report.summary[severity] ?? 0), 0);
  const breached = counted > 0;
  return { failOn, breached, count: counted, exitCode: breached ? 2 : 0 };
}

/** Pure SARIF 2.1.0 mapper so findings can populate the GitHub code-scanning tab. */
export function toSarif(report) {
  const rules = [...new Map(report.findings.map((finding) => [finding.ruleId, finding])).values()].map((finding) => ({
    id: finding.ruleId,
    name: finding.ruleId,
    shortDescription: { text: finding.ruleId },
    help: { text: finding.remediationHint },
    defaultConfiguration: { level: SARIF_LEVEL[finding.severity] ?? "warning" },
  }));
  const results = report.findings.map((finding) => ({
    ruleId: finding.ruleId,
    level: SARIF_LEVEL[finding.severity] ?? "warning",
    message: { text: `${finding.kind}/${finding.resourceName}: ${finding.message}` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: finding.sourceRef?.file ?? `${finding.kind}/${finding.resourceName}` },
        ...(typeof finding.sourceRef?.line === "number" ? { region: { startLine: finding.sourceRef.line } } : {}),
      },
    }],
    properties: { evidencePath: finding.evidencePath, severity: finding.severity },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "sutra-iac-scan", informationUri: "https://sutracmdb.com", rules } }, results }],
  };
}

function renderHuman(report, gate) {
  const lines = [];
  for (const finding of report.findings) {
    lines.push(`${finding.severity.toUpperCase().padEnd(8)} ${finding.ruleId}  ${finding.kind}/${finding.resourceName}  (${finding.evidencePath})`);
    lines.push(`         ${finding.message}`);
    lines.push(`         fix: ${finding.remediationHint}`);
  }
  const s = report.summary;
  lines.push("");
  lines.push(`Resources: ${s.resources} · Findings: ${s.findings} (critical ${s.critical} · high ${s.high} · medium ${s.medium} · low ${s.low}) · Not evaluated: ${s.notEvaluated}`);
  lines.push(gate.breached
    ? `GATE FAILED: ${gate.count} finding(s) at or above "${gate.failOn}".`
    : `Gate passed at threshold "${gate.failOn}".`);
  lines.push(report.disclaimer);
  return lines.join("\n");
}

async function readJson(path) {
  return typeof path === "string" && path.trim().length > 0 ? await readFile(resolve(path), "utf8") : "";
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: node scripts/iac-scan.mjs --terraform <plan.json> [--manifests <manifests.json>] [--fail-on critical|high|medium|low] [--format human|json|sarif] [--out <file>]\n");
    return;
  }
  const failOn = arg("fail-on") ?? "high";
  if (!(failOn in SEVERITY_RANK)) throw new Error("--fail-on must be one of critical|high|medium|low");
  const format = arg("format") ?? "human";
  if (!["human", "json", "sarif"].includes(format)) throw new Error("--format must be one of human|json|sarif");

  const terraformText = await readJson(arg("terraform"));
  const manifestsText = await readJson(arg("manifests"));
  const parsed = parseIacScanInput({ terraformText, manifestsText });
  if (parsed.errors.length > 0) throw new Error(parsed.errors.join(" "));
  if (parsed.input.terraform === null && (parsed.input.manifests?.length ?? 0) === 0) {
    throw new Error("Provide --terraform and/or --manifests JSON to scan.");
  }

  const report = scanIacResources(normalizeIac(parsed.input));
  const gate = evaluateGate(report, { failOn });
  const rendered = format === "json"
    ? JSON.stringify({ ...report, gate }, null, 2)
    : format === "sarif"
      ? JSON.stringify(toSarif(report), null, 2)
      : renderHuman(report, gate);

  const out = arg("out");
  if (typeof out === "string" && out.trim().length > 0) {
    await writeFile(resolve(out), `${rendered}\n`, "utf8");
    process.stdout.write(renderHuman(report, gate) + "\n");
  } else {
    process.stdout.write(`${rendered}\n`);
  }
  process.exitCode = gate.exitCode; // 2 = gate breached (distinct from 1 = runtime error)
}

// Only run as a CLI when invoked directly — importing this module for its
// pure exports (evaluateGate/toSarif) must not execute the gate.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
