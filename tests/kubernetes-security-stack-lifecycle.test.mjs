import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cwd = new URL("..", import.meta.url);

const helmFake = `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--kube-context" ? rawArgs.slice(2) : rawArgs;
const state = new URL("./removed.json", import.meta.url);
let removed = [];
try { removed = JSON.parse(await readFile(state, "utf8")); } catch {}
if (args[0] === "uninstall") {
  removed.push(args[1]);
  await writeFile(state, JSON.stringify(removed));
  process.exit(0);
}
if (args[0] === "status" && removed.includes(args[1])) {
  process.stderr.write("release: not found");
  process.exit(1);
}
process.stdout.write("ok");
`;

const kubectlFake = `#!/usr/bin/env node
const args = process.argv.slice(2);
const joined = args.join(" ");
if (joined.includes("get daemonset aws-node") && joined.endsWith("-o json")) {
  process.stdout.write(JSON.stringify({
    status: { desiredNumberScheduled: 3, numberReady: 3, numberUnavailable: 0 }
  }));
} else if (joined.includes("get deployment sutra-falco-signing-gateway") ||
           joined.includes("get clusterpolicy sutra-")) {
  process.stdout.write("");
} else {
  process.stdout.write("ok");
}
`;

test("simulated lifecycle emits health evidence and proves reverse cleanup with AWS CNI recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-k8s-lifecycle-"));
  const state = join(directory, "removed.json");
  const helm = join(directory, "helm");
  const kubectl = join(directory, "kubectl");
  try {
    await Promise.all([
      writeFile(state, "[]"),
      writeFile(helm, helmFake),
      writeFile(kubectl, kubectlFake),
    ]);
    await Promise.all([chmod(helm, 0o700), chmod(kubectl, 0o700)]);
    const env = {
      ...process.env,
      PATH: `${directory}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      SUTRA_VALIDATION_TIME: "2026-07-17T09:00:00.000Z",
      SUTRA_FALCO_GATEWAY_IMAGE: `registry.example/sutra/falco-gateway@sha256:${"a".repeat(64)}`,
    };
    const common = [
      "--context", "sutra-local-simulation",
      "--modules", "cilium,trivy,kyverno,falco",
      "--allow-cni-change",
      "--format", "json",
    ];
    const health = await execute(process.execPath, [
      "scripts/kubernetes-security-stack.mjs", "health", ...common,
    ], { cwd, env });
    const healthEvidence = JSON.parse(health.stdout);
    assert.equal(healthEvidence.schema, "sutra.kubernetes-module-health.v1");
    assert.equal(healthEvidence.overallStatus, "passed");
    assert.ok(healthEvidence.checks.some((item) => item.check === "cilium-datapath-rollout"));
    assert.ok(healthEvidence.checks.some((item) => item.check === "hubble-relay-rollout"));
    assert.ok(healthEvidence.checks.some((item) => item.check === "signing-gateway-rollout"));

    const cleanup = await execute(process.execPath, [
      "scripts/kubernetes-security-stack.mjs", "uninstall", ...common, "--execute",
    ], { cwd, env });
    const cleanupEvidence = JSON.parse(cleanup.stdout);
    assert.equal(cleanupEvidence.schema, "sutra.kubernetes-module-cleanup.v1");
    assert.equal(cleanupEvidence.overallStatus, "passed");
    assert.ok(cleanupEvidence.checks.some((item) => item.check === "aws-vpc-cni-ready"));
    assert.ok(cleanupEvidence.checks.some((item) => item.check === "audit-policies-absent"));
    assert.deepEqual(JSON.parse(await readFile(state, "utf8")), [
      "falco", "kyverno", "trivy-operator", "cilium",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
