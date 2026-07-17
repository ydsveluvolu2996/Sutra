import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cwd = new URL("..", import.meta.url);

async function run(command) {
  const { stdout, stderr } = await execute(process.execPath, [
    "scripts/kubernetes-enterprise-demo.mjs", command,
  ], { cwd });
  assert.equal(stderr, "");
  return { stdout, parsed: JSON.parse(stdout) };
}

test("enterprise demo generation is deterministic, correlated and explicitly simulated", async () => {
  const [first, second] = await Promise.all([run("generate"), run("generate")]);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.parsed.schema, "sutra.kubernetes-enterprise-demo.v1");
  assert.equal(first.parsed.provenance.mode, "deterministic-local-simulation");
  assert.equal(first.parsed.provenance.liveClusterEvidence, false);
  assert.equal(first.parsed.evidence.runtime[0].namespace, first.parsed.subject.namespace);
  assert.equal(first.parsed.evidence.admission.results[0].resources[0].namespace, first.parsed.subject.namespace);
  assert.equal(first.parsed.evidence.network.flows[0].source.workloadName, first.parsed.subject.workload);
  assert.equal(first.parsed.evidence.supplyChain.image.digest, `sha256:${"a".repeat(64)}`);
  assert.doesNotMatch(first.stdout, /must-not-survive|sensitive command line|sensitive raw message/u);
});

test("enterprise demo validation reports every local evidence stream", async () => {
  const { parsed } = await run("validate");
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.simulated, true);
  assert.deepEqual(parsed.evidenceStreams, [
    "trivy-syft-cosign", "kyverno", "hubble", "falco",
  ]);
  assert.equal(parsed.checks, 14);
});
