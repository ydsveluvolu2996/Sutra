import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ReadOnlyKubernetesCollector,
  toKubernetesEvidenceSnapshot,
} from "../services/kubernetes-collector/src/index.ts";
import { evaluateKubernetesPosture } from "../lib/kubernetes-posture.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_COMMAND_BYTES = 512 * 1024;

function usage() {
  return `Usage:
  pnpm kubernetes:scan -- --context <kubectl-context> [options]

Options:
  --cluster-id <id>       Stable Sutra cluster identifier (defaults to context)
  --cluster-name <name>   Display name (defaults to context)
  --out <path>            Credential-free JSON artifact path
  --help                  Show this help

Prerequisite:
  kubectl apply -f infrastructure/kubernetes-readonly.yaml

The command uses your existing kubectl login only to mint a 10-minute token for
the sutra-readonly service account. The token and kubeconfig are never written
to the artifact or printed.`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (!new Set(["--context", "--cluster-id", "--cluster-name", "--out"]).has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  const context = values.get("--context");
  if (!context || !ID.test(context)) throw new Error("--context is required and must be a safe identifier");
  const clusterId = values.get("--cluster-id") ?? context;
  if (!ID.test(clusterId)) throw new Error("--cluster-id must be a safe identifier");
  const clusterName = values.get("--cluster-name") ?? context;
  if (
    clusterName.length === 0 || clusterName.length > 180 ||
    /[\u0000-\u001f\u007f]/u.test(clusterName)
  ) throw new Error("--cluster-name is invalid");
  const out = values.get("--out") ??
    resolve(".sutra", "kubernetes", `${clusterId}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  return { help: false, context, clusterId, clusterName, out: resolve(out) };
}

function runKubectl(args, { sensitive = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("kubectl output exceeded the safe limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => reject(new Error("kubectl could not be started")));
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0) return resolvePromise(output);
      const detail = sensitive
        ? "kubectl could not create the short-lived collector token"
        : Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
      reject(new Error(detail || "kubectl command failed"));
    });
  });
}

function selectedCluster(document) {
  if (!Array.isArray(document.contexts) || !Array.isArray(document.clusters)) {
    throw new Error("kubectl returned an invalid context document");
  }
  const contextName = document["current-context"];
  const selectedContext = document.contexts.find((entry) => entry?.name === contextName);
  const clusterName = selectedContext?.context?.cluster;
  const selected = document.clusters.find((entry) => entry?.name === clusterName)?.cluster;
  if (typeof selected?.server !== "string") throw new Error("kubectl context has no API server");
  let certificateAuthorityPem;
  if (typeof selected["certificate-authority-data"] === "string") {
    certificateAuthorityPem = Buffer.from(selected["certificate-authority-data"], "base64").toString("utf8");
  }
  if (selected["insecure-skip-tls-verify"] === true || selected["certificate-authority"]) {
    throw new Error("The selected context must use embedded CA data; insecure TLS and CA file paths are rejected");
  }
  return { serverUrl: selected.server, certificateAuthorityPem };
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const contextJson = await runKubectl([
    "config", "view", "--raw", "--minify", "-o", "json", `--context=${options.context}`,
  ]);
  const cluster = selectedCluster(JSON.parse(contextJson));
  const token = await runKubectl([
    "--context", options.context,
    "-n", "sutra-system",
    "create", "token", "sutra-readonly",
    "--duration=10m",
  ], { sensitive: true });
  const snapshot = await new ReadOnlyKubernetesCollector({
    trust: "server-side",
    clusterId: options.clusterId,
    clusterName: options.clusterName,
    serverUrl: cluster.serverUrl,
    auth: {
      kind: "bearer",
      token,
      certificateAuthorityPem: cluster.certificateAuthorityPem,
    },
  }).collect();
  const posture = evaluateKubernetesPosture(toKubernetesEvidenceSnapshot(snapshot));
  const vulnerabilityCoverage = snapshot.coverage.find((entry) =>
    entry.collectorKey === "trivy-operator.vulnerabilityreports");
  const imageVulnerabilities = snapshot.trivyFindings.some((finding) =>
    finding.source === "vulnerability_report")
    ? "TRIVY_REPORTS_IMPORTED"
    : vulnerabilityCoverage?.status === "succeeded"
      ? "TRIVY_REPORT_API_OBSERVED_EMPTY"
      : "NOT_CONFIGURED";
  const artifact = {
    schemaVersion: "sutra.kubernetes.scan-artifact.v1",
    generatedAt: new Date().toISOString(),
    snapshot,
    posture,
    limitations: {
      secretsCollected: false,
      imageVulnerabilities,
      runtimeDetection: "NOT_CONFIGURED",
      admissionControl: "NOT_CONFIGURED",
    },
  };
  await writePrivateJson(options.out, artifact);
  const succeeded = snapshot.coverage.filter((entry) => entry.status === "succeeded").length;
  const failed = snapshot.coverage.length - succeeded;
  process.stdout.write(
    `Kubernetes scan complete: ${snapshot.resources.length} resources, ` +
    `${posture.summary.FAIL} failed controls, ${posture.summary.UNKNOWN} unknown controls, ` +
    `${succeeded} collectors succeeded, ${failed} failed.\nArtifact: ${options.out}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Kubernetes scan failed"}\n`);
  process.exitCode = 1;
});
