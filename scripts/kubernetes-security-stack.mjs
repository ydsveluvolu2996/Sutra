#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supported = ["cilium", "trivy", "kyverno", "falco"];
const definitions = {
  cilium: {
    release: "cilium",
    namespace: "kube-system",
    chart: "cilium",
    repository: "https://helm.cilium.io",
    version: "1.19.5",
    values: "deploy/kubernetes/security-stack/cilium-aws-vpc-cni-values.yaml",
  },
  trivy: {
    release: "trivy-operator",
    namespace: "sutra-trivy",
    chart: "trivy-operator",
    repository: "https://aquasecurity.github.io/helm-charts",
    version: "0.32.1",
    values: "deploy/kubernetes/security-stack/trivy-values.yaml",
  },
  kyverno: {
    release: "kyverno",
    namespace: "sutra-kyverno",
    chart: "kyverno",
    repository: "https://kyverno.github.io/kyverno",
    version: "3.8.2",
    values: "deploy/kubernetes/security-stack/kyverno-values.yaml",
  },
  falco: {
    release: "falco",
    namespace: "sutra-falco",
    chart: "falco",
    repository: "https://falcosecurity.github.io/charts",
    version: "9.1.0",
    values: "deploy/kubernetes/security-stack/falco-values.yaml",
  },
};

function fail(message) {
  throw new Error(message);
}

function parse(argv) {
  const command = argv[0] ?? "plan";
  if (!new Set(["plan", "preflight", "apply", "health", "uninstall"]).has(command)) {
    fail("Command must be plan, preflight, apply, health, or uninstall");
  }
  const result = {
    command,
    context: "",
    modules: [...supported],
    execute: false,
    allowCniChange: false,
    deleteNamespaces: false,
    format: "text",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--execute") result.execute = true;
    else if (value === "--allow-cni-change") result.allowCniChange = true;
    else if (value === "--delete-namespaces") result.deleteNamespaces = true;
    else if (value === "--format") result.format = argv[++index] ?? "";
    else if (value === "--context") result.context = argv[++index] ?? "";
    else if (value === "--modules") result.modules = (argv[++index] ?? "").split(",").filter(Boolean);
    else fail(`Unknown argument: ${value}`);
  }
  if (
    result.context && !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u.test(result.context)
  ) fail("Kubernetes context is invalid");
  if (
    result.modules.length < 1 ||
    result.modules.some((moduleName) => !supported.includes(moduleName)) ||
    new Set(result.modules).size !== result.modules.length
  ) fail("Modules must be a unique comma-separated subset of cilium,trivy,kyverno,falco");
  if (!new Set(["text", "json"]).has(result.format)) fail("Format must be text or json");
  if (result.modules.includes("cilium") && !result.allowCniChange && command !== "plan") {
    fail("Cilium changes the cluster datapath; review the plan and pass --allow-cni-change");
  }
  if (new Set(["apply", "uninstall"]).has(command) && !result.execute) {
    fail(`${command} is mutating; re-run with --execute after reviewing plan output`);
  }
  return result;
}

function safeCommand(command, args) {
  return [command, ...args].map((value) =>
    /^[A-Za-z0-9_./:@=,+-]+$/u.test(value) ? value : JSON.stringify(value)
  ).join(" ");
}

async function run(command, args, options = {}) {
  if (args.some((value) => /(?:secret|token|password|hmac)[=:][^/]/iu.test(value))) {
    fail("A raw secret-like value was rejected from process arguments");
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(options.env ?? {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.on("error", () => rejectPromise(new Error(`${command} is not installed`)));
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`${command} operation failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`));
    });
  });
}

function kubectlArgs(options, ...args) {
  return [...(options.context ? ["--context", options.context] : []), ...args];
}

function helmArgs(options, ...args) {
  return [...(options.context ? ["--kube-context", options.context] : []), ...args];
}

async function requireFile(path) {
  await access(resolve(root, path), constants.R_OK);
}

