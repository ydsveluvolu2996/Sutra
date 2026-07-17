#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileKubernetesAgentStateStore,
  runKubernetesAgentSoak,
} from "../services/kubernetes-collector/src/index.ts";

function integerOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

const cycles = integerOption("--cycles", 200);
const seed = integerOption("--seed", 20_260_717);

const stateDirectory = await mkdtemp(join(tmpdir(), "sutra-agent-soak-"));
try {
  const report = await runKubernetesAgentSoak({
    cycles,
    seed,
    stateStore: new FileKubernetesAgentStateStore(join(stateDirectory, "state.json")),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    process.stderr.write("Kubernetes agent soak failed one or more invariants.\n");
    process.exitCode = 1;
  }
} finally {
  await rm(stateDirectory, { recursive: true, force: true });
}
