#!/usr/bin/env node
// Agentless snapshot-scan CLI. `plan` (default) is fully offline: it normalizes
// an EC2 DescribeVolumes JSON and prints the deterministic scan plan — no AWS
// call, no cost. `apply` is deliberately refused unless BOTH --execute and
// --i-accept-aws-cost are given AND a real executor is wired (the EC2/KMS
// executor lives in services/aws-collector and runs only against a live
// account), so a snapshot can never be created by accident.
//
// Usage:
//   node scripts/agentless-scan.mjs plan --volumes describe-volumes.json
//     [--scan-account 111122223333] [--kms-key <arn>]
//     [--required-tag k=v] [--include-unattached] [--format human|json]
//   node scripts/agentless-scan.mjs apply ...            (refused here — see above)
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDescribedVolumes } from "../lib/aws-agentless-discovery.ts";
import { buildAgentlessScanPlan } from "../lib/aws-agentless-scan-plan.ts";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

export async function buildPlanFromDescribeVolumes(describeVolumes, options) {
  const volumes = normalizeDescribedVolumes(describeVolumes, { region: options.region ?? null });
  const requiredTags = {};
  for (const pair of options.requiredTags ?? []) {
    const [key, ...rest] = pair.split("=");
    if (key && rest.length > 0) requiredTags[key] = rest.join("=");
  }
  return buildAgentlessScanPlan({
    volumes,
    scanAccountId: options.scanAccountId ?? "unscoped",
    kmsKeyArn: options.kmsKeyArn ?? null,
    policy: {
      requiredTags: Object.keys(requiredTags).length > 0 ? requiredTags : undefined,
      includeUnattached: options.includeUnattached ?? false,
    },
  });
}

function renderHuman(plan) {
  const lines = [`Agentless scan plan (${plan.mode}) · account ${plan.scanAccountId} · scanners ${plan.scanners.join(", ")}${plan.kmsReencrypt ? " · KMS re-encrypt" : ""}`];
  for (const volume of plan.volumes) {
    lines.push(`  ${volume.volumeId} (${volume.region}, ${volume.sizeGiB} GiB): ${volume.steps.map((step) => step.kind).join(" -> ")}`);
  }
  for (const skip of plan.skipped) lines.push(`  SKIP ${skip.volumeId}: ${skip.reason}`);
  const s = plan.summary;
  lines.push("");
  lines.push(`In scope: ${s.inScope} · skipped: ${s.skipped} · snapshots: ${s.snapshots} · teardown steps: ${s.teardownSteps} · waves: ${s.concurrencyWaves} · TTL ${s.snapshotTtlHours}h`);
  lines.push(plan.disclaimer);
  return lines.join("\n");
}

async function main() {
  const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "plan";
  if (process.argv.includes("--help") || !["plan", "apply"].includes(command)) {
    process.stdout.write("Usage: node scripts/agentless-scan.mjs plan --volumes <describe-volumes.json> [--scan-account ID] [--kms-key ARN] [--required-tag k=v] [--include-unattached] [--format human|json]\n");
    return;
  }

  const volumesPath = arg("volumes");
  if (typeof volumesPath !== "string") throw new Error("Provide --volumes <EC2 DescribeVolumes JSON>.");
  const describeVolumes = JSON.parse(await readFile(resolve(volumesPath), "utf8"));
  const requiredTags = process.argv.reduce((acc, value, index) => (value === "--required-tag" && typeof process.argv[index + 1] === "string" ? [...acc, process.argv[index + 1]] : acc), []);
  const plan = await buildPlanFromDescribeVolumes(describeVolumes, {
    region: arg("region"),
    scanAccountId: arg("scan-account"),
    kmsKeyArn: arg("kms-key"),
    requiredTags,
    includeUnattached: flag("include-unattached"),
  });

  if (command === "apply") {
    // Hard cost/safety gate — apply needs live AWS + explicit acknowledgment,
    // and the real executor is wired in services/aws-collector, not here.
    if (!flag("execute") || !flag("i-accept-aws-cost")) {
      throw new Error("apply refused: pass --execute AND --i-accept-aws-cost, and run via the services/aws-collector executor (it creates snapshots and incurs AWS cost).");
    }
    throw new Error("apply from this CLI is not wired: execute the plan through the AWS-authenticated services/aws-collector agentless executor.");
  }

  process.stdout.write((arg("format") === "json" ? JSON.stringify(plan, null, 2) : renderHuman(plan)) + "\n");
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => { console.error(error.message ?? error); process.exitCode = 1; });
}