async function validateLocalInputs(options) {
  for (const moduleName of options.modules) await requireFile(definitions[moduleName].values);
  if (options.modules.includes("kyverno")) await requireFile("deploy/policies/kyverno/kustomization.yaml");
  if (options.modules.includes("falco")) {
    await requireFile("deploy/kubernetes/security-stack/falco-signing-gateway.contract.yaml");
    const image = process.env.SUTRA_FALCO_GATEWAY_IMAGE?.trim() ?? "";
    if (options.command !== "plan" && !/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/u.test(image)) {
      fail("SUTRA_FALCO_GATEWAY_IMAGE must be an immutable image digest");
    }
  }
}

function plan(options) {
  const lines = [];
  for (const moduleName of options.modules) {
    const item = definitions[moduleName];
    lines.push(safeCommand("helm", helmArgs(
      options, "upgrade", "--install", item.release, item.chart,
      "--repo", item.repository, "--version", item.version,
      "--namespace", item.namespace, "--create-namespace",
      "--values", resolve(root, item.values), "--atomic", "--wait", "--timeout", "10m",
    )));
    if (moduleName === "kyverno") {
      lines.push(safeCommand("kubectl", kubectlArgs(
        options, "apply", "--server-side", "-k", resolve(root, "deploy/policies/kyverno"),
      )));
    }
    if (moduleName === "falco") {
      lines.push("kubectl apply -f <rendered Falco signing-gateway contract; immutable image and existing ConfigMap/Secret references only>");
    }
  }
  return lines;
}

async function preflight(options) {
  await run("kubectl", kubectlArgs(options, "version", "--output=json"));
  await run("helm", ["version", "--short"]);
  const nodes = JSON.parse(await run("kubectl", kubectlArgs(options, "get", "nodes", "-o", "json")));
  if (!Array.isArray(nodes.items) || nodes.items.length < 1) fail("The cluster has no worker nodes");
  const readyNodes = nodes.items.filter((node) =>
    node?.status?.conditions?.some((condition) =>
      condition?.type === "Ready" && condition?.status === "True"
    )
  );
  if (readyNodes.length < 1) fail("The cluster has no ready worker nodes");
  if (options.modules.includes("cilium")) {
    await run("kubectl", kubectlArgs(options, "-n", "kube-system", "get", "daemonset", "aws-node", "-o", "name"));
    const provider = await run("kubectl", kubectlArgs(
      options, "get", "nodes", "-o",
      "jsonpath={.items[0].spec.providerID}",
    ));
    if (!provider.startsWith("aws://")) fail("Cilium AWS VPC CNI chaining is supported only on AWS-backed nodes");
  }
  if (options.modules.includes("falco")) {
    await run("kubectl", kubectlArgs(
      options, "-n", "sutra-falco", "get", "configmap", "sutra-falco-gateway",
      "-o", "jsonpath={.data.controlPlaneUrl}{'\\n'}{.data.clusterId}",
    ));
    await run("kubectl", kubectlArgs(
      options, "-n", "sutra-falco", "get", "secret", "sutra-falco-signing",
      "-o", "jsonpath={.metadata.name}",
    ));
  }
}

async function labelNamespace(options, namespace, privileged = false) {
  if (namespace === "kube-system") return;
  try {
    await run("kubectl", kubectlArgs(options, "get", "namespace", namespace, "-o", "name"));
  } catch {
    await run("kubectl", kubectlArgs(options, "create", "namespace", namespace));
  }
  await run("kubectl", kubectlArgs(
    options, "label", "namespace", namespace,
    "app.kubernetes.io/managed-by=sutra-security-stack",
    `pod-security.kubernetes.io/enforce=${privileged ? "privileged" : "baseline"}`,
    "pod-security.kubernetes.io/audit=restricted",
    "pod-security.kubernetes.io/warn=restricted",
    "--overwrite",
  ));
}

