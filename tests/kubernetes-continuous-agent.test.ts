import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ContinuousKubernetesAgent,
  emptyKubernetesAgentState,
  FileKubernetesAgentStateStore,
  HttpFalcoGatewayHealthProbe,
  HttpsKubernetesControlChannel,
  KubernetesDiscoveryModuleHealthProbe,
  mergeKubernetesModuleHealth,
  resolveKubernetesControlPlaneUrl,
  retryDelayMs,
  type KubernetesAgentHeartbeat,
  type KubernetesAgentState,
  type KubernetesAgentStateStore,
  type KubernetesControlChannel,
  type KubernetesModuleHealth,
  type RotatingAgentCredential,
} from "../services/kubernetes-collector/src/index.ts";

const bootstrap = `bootstrap_${"b".repeat(48)}`;
const kubeToken = "kube-service-account-token-never-persist";
const credential = (suffix = "a"): RotatingAgentCredential => ({
  agentId: "agent_cluster_demo",
  token: suffix.repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
});
const healthyModules: KubernetesModuleHealth = {
  trivy: "NOT_CONFIGURED",
  kyverno: "NOT_CONFIGURED",
  falco: "NOT_CONFIGURED",
  cilium: "NOT_CONFIGURED",
};

class MemoryState implements KubernetesAgentStateStore {
  public state: KubernetesAgentState = emptyKubernetesAgentState();
  public async load() { return structuredClone(this.state); }
  public async save(state: KubernetesAgentState) { this.state = structuredClone(state); }
}

class MemoryChannel implements KubernetesControlChannel {
  public readonly uploads: { key: string; payload: unknown }[] = [];
  public readonly hubbleUploads: unknown[] = [];
  public readonly heartbeats: KubernetesAgentHeartbeat[] = [];
  public enrollments = 0;
  public rotations = 0;
  public failNextUpload = false;

  public async enroll(value: string) {
    assert.equal(value, bootstrap);
    this.enrollments += 1;
    return credential();
  }
  public async rotate() {
    this.rotations += 1;
    return credential("r");
  }
  public async heartbeat(_credential: RotatingAgentCredential, heartbeat: KubernetesAgentHeartbeat) {
    this.heartbeats.push(heartbeat);
  }
  public async uploadScan(_credential: RotatingAgentCredential, key: string, payload: unknown) {
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw new Error("simulated outage");
    }
    this.uploads.push({ key, payload });
  }
  public async uploadHubbleFlows(_credential: RotatingAgentCredential, payload: unknown) {
    this.hubbleUploads.push(payload);
  }
}

async function withKubernetesApi(run: (url: string) => Promise<void>) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ metadata: {}, items: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

function agent(
  url: string,
  stateStore: KubernetesAgentStateStore,
  controlChannel: KubernetesControlChannel,
  now = Date.parse("2026-07-17T12:00:00.000Z"),
) {
  return new ContinuousKubernetesAgent({
    clusterId: "cluster_demo",
    clusterName: "Demo",
    clusterServerUrl: url,
    agentVersion: "0.2.0-test",
    capabilities: ["inventory.v1", "posture.v1"],
    scanIntervalMs: 5 * 60_000,
    stateStore,
    controlChannel,
    bootstrapToken: async () => bootstrap,
    serviceAccountToken: async () => kubeToken,
    deployment: {
      namespace: "sutra-system",
      podName: "sutra-agent-test",
      startedAt: "2026-07-17T11:00:00.000Z",
    },
    moduleHealthProbe: { async inspect() { return healthyModules; } },
    now: () => now,
  });
}

