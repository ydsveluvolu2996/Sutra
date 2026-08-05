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
  // The script imports .ts modules, so Node prints its own type-stripping ExperimentalWarning on
  // stderr. That is the runtime talking, not the demo, so drop those lines before requiring silence --
  // anything the script itself writes to stderr still fails the run.
  const scriptStderr = stderr
    .split("\n")
    .filter((line) => line !== ""
      && !/^\(node:\d+\) ExperimentalWarning:/u.test(line)
      && !/^\(Use `node --trace-warnings/u.test(line))
    .join("\n");
  assert.equal(scriptStderr, "");
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
