import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  KubernetesConnectionError,
  KubernetesCollectorError,
  ReadOnlyKubernetesCollector,
  resolveTrustedKubernetesConnection,
  toKubernetesEvidenceSnapshot,
  normalizeTrivyOperatorReport,
  trivyOperatorReports,
  TRIVY_OPERATOR_CONTRACT,
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
  assert.equal(requests.length, 18);
  assert.equal(requests.every((request) => request.method === "GET" && request.url?.includes("limit=")), true);
  assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
});

test("normalizes the official VulnerabilityReport v1alpha1 contract with stable CVE evidence", () => {
  assert.equal(TRIVY_OPERATOR_CONTRACT.apiVersion, "aquasecurity.github.io/v1alpha1");
  const definition = trivyOperatorReports.find((item) => item.kind === "VulnerabilityReport");
  assert.ok(definition);
  const report = {
    apiVersion: "aquasecurity.github.io/v1alpha1",
    kind: "VulnerabilityReport",
    metadata: {
      name: "replicaset-api-api",
      namespace: "production",
      uid: "report-uid-vulnerability",
      resourceVersion: "101",
      ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "api-7d9", uid: "owner", controller: true }],
    },
    report: {
      updateTimestamp: "2026-07-17T12:00:00Z",
      scanner: { name: "Trivy", vendor: "Aqua Security", version: "0.69.3" },
      artifact: { repository: "registry.example.test/api", tag: "1.0.0" },
      summary: { criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0, unknownCount: 0 },
      vulnerabilities: [{
        vulnerabilityID: "CVE-2026-1234",
        resource: "openssl",
        installedVersion: "3.0.1",
        fixedVersion: "3.0.2",
        publishedDate: "2026-01-01T00:00:00Z",
        lastModifiedDate: "2026-02-01T00:00:00Z",
        severity: "CRITICAL",
        title: "OpenSSL issue",
        description: "raw scanner description is intentionally excluded",
        packageType: "debian",
        target: "container-layer",
        score: 9.8,
      }],
    },
  };
  const first = normalizeTrivyOperatorReport(definition, report, "cluster_demo_1");
  const recreated = structuredClone(report);
  recreated.metadata.uid = "recreated-report-uid";
  recreated.report.vulnerabilities[0]!.installedVersion = "3.0.1-r1";
  recreated.report.vulnerabilities[0]!.fixedVersion = "3.0.2-r1";
  const second = normalizeTrivyOperatorReport(definition, recreated, "cluster_demo_1");
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0]?.fingerprint, second.findings[0]?.fingerprint);
  assert.equal(first.findings[0]?.cveId, "CVE-2026-1234");
  assert.equal(first.findings[0]?.packageName, "openssl");
  assert.equal(first.findings[0]?.fixedVersion, "3.0.2");
  assert.equal(first.findings[0]?.scanner.name, "Trivy");
  assert.equal(JSON.stringify(first).includes("raw scanner description"), false);
});