test("enrolls outbound, reports health and uploads a normalized scheduled scan without kube credentials", async () => {
  await withKubernetesApi(async (url) => {
    const state = new MemoryState();
    const channel = new MemoryChannel();
    await agent(url, state, channel).runCycle();
    assert.equal(channel.enrollments, 1);
    assert.equal(channel.rotations, 0);
    assert.equal(channel.uploads.length, 1);
    assert.equal(channel.heartbeats.length, 2);
    assert.equal(channel.heartbeats[0]?.agentVersion, "0.2.0-test");
    assert.deepEqual(channel.heartbeats[0]?.modules, healthyModules);
    assert.equal(state.state.sequence, 1);
    assert.equal(state.state.pendingUpload, null);
    assert.equal(state.state.lastSuccessfulScanAt, "2026-07-17T12:00:00.000Z");
    const serializedState = JSON.stringify(state.state);
    const serializedUpload = JSON.stringify(channel.uploads[0]);
    assert.equal(serializedState.includes(kubeToken), false);
    assert.equal(serializedState.includes(bootstrap), false);
    assert.equal(serializedUpload.includes(kubeToken), false);
    assert.equal(serializedUpload.includes(bootstrap), false);
    assert.match(serializedUpload, /"secretsCollected":false/u);
    assert.match(serializedUpload, /"configMapValuesCollected":false/u);
  });
});

test("persists an upload before delivery and retries the exact idempotency key after restart", async () => {
  await withKubernetesApi(async (url) => {
    const state = new MemoryState();
    const firstChannel = new MemoryChannel();
    firstChannel.failNextUpload = true;
    await assert.rejects(agent(url, state, firstChannel).runCycle(), /simulated outage/u);
    assert.equal(state.state.sequence, 1);
    assert.ok(state.state.pendingUpload);
    const pendingKey = state.state.pendingUpload?.idempotencyKey;

    const recoveredChannel = new MemoryChannel();
    await agent(url, state, recoveredChannel, Date.parse("2026-07-17T12:05:00.000Z")).runCycle();
    assert.equal(recoveredChannel.enrollments, 0);
    assert.equal(recoveredChannel.uploads[0]?.key, pendingKey);
    assert.equal(recoveredChannel.uploads[1]?.key, "scan_00000000000000000002");
    assert.equal(state.state.pendingUpload, null);
    assert.equal(state.state.sequence, 2);
  });
});

test("rotates an expiring agent credential but never rotates the Kubernetes service-account token", async () => {
  await withKubernetesApi(async (url) => {
    const state = new MemoryState();
    state.state = {
      ...state.state,
      credential: {
        ...credential(),
        expiresAt: "2026-07-17T12:05:00.000Z",
      },
    };
    const channel = new MemoryChannel();
    await agent(url, state, channel).runCycle();
    assert.equal(channel.enrollments, 0);
    assert.equal(channel.rotations, 1);
    assert.equal(state.state.credential?.token, "r".repeat(64));
    assert.equal(JSON.stringify(state.state).includes(kubeToken), false);
  });
});

test("file state is atomically permission-restricted and bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-kubernetes-agent-"));
  await chmod(directory, 0o700);
  const path = join(directory, "state.json");
  const store = new FileKubernetesAgentStateStore(path);
  const value = { ...emptyKubernetesAgentState(), credential: credential() };
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).includes(kubeToken), false);
});

test("control channel requires an HTTPS origin, bounded requests and no redirects", async () => {
  for (const value of [
    "http://sutra.example.com",
    "https://user:password@sutra.example.com",
    "https://sutra.example.com/path",
    "https://sutra.example.com?token=value",
  ]) assert.throws(() => resolveKubernetesControlPlaneUrl(value));

  const requests: { url: string; init?: RequestInit }[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json(credential());
  };
  const channel = new HttpsKubernetesControlChannel("https://sutra.example.com", request);
  await channel.enroll(bootstrap, {
    clusterId: "cluster_demo",
    clusterName: "Demo",
    agentVersion: "0.2.0",
    capabilities: ["inventory.v1"],
  });
  assert.equal(requests[0]?.url, "https://sutra.example.com/v1/kubernetes/agents/enroll");
  assert.equal(requests[0]?.init?.redirect, "error");
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), `Sutra-Bootstrap ${bootstrap}`);
  await assert.rejects(
    channel.uploadScan(credential(), "scan_too_large", { data: "x".repeat(10 * 1024 * 1024) }),
    /exceeded its safe limit/u,
  );
  assert.equal(requests.length, 1);
});