async function applyModule(options, moduleName) {
  const item = definitions[moduleName];
  await labelNamespace(options, item.namespace, moduleName === "falco");
  await run("helm", helmArgs(
    options, "upgrade", "--install", item.release, item.chart,
    "--repo", item.repository, "--version", item.version,
    "--namespace", item.namespace, "--create-namespace",
    "--values", resolve(root, item.values), "--atomic", "--wait", "--timeout", "10m",
  ));
  if (moduleName === "kyverno") {
    await run("kubectl", kubectlArgs(
      options, "apply", "--server-side", "-k", resolve(root, "deploy/policies/kyverno"),
    ));
  }
  if (moduleName === "falco") {
    const source = await readFile(
      resolve(root, "deploy/kubernetes/security-stack/falco-signing-gateway.contract.yaml"),
      "utf8",
    );
    const manifest = source.replace("SET_BY_ORCHESTRATOR", process.env.SUTRA_FALCO_GATEWAY_IMAGE.trim());
    await run("kubectl", kubectlArgs(options, "apply", "--server-side", "-f", "-"), { input: manifest });
  }
}

function validationTime() {
  const configured = process.env.SUTRA_VALIDATION_TIME?.trim();
  if (!configured) return new Date().toISOString();
  const parsed = new Date(configured);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== configured) {
    fail("SUTRA_VALIDATION_TIME must be an exact ISO-8601 timestamp");
  }
  return configured;
}

async function health(options) {
  const checks = [];
  for (const moduleName of options.modules) {
    const item = definitions[moduleName];
    await run("helm", helmArgs(options, "status", item.release, "--namespace", item.namespace));
    await run("kubectl", kubectlArgs(
      options, "-n", item.namespace, "wait", "--for=condition=Ready", "pod",
      "-l", `app.kubernetes.io/instance=${item.release}`, "--timeout=5m",
    ));
    checks.push({ module: moduleName, check: "helm-release", status: "passed" });
    checks.push({ module: moduleName, check: "workload-readiness", status: "passed" });
    if (moduleName === "falco") {
      await run("kubectl", kubectlArgs(
        options, "-n", item.namespace, "rollout", "status",
        "deployment/sutra-falco-signing-gateway", "--timeout=5m",
      ));
      checks.push({ module: moduleName, check: "signing-gateway-rollout", status: "passed" });
    }
    if (moduleName === "cilium") {
      await run("kubectl", kubectlArgs(
        options, "-n", "kube-system", "rollout", "status", "daemonset/cilium", "--timeout=5m",
      ));
      await run("kubectl", kubectlArgs(
        options, "-n", "kube-system", "rollout", "status", "deployment/cilium-operator", "--timeout=5m",
      ));
      await run("kubectl", kubectlArgs(
        options, "-n", "kube-system", "rollout", "status", "deployment/hubble-relay", "--timeout=5m",
      ));
      checks.push({ module: moduleName, check: "cilium-datapath-rollout", status: "passed" });
      checks.push({ module: moduleName, check: "cilium-operator-rollout", status: "passed" });
      checks.push({ module: moduleName, check: "hubble-relay-rollout", status: "passed" });
    }
  }
  return {
    schema: "sutra.kubernetes-module-health.v1",
    generatedAt: validationTime(),
    context: options.context || "current",
    overallStatus: "passed",
    modules: [...options.modules],
    checks,
  };
}

async function assertAwsCniHealthy(options) {
  const raw = await run("kubectl", kubectlArgs(
    options, "-n", "kube-system", "get", "daemonset", "aws-node", "-o", "json",
  ));
  const daemonset = JSON.parse(raw);
  const desired = Number(daemonset?.status?.desiredNumberScheduled ?? 0);
  const ready = Number(daemonset?.status?.numberReady ?? 0);
  const unavailable = Number(daemonset?.status?.numberUnavailable ?? 0);
  if (desired < 1 || ready !== desired || unavailable !== 0) {
    fail("Refusing Cilium cleanup because the AWS VPC CNI aws-node DaemonSet is not fully ready");
  }
}