test("imports only failed official audit checks and bounded SBOM component fields", () => {
  const configDefinition = trivyOperatorReports.find((item) => item.kind === "ConfigAuditReport");
  const sbomDefinition = trivyOperatorReports.find((item) => item.kind === "SbomReport");
  assert.ok(configDefinition && sbomDefinition);
  const commonMetadata = { name: "deployment-api", namespace: "production", uid: "report-uid", resourceVersion: "12" };
  const scanner = { name: "Trivy", vendor: "Aqua Security", version: "0.69.3" };
  const audit = normalizeTrivyOperatorReport(configDefinition, {
    apiVersion: "aquasecurity.github.io/v1alpha1",
    kind: "ConfigAuditReport",
    metadata: commonMetadata,
    report: {
      scanner,
      summary: { criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0 },
      checks: [
        { checkID: "KSV001", title: "Failed check", severity: "CRITICAL", success: false, remediation: "Set the safe field", messages: ["raw report message"] },
        { checkID: "KSV002", title: "Passing check", severity: "LOW", success: true, messages: ["raw passing output"] },
      ],
    },
  }, "cluster_demo_1");
  assert.equal(audit.findings.length, 1);
  assert.equal(audit.findings[0]?.checkId, "KSV001");
  assert.equal(JSON.stringify(audit).includes("raw report message"), false);

  const sbom = normalizeTrivyOperatorReport(sbomDefinition, {
    apiVersion: "aquasecurity.github.io/v1alpha1",
    kind: "SbomReport",
    metadata: { ...commonMetadata, uid: "sbom-uid" },
    report: {
      updateTimestamp: "2026-07-17T12:00:00Z",
      scanner,
      artifact: { repository: "registry.example.test/api", digest: "sha256:abc", tag: "1.0.0" },
      summary: { componentsCount: 1, dependenciesCount: 0 },
      components: {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        components: [{
          "bom-ref": "sensitive-internal-ref",
          type: "library",
          name: "openssl",
          version: "3.0.1",
          purl: "pkg:deb/openssl@3.0.1",
          hashes: [{ alg: "SHA-256", content: "raw-hash" }],
          properties: [{ name: "raw", value: "raw-property" }],
        }],
      },
    },
  }, "cluster_demo_1");
  assert.equal(sbom.sboms[0]?.components[0]?.packageUrl, "pkg:deb/openssl@3.0.1");
  for (const excluded of ["sensitive-internal-ref", "raw-hash", "raw-property"]) {
    assert.equal(JSON.stringify(sbom).includes(excluded), false);
  }
});

test("normalizes namespaced and cluster-scoped RBAC assessment report contracts", () => {
  const scanner = { name: "Trivy", vendor: "Aqua Security", version: "0.69.3" };
  for (const [kind, namespace, expectedSource] of [
    ["RbacAssessmentReport", "kube-system", "rbac_assessment_report"],
    ["ClusterRbacAssessmentReport", undefined, "cluster_rbac_assessment_report"],
  ] as const) {
    const definition = trivyOperatorReports.find((item) => item.kind === kind);
    assert.ok(definition);
    const normalized = normalizeTrivyOperatorReport(definition, {
      apiVersion: "aquasecurity.github.io/v1alpha1",
      kind,
      metadata: {
        name: `${kind.toLocaleLowerCase("en-US")}-admin`,
        ...(namespace === undefined ? {} : { namespace }),
        uid: `${kind}-uid`,
        ownerReferences: [{ apiVersion: "rbac.authorization.k8s.io/v1", kind: kind.startsWith("Cluster") ? "ClusterRole" : "Role", name: "admin", uid: "owner", controller: true }],
      },
      report: {
        scanner,
        summary: { criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0 },
        checks: [{ checkID: "KSV041", title: "Do not manage secrets", severity: "CRITICAL", success: false, messages: ["raw RBAC detail"] }],
      },
    }, "cluster_demo_1");
    assert.equal(normalized.findings[0]?.source, expectedSource);
    assert.equal(normalized.findings[0]?.namespace, namespace ?? null);
    assert.equal(normalized.findings[0]?.affectedResource.name, "admin");
    assert.equal(JSON.stringify(normalized).includes("raw RBAC detail"), false);
  }
});

test("reports absent Trivy CRDs as NOT_CONFIGURED and never as clean", async () => {
  const transport: KubernetesTransport = async ({ url }) => {
    if (url.pathname.startsWith("/apis/aquasecurity.github.io/")) {
      throw new KubernetesCollectorError("API_UNAVAILABLE", "provider body must not survive");
    }
    return { metadata: {}, items: [] };
  };
  const snapshot = await new ReadOnlyKubernetesCollector(connection(), transport).collect();
  const trivyCoverage = snapshot.coverage.filter((entry) => entry.collectorKey.startsWith("trivy-operator."));
  assert.equal(trivyCoverage.length, 5);
  assert.equal(trivyCoverage.every((entry) => entry.status === "not_configured" && entry.errorCode === "NOT_CONFIGURED"), true);
  assert.equal(JSON.stringify(trivyCoverage).includes("provider body"), false);
  assert.equal(snapshot.trivyFindings.length, 0);
  assert.equal(snapshot.trivySboms.length, 0);
});