test("uploads aggregated hubble flow evidence after the scan when a flow source is configured", async () => {
  await withKubernetesApi(async (url) => {
    const state = new MemoryState();
    const channel = new MemoryChannel();
    const flow = {
      observedAt: "2026-07-17T11:59:00.000Z",
      source: { namespace: "payments", workloadKind: "Deployment", workloadName: "frontend", serviceName: null, world: false },
      destination: { namespace: null, workloadKind: null, workloadName: null, serviceName: null, world: true },
      direction: "egress" as const,
      verdict: "forwarded" as const,
      protocol: "TCP" as const,
      destinationPort: 443,
      observations: 3,
    };
    const instance = new ContinuousKubernetesAgent({
      clusterId: "cluster_demo",
      clusterName: "Demo",
      clusterServerUrl: url,
      agentVersion: "0.2.0-test",
      capabilities: ["inventory.v1", "hubble-flows.v1"],
      scanIntervalMs: 5 * 60_000,
      stateStore: state,
      controlChannel: channel,
      bootstrapToken: async () => bootstrap,
      serviceAccountToken: async () => kubeToken,
      deployment: { namespace: "sutra-system", podName: "sutra-agent-test", startedAt: "2026-07-17T11:00:00.000Z" },
      moduleHealthProbe: { async inspect() { return healthyModules; } },
      hubbleFlowSource: {
        async collect() {
          return { hubbleVersion: "1.19.5", flows: [flow], linesRead: 1, flowsSkipped: 0 };
        },
      },
      now: () => Date.parse("2026-07-17T12:00:00.000Z"),
    });
    await instance.runCycle();
    assert.equal(channel.hubbleUploads.length, 1);
    assert.deepEqual(channel.hubbleUploads[0], {
      schema: "sutra.hubble-agent-upload.v1",
      collectedAt: "2026-07-17T12:00:00.000Z",
      hubbleVersion: "1.19.5",
      flows: [flow],
    });
  });
});

test("a not-configured or empty flow source performs no hubble upload", async () => {
  await withKubernetesApi(async (url) => {
    for (const collection of [null, { hubbleVersion: "1.19.5", flows: [], linesRead: 0, flowsSkipped: 0 }]) {
      const state = new MemoryState();
      const channel = new MemoryChannel();
      const instance = new ContinuousKubernetesAgent({
        clusterId: "cluster_demo",
        clusterName: "Demo",
        clusterServerUrl: url,
        agentVersion: "0.2.0-test",
        capabilities: ["inventory.v1"],
        scanIntervalMs: 5 * 60_000,
        stateStore: state,
        controlChannel: channel,
        bootstrapToken: async () => bootstrap,
        serviceAccountToken: async () => kubeToken,
        deployment: { namespace: "sutra-system", podName: "sutra-agent-test", startedAt: "2026-07-17T11:00:00.000Z" },
        moduleHealthProbe: { async inspect() { return healthyModules; } },
        hubbleFlowSource: { async collect() { return collection; } },
        now: () => Date.parse("2026-07-17T12:00:00.000Z"),
      });
      await instance.runCycle();
      assert.equal(channel.hubbleUploads.length, 0);
      assert.equal(channel.uploads.length, 1, "the scan upload must still happen");
    }
  });
});

test("heartbeats report falco signing-gateway liveness when a health URL is configured", async () => {
  await withKubernetesApi(async (url) => {
    const state = new MemoryState();
    const channel = new MemoryChannel();
    const probed: string[] = [];
    const instance = new ContinuousKubernetesAgent({
      clusterId: "cluster_demo",
      clusterName: "Demo",
      clusterServerUrl: url,
      agentVersion: "0.2.0-test",
      capabilities: ["inventory.v1"],
      scanIntervalMs: 5 * 60_000,
      stateStore: state,
      controlChannel: channel,
      bootstrapToken: async () => bootstrap,
      serviceAccountToken: async () => kubeToken,
      deployment: { namespace: "sutra-system", podName: "sutra-agent-test", startedAt: "2026-07-17T11:00:00.000Z" },
      moduleHealthProbe: { async inspect() { return healthyModules; } },
      falcoGateway: {
        healthUrl: "http://sutra-falco-gateway.sutra-falco.svc:8080",
        probe: {
          async inspect(input) {
            probed.push(input.url.href);
            return "AVAILABLE";
          },
        },
      },
      now: () => Date.parse("2026-07-17T12:00:00.000Z"),
    });
    await instance.runCycle();
    assert.equal(probed.length, 1);
    assert.equal(channel.heartbeats.length, 2);
    for (const heartbeat of channel.heartbeats) {
      assert.equal(heartbeat.modules["falco-gateway"], "AVAILABLE");
    }
    assert.throws(() => new ContinuousKubernetesAgent({
      clusterId: "cluster_demo",
      clusterName: "Demo",
      clusterServerUrl: url,
      agentVersion: "0.2.0-test",
      capabilities: ["inventory.v1"],
      scanIntervalMs: 5 * 60_000,
      stateStore: state,
      controlChannel: channel,
      bootstrapToken: async () => bootstrap,
      serviceAccountToken: async () => kubeToken,
      deployment: { namespace: "sutra-system", podName: "sutra-agent-test", startedAt: "2026-07-17T11:00:00.000Z" },
      falcoGateway: { healthUrl: "http://user:secret@gateway.example/readyz?x=1" },
    }), /Falco gateway health URL is invalid/u);
  });
});