async function uninstall(options) {
  if (options.modules.includes("cilium")) await assertAwsCniHealthy(options);
  for (const moduleName of [...options.modules].reverse()) {
    const item = definitions[moduleName];
    if (moduleName === "falco") {
      await run("kubectl", kubectlArgs(
        options, "delete", "--ignore-not-found", "-f",
        resolve(root, "deploy/kubernetes/security-stack/falco-signing-gateway.contract.yaml"),
      ));
    }
    if (moduleName === "kyverno") {
      await run("kubectl", kubectlArgs(
        options, "delete", "--ignore-not-found", "-k", resolve(root, "deploy/policies/kyverno"),
      ));
    }
    try {
      await run("helm", helmArgs(
        options, "uninstall", item.release, "--namespace", item.namespace, "--wait", "--timeout", "10m",
      ));
    } catch (error) {
      if (!String(error.message).includes("not found")) throw error;
    }
    if (options.deleteNamespaces && item.namespace !== "kube-system") {
      await run("kubectl", kubectlArgs(
        options, "delete", "namespace", item.namespace, "--ignore-not-found", "--wait=true",
      ));
    }
  }
  if (options.modules.includes("cilium")) {
    await run("kubectl", kubectlArgs(
      options, "-n", "kube-system", "rollout", "status", "daemonset/aws-node", "--timeout=5m",
    ));
  }
}

async function verifyCleanup(options) {
  const checks = [];
  for (const moduleName of options.modules) {
    const item = definitions[moduleName];
    try {
      await run("helm", helmArgs(options, "status", item.release, "--namespace", item.namespace));
      fail(`${moduleName} cleanup is incomplete: Helm release still exists`);
    } catch (error) {
      if (!String(error.message).includes("not found")) throw error;
    }
    checks.push({ module: moduleName, check: "helm-release-absent", status: "passed" });
    if (moduleName === "falco") {
      const result = await run("kubectl", kubectlArgs(
        options, "-n", item.namespace, "get", "deployment",
        "sutra-falco-signing-gateway", "--ignore-not-found", "-o", "name",
      ));
      if (result) fail("Falco cleanup is incomplete: signing gateway still exists");
      checks.push({ module: moduleName, check: "signing-gateway-absent", status: "passed" });
    }
    if (moduleName === "kyverno") {
      for (const policy of [
        "sutra-workload-security-audit",
        "sutra-workload-reliability-audit",
        "sutra-image-supply-chain-audit",
      ]) {
        const result = await run("kubectl", kubectlArgs(
          options, "get", "clusterpolicy", policy, "--ignore-not-found", "-o", "name",
        ));
        if (result) fail(`Kyverno cleanup is incomplete: ${policy} still exists`);
      }
      checks.push({ module: moduleName, check: "audit-policies-absent", status: "passed" });
    }
  }
  if (options.modules.includes("cilium")) {
    await assertAwsCniHealthy(options);
    checks.push({ module: "cilium", check: "aws-vpc-cni-ready", status: "passed" });
  }
  return {
    schema: "sutra.kubernetes-module-cleanup.v1",
    generatedAt: validationTime(),
    context: options.context || "current",
    overallStatus: "passed",
    modules: [...options.modules],
    checks,
  };
}

function outputEvidence(evidence, format, successMessage) {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    process.stdout.write(`${successMessage}\n`);
  }
}

const options = parse(process.argv.slice(2));
await validateLocalInputs(options);
if (options.command === "plan") {
  process.stdout.write([
    "Sutra Kubernetes security stack plan (no changes made)",
    `modules=${options.modules.join(",")}`,
    ...plan(options),
    "Cleanup runs in reverse module order and requires --execute.",
    "",
  ].join("\n"));
} else if (options.command === "preflight") {
  await preflight(options);
  process.stdout.write("Preflight passed; no cluster changes were made.\n");
} else if (options.command === "apply") {
  await preflight(options);
  for (const moduleName of options.modules) await applyModule(options, moduleName);
  const evidence = await health(options);
  outputEvidence(evidence, options.format, "Selected Kubernetes security modules are installed and healthy.");
} else if (options.command === "health") {
  const evidence = await health(options);
  outputEvidence(evidence, options.format, "Selected Kubernetes security modules are healthy.");
} else {
  await uninstall(options);
  const evidence = await verifyCleanup(options);
  outputEvidence(
    evidence,
    options.format,
    "Selected Kubernetes security modules were removed and cleanup was verified in reverse order.",
  );
}
