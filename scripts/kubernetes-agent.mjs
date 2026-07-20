import { readFile } from "node:fs/promises";

import {
  ContinuousKubernetesAgent,
  FileKubernetesAgentStateStore,
  HttpsKubernetesControlChannel,
  HubbleExportFileFlowSource,
  readKubernetesAgentSecretFile,
} from "../services/kubernetes-collector/src/index.ts";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const safeIdentity = (name, value) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
};

const tokenPath = process.env.SUTRA_KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE ??
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const caPath = process.env.SUTRA_KUBERNETES_CA_FILE ??
  "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const bootstrapPath = process.env.SUTRA_KUBERNETES_BOOTSTRAP_FILE ??
  "/var/run/sutra-enrollment/bootstrap";
const statePath = process.env.SUTRA_KUBERNETES_AGENT_STATE_FILE ??
  "/var/lib/sutra-agent/state.json";
const scanIntervalSeconds = Number(process.env.SUTRA_KUBERNETES_SCAN_INTERVAL_SECONDS ?? 900);
if (!Number.isSafeInteger(scanIntervalSeconds)) throw new Error("Kubernetes scan interval is invalid");

const hubbleExportFile = process.env.SUTRA_HUBBLE_EXPORT_FILE?.trim() ?? "";
const hubbleFlowSource = hubbleExportFile === ""
  ? undefined
  : new HubbleExportFileFlowSource({
    path: hubbleExportFile,
    hubbleVersion: safeIdentity("SUTRA_HUBBLE_VERSION", required("SUTRA_HUBBLE_VERSION")),
  });

const falcoGatewayHealthUrl = process.env.SUTRA_FALCO_GATEWAY_HEALTH_URL?.trim() ?? "";

// Set only in DaemonSet mode from the downward API (spec.nodeName). Its presence
// switches the agent to node-scoped enrollment so every pod authenticates under
// the shared enrollment secret and heartbeats as its own node instance.
const nodeName = process.env.SUTRA_KUBERNETES_NODE_NAME?.trim() ?? "";
if (nodeName !== "" && !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(nodeName)) {
  throw new Error("SUTRA_KUBERNETES_NODE_NAME is invalid");
}

const agent = new ContinuousKubernetesAgent({
  clusterId: safeIdentity("SUTRA_KUBERNETES_CLUSTER_ID", required("SUTRA_KUBERNETES_CLUSTER_ID")),
  clusterName: required("SUTRA_KUBERNETES_CLUSTER_NAME"),
  clusterServerUrl: process.env.SUTRA_KUBERNETES_API_URL ?? "https://kubernetes.default.svc",
  agentVersion: process.env.SUTRA_KUBERNETES_AGENT_VERSION ?? "0.1.0-private-beta",
  capabilities: [
    "inventory.v1",
    "posture.v1",
    "trivy-operator.v1alpha1",
    "module-health.v1",
    "durable-idempotency.v1",
    ...(hubbleFlowSource === undefined ? [] : ["hubble-flows.v1"]),
  ],
  scanIntervalMs: scanIntervalSeconds * 1_000,
  stateStore: new FileKubernetesAgentStateStore(statePath),
  controlChannel: new HttpsKubernetesControlChannel(required("SUTRA_CONTROL_PLANE_URL")),
  bootstrapToken: () => readKubernetesAgentSecretFile(bootstrapPath),
  serviceAccountToken: async () => (await readFile(tokenPath, "utf8")).trim(),
  certificateAuthorityPem: await readFile(caPath, "utf8"),
  deployment: {
    namespace: safeIdentity("POD_NAMESPACE", required("POD_NAMESPACE")),
    podName: safeIdentity("POD_NAME", required("POD_NAME")),
    startedAt: new Date().toISOString(),
  },
  ...(hubbleFlowSource === undefined ? {} : { hubbleFlowSource }),
  ...(falcoGatewayHealthUrl === "" ? {} : { falcoGateway: { healthUrl: falcoGatewayHealthUrl } }),
  ...(nodeName === "" ? {} : { nodeName }),
});

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort());
}

process.stdout.write("Sutra Kubernetes agent started; outbound control channel and scheduled scans are active.\n");
await agent.run(controller.signal);
process.stdout.write("Sutra Kubernetes agent stopped.\n");