test("falco gateway probe maps readiness statuses without sending credentials", async () => {
  const seen: { url: string; headers: boolean }[] = [];
  const probeWith = (status: number | Error) => new HttpFalcoGatewayHealthProbe(async (input) => {
    seen.push({ url: input.url.href, headers: false });
    if (status instanceof Error) throw status;
    return status;
  });
  const url = new URL("http://sutra-falco-gateway.sutra-falco.svc:8080");
  const signal = AbortSignal.timeout(1_000);
  assert.equal(await probeWith(200).inspect({ url, signal }), "AVAILABLE");
  assert.equal(await probeWith(503).inspect({ url, signal }), "DEGRADED");
  assert.equal(await probeWith(404).inspect({ url, signal }), "DEGRADED");
  assert.equal(await probeWith(new Error("unreachable")).inspect({ url, signal }), "UNKNOWN");
  assert.ok(seen.every((entry) => entry.url.endsWith("/readyz")));
});

test("retry backoff is bounded and jittered", () => {
  assert.equal(retryDelayMs(1, () => 0), 3_750);
  assert.equal(retryDelayMs(2, () => 1), 10_000);
  assert.equal(retryDelayMs(100, () => 1), 300_000);
});

test("module discovery reports real API availability without reading module objects or events", async () => {
  const paths: string[] = [];
  const probe = new KubernetesDiscoveryModuleHealthProbe(async (input) => {
    paths.push(input.url.pathname);
    assert.equal(input.bearerToken, kubeToken);
    assert.equal(input.certificateAuthorityPem, "test-ca");
    if (input.url.pathname.includes("aquasecurity")) return 200;
    if (input.url.pathname.includes("kyverno")) return 404;
    if (input.url.pathname.includes("falcosecurity")) return 403;
    return 500;
  });
  const modules = await probe.inspect({
    server: new URL("https://kubernetes.example.test"),
    bearerToken: kubeToken,
    certificateAuthorityPem: "test-ca",
    signal: AbortSignal.timeout(1_000),
  });
  assert.deepEqual(modules, {
    trivy: "AVAILABLE",
    kyverno: "NOT_CONFIGURED",
    falco: "DEGRADED",
    cilium: "UNKNOWN",
  });
  assert.equal(paths.length, 4);
  assert.ok(paths.every((path) => /^\/apis\/[^/]+\/[^/]+$/u.test(path)));

  const merged = mergeKubernetesModuleHealth(modules, {
    schemaVersion: "sutra.kubernetes.inventory.v1",
    clusterId: "cluster_demo",
    clusterName: "Demo",
    collectedAt: "2026-07-17T12:00:00.000Z",
    resources: [],
    coverage: [{
      collectorKey: "trivy-operator.vulnerabilityreports",
      apiPath: "/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports",
      status: "failed",
      itemsObserved: 0,
      pagesObserved: 0,
      errorCode: "AUTHORIZATION_FAILED",
    }],
    trivyFindings: [],
    trivySboms: [],
  });
  assert.equal(merged.trivy, "DEGRADED");
});
