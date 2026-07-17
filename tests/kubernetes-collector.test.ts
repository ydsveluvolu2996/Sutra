import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  KubernetesConnectionError,
  ReadOnlyKubernetesCollector,
  resolveTrustedKubernetesConnection,
  toKubernetesEvidenceSnapshot,
  type KubernetesTransport,
  type TrustedKubernetesConnection,
} from "../services/kubernetes-collector/src/index.ts";

const TOKEN = "server-side-bearer-token-never-returned";

function connection(overrides: Partial<TrustedKubernetesConnection> = {}): TrustedKubernetesConnection {
  return {
    trust: "server-side",
    clusterId: "cluster_demo_1",
    clusterName: "Demo cluster",
    serverUrl: "https://kubernetes.example.test:6443",
    auth: { kind: "bearer", token: TOKEN },
    ...overrides,
  } as TrustedKubernetesConnection;
}

test("accepts HTTPS and exact loopback HTTP but rejects unsafe API URLs", () => {
  assert.equal(resolveTrustedKubernetesConnection(connection()).server.protocol, "https:");
  assert.equal(resolveTrustedKubernetesConnection(connection({ serverUrl: "http://127.0.0.1:7443" })).server.protocol, "http:");
  for (const serverUrl of [
    "http://kubernetes.example.test",
    "http://127.0.0.1.example.test",
    "https://user:password@kubernetes.example.test",
    "https://kubernetes.example.test/untrusted-prefix",
  ]) {
    assert.throws(() => resolveTrustedKubernetesConnection(connection({ serverUrl })), KubernetesConnectionError);
  }
});

test("resolves a strict token kubeconfig and rejects executable authentication", () => {
  const document = {
    "current-context": "sutra",
    clusters: [{ name: "cluster", cluster: { server: "https://kubernetes.example.test" } }],
    contexts: [{ name: "sutra", context: { cluster: "cluster", user: "reader" } }],
    users: [{ name: "reader", user: { token: TOKEN } }],
  };
  const resolved = resolveTrustedKubernetesConnection(connection({
    serverUrl: undefined,
    auth: { kind: "kubeconfig", document },
  }));
  assert.equal(resolved.token, TOKEN);
  assert.throws(() => resolveTrustedKubernetesConnection(connection({
    serverUrl: undefined,
    auth: {
      kind: "kubeconfig",
      document: { ...document, users: [{ name: "reader", user: { exec: { command: "steal-credentials" } } }] },
    },
  })), /exec, auth-provider, files, and client credentials are rejected/u);
});

test("collects only normalized metadata and never returns credentials, annotations, Secret data, or pod env", async () => {
  const requestedPaths: string[] = [];
  const transport: KubernetesTransport = async ({ url, token }) => {
    assert.equal(token, TOKEN);
    requestedPaths.push(url.pathname);
    if (url.pathname === "/api/v1/namespaces") {
      return {
        metadata: {},
        items: [{
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: "production",
            uid: "namespace-uid",
            labels: { environment: "production" },
            annotations: { "private.example/token": "annotation-secret" },
            resourceVersion: "12",
          },
          status: { phase: "Active" },
          data: { password: "secret-payload" },
        }],
      };
    }
    if (url.pathname === "/apis/apps/v1/deployments") {
      return {
        metadata: {},
        items: [{
          apiVersion: "apps/v1",
          metadata: { name: "api", namespace: "production", uid: "deployment-uid" },
          spec: {
            replicas: 3,
            template: { spec: {
              hostPID: true,
              volumes: [{ name: "host", hostPath: { path: "/" } }],
              containers: [{
                name: "api",
                image: "registry.example.test/api:latest",
                securityContext: { privileged: true, allowPrivilegeEscalation: true },
                env: [{ name: "PASSWORD", value: "pod-env-secret" }],
              }],
            } },
          },
          status: { readyReplicas: 2, availableReplicas: 2 },
        }],
      };
    }
    return { metadata: {}, items: [] };
  };
  const snapshot = await new ReadOnlyKubernetesCollector(connection(), transport).collect(
    new Date("2026-07-17T12:00:00.000Z"),
  );
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.resources.length, 3);
  assert.equal(snapshot.coverage.every((entry) => entry.status === "succeeded"), true);
  assert.equal(requestedPaths.some((path) => /secret/iu.test(path)), false);
  for (const forbidden of [TOKEN, "annotation-secret", "secret-payload", "pod-env-secret", "PASSWORD"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const deployment = snapshot.resources.find((resource) => resource.kind === "deployment");
  assert.equal(deployment?.configuration.desiredReplicas, 3);
  assert.equal(deployment?.configuration.hostPid, true);
  assert.equal(deployment?.configuration.hasHostPath, true);
  assert.equal(Array.isArray(deployment?.configuration.containers), true);
  const evidence = toKubernetesEvidenceSnapshot(snapshot);
  const workload = evidence.resources.find((resource) => resource.kind === "Workload");
  assert.equal(workload?.kind === "Workload" && workload.hostPid, true);
  assert.equal(workload?.kind === "Workload" && workload.containers[0]?.privileged, true);
});

test("sanitizes transport failures and never reflects provider error text", async () => {
  const transport: KubernetesTransport = async () => {
    throw new Error(`provider rejected credential ${TOKEN}`);
  };
  const snapshot = await new ReadOnlyKubernetesCollector(connection(), transport).collect();
  assert.equal(snapshot.coverage.every((entry) => entry.status === "failed"), true);
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  assert.equal(snapshot.coverage[0]?.errorCode, "API_REQUEST_FAILED");
  assert.equal(snapshot.coverage[0]?.message, "Kubernetes could not complete a metadata request");
});

test("default transport performs authenticated read-only loopback API requests", async (context) => {
  const requests: { readonly method: string | undefined; readonly url: string | undefined }[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ metadata: {}, items: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const snapshot = await new ReadOnlyKubernetesCollector(connection({
    serverUrl: `http://127.0.0.1:${address.port}`,
  })).collect();
  assert.equal(snapshot.coverage.every((entry) => entry.status === "succeeded"), true);
  assert.equal(requests.length, 13);
  assert.equal(requests.every((request) => request.method === "GET" && request.url?.includes("limit=500")), true);
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
});
