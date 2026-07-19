import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const repositoryModule = await import("../db/kubernetes-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const ORG_A = "org_kubernetes_tenant_a";
const ORG_B = "org_kubernetes_tenant_b";
const CUSTOMER_A = "cust_kubernetes_tenant_a";
const CUSTOMER_B = "cust_kubernetes_tenant_b";
const clusterUid = "cluster-production-01";
const allKinds = ["Workload", "Service", "Ingress", "RbacRole", "RbacBinding", "ServiceAccount", "Namespace", "NetworkPolicy"];

function evidence(collectedAt, imageCharacter = "a") {
  return {
    schema: "sutra.kubernetes-evidence.v1",
    clusterId: clusterUid,
    collectedAt,
    observedKinds: allKinds,
    resources: [
      {
        kind: "Namespace", name: "payments", namespace: null,
        podSecurityEnforce: "restricted", podSecurityWarn: "restricted", podSecurityAudit: "restricted",
      },
      {
        kind: "Workload", workloadKind: "Deployment", namespace: "payments", name: "api",
        hostNetwork: false, hostPid: false, hostIpc: false, hasHostPath: false,
        runAsNonRoot: true, seccompProfile: "RuntimeDefault",
        containers: [{
          name: "api", image: `registry.example/api@sha256:${imageCharacter.repeat(64)}`,
          privileged: false, allowPrivilegeEscalation: false, runAsNonRoot: true,
          capabilitiesAdd: [], capabilitiesDrop: ["ALL"],
          hasCpuRequest: true, hasMemoryRequest: true, hasCpuLimit: true, hasMemoryLimit: true,
          hasLivenessProbe: true, hasReadinessProbe: true,
        }],
      },
      {
        kind: "Service", namespace: "payments", name: "api",
        serviceType: "ClusterIP", externalAddressCount: 0,
      },
      {
        kind: "Ingress", namespace: "payments", name: "api",
        ruleHosts: ["api.example.com"], tlsHosts: ["api.example.com"],
      },
      {
        kind: "RbacRole", namespace: "payments", name: "reader", clusterScoped: false,
        rules: [{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }],
      },
      {
        kind: "RbacBinding", namespace: "payments", name: "reader-binding", clusterScoped: false,
        roleRefKind: "Role", roleRefName: "reader",
        subjects: [{ kind: "ServiceAccount", namespace: "payments", name: "api" }],
      },
      {
        kind: "ServiceAccount", namespace: "payments", name: "api",
        iamRoleArn: "arn:aws:iam::111122223333:role/payments-api",
      },
      { kind: "NetworkPolicy", namespace: "payments", name: "default-deny", coversAllPods: true },
    ],
  };
}

function coverage(state = "COMPLETE") {
  return allKinds.map((evidenceKind) => ({
    evidenceKind,
    state,
    itemsObserved: 1,
    ...(state === "COMPLETE" ? {} : { errorCode: "COLLECTION_PARTIAL" }),
  }));
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-kubernetes-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'k8s-a', 'K8s A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'k8s-b', 'K8s B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'customer-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'customer-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(database, new repositoryModule.KubernetesRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("cluster registration and every scan read remain tenant/customer scoped", async () => {
  await withDatabase(async (database, repository) => {
    const clusterA = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A },
      clusterUid, name: "Production A", distribution: "eks", version: "1.34",
    });
    const clusterB = await repository.registerCluster({
      scope: { orgId: ORG_B, customerId: CUSTOMER_B },
      clusterUid, name: "Production B", distribution: "eks", version: "1.34",
    });
    assert.notEqual(clusterA.id, clusterB.id);
    const scan = await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A },
      clusterId: clusterA.id,
      idempotencyKey: "scan-tenant-a-0001",
      status: "complete",
      evidence: evidence("2026-07-17T10:00:00.000Z"),
      coverage: coverage(),
    });
    assert.equal((await repository.getLatestCompleteScan(
      { orgId: ORG_A, customerId: CUSTOMER_A }, clusterA.id,
    ))?.id, scan.id);
    assert.equal(await repository.getLatestCompleteScan(
      { orgId: ORG_B, customerId: CUSTOMER_B }, clusterA.id,
    ), null);
    await assert.rejects(repository.publishScan({
      scope: { orgId: ORG_B, customerId: CUSTOMER_B },
      clusterId: clusterA.id,
      idempotencyKey: "scan-cross-tenant",
      status: "complete",
      evidence: evidence("2026-07-17T10:01:00.000Z"),
      coverage: coverage(),
    }), (error) => error instanceof repositoryModule.KubernetesRepositoryError &&
      error.code === "SCOPE_NOT_FOUND");
    assert.equal((await database.prepare(
      "SELECT COUNT(*) AS count FROM kubernetes_scan_runs WHERE org_id = ? AND cluster_id = ?",
    ).bind(ORG_B, clusterA.id).first()).count, 0);
  });
});

test("only a newer complete atomic publication advances the cluster head", async () => {
  await withDatabase(async (database, repository) => {
    const cluster = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production",
    });
    const first = await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "head-complete-0001", status: "complete",
      evidence: evidence("2026-07-17T10:00:00.000Z"), coverage: coverage(),
    });
    await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "head-partial-0002", status: "partial",
      evidence: evidence("2026-07-17T11:00:00.000Z"), coverage: coverage("PARTIAL"),
    });
    assert.equal((await repository.getLatestCompleteScan(
      { orgId: ORG_A, customerId: CUSTOMER_A }, cluster.id,
    ))?.id, first.id);
    const latest = await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "head-complete-0003", status: "complete",
      evidence: evidence("2026-07-17T12:00:00.000Z", "b"), coverage: coverage(),
    });
    await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "head-older-0004", status: "complete",
      evidence: evidence("2026-07-17T09:00:00.000Z", "c"), coverage: coverage(),
    });
    assert.equal((await repository.getLatestCompleteScan(
      { orgId: ORG_A, customerId: CUSTOMER_A }, cluster.id,
    ))?.id, latest.id);
    await assert.rejects(
      database.prepare("UPDATE kubernetes_scan_runs SET status = 'failed' WHERE id = ?")
        .bind(latest.id).run(),
      /immutable/u,
    );
    await assert.rejects(
      database.prepare("DELETE FROM kubernetes_scan_resources WHERE scan_run_id = ?")
        .bind(latest.id).run(),
      /immutable/u,
    );
  });
});

test("idempotent replay is stable and changed evidence conflicts", async () => {
  await withDatabase(async (_database, repository) => {
    const cluster = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production",
    });
    const request = {
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "idempotent-scan-0001", status: "complete",
      evidence: evidence("2026-07-17T10:00:00.000Z"), coverage: coverage(),
    };
    const first = await repository.publishScan(request);
    assert.deepEqual(await repository.publishScan(request), first);
    await assert.rejects(
      repository.publishScan({ ...request, evidence: evidence("2026-07-17T10:00:00.000Z", "d") }),
      (error) => error instanceof repositoryModule.KubernetesRepositoryError &&
        error.code === "IDEMPOTENCY_CONFLICT",
    );
  });
});

test("sanitized Trivy evidence is immutable, scoped and returned with the promoted scan", async () => {
  await withDatabase(async (database, repository) => {
    const cluster = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production",
    });
    await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "scanner-scan-0001", status: "complete",
      evidence: evidence("2026-07-17T13:00:00.000Z"), coverage: coverage(),
      scannerEvidence: {
        findings: [{
          fingerprint: "e".repeat(64),
          clusterId: clusterUid,
          source: "vulnerability_report",
          severity: "high",
          namespace: "payments",
          reportName: "deployment-api",
          affectedResource: { kind: "Deployment", namespace: "payments", name: "api" },
          title: "CVE-2026-1234",
          checkId: null,
          cveId: "CVE-2026-1234",
          packageName: "openssl",
          packageType: "os",
          installedVersion: "1.0",
          fixedVersion: "1.1",
          target: "registry.example/api",
          score: 8.1,
          remediation: "Upgrade the affected package",
          scanner: {
            name: "Trivy",
            vendor: "Aqua Security",
            version: "0.60.0",
            reportUid: "report-uid",
            reportResourceVersion: "42",
            reportUpdatedAt: "2026-07-17T13:00:00.000Z",
          },
        }],
        sboms: [],
      },
    });
    const workspace = await repository.getLatestWorkspace(
      { orgId: ORG_A, customerId: CUSTOMER_A },
      cluster.id,
    );
    assert.equal(workspace.scannerEvidence.findings[0].cveId, "CVE-2026-1234");
    assert.equal(workspace.scannerEvidence.findings[0].packageName, "openssl");
    await assert.rejects(
      database.prepare(
        "UPDATE kubernetes_scan_scanner_evidence SET finding_count = 0 WHERE cluster_id = ?",
      ).bind(cluster.id).run(),
      /immutable/u,
    );
    assert.equal(
      await repository.getLatestWorkspace(
        { orgId: ORG_B, customerId: CUSTOMER_B },
        cluster.id,
      ),
      null,
    );
  });
});

function exposedSecretFinding(overrides = {}) {
  return {
    fingerprint: "f".repeat(64),
    clusterId: clusterUid,
    source: "exposed_secret_report",
    severity: "critical",
    namespace: "payments",
    reportName: "deployment-api",
    affectedResource: { kind: "Deployment", namespace: "payments", name: "api" },
    title: "AWS Access Key ID",
    checkId: "aws-access-key-id",
    cveId: null,
    packageName: null,
    packageType: null,
    installedVersion: null,
    fixedVersion: null,
    target: "/app/config.yaml",
    score: null,
    remediation: "Remove the exposed credential from the image, rotate it, and rebuild.",
    scanner: {
      name: "Trivy", vendor: "Aqua Security", version: "0.60.0",
      reportUid: "report-uid", reportResourceVersion: "7", reportUpdatedAt: "2026-07-17T14:00:00.000Z",
    },
    ...overrides,
  };
}

test("opt-in exposed-secret findings persist as metadata only (rule + target, never the value)", async () => {
  await withDatabase(async (database, repository) => {
    const cluster = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production",
    });
    await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "exposed-secret-0001", status: "complete",
      evidence: evidence("2026-07-17T14:00:00.000Z"), coverage: coverage(),
      scannerEvidence: { findings: [exposedSecretFinding()], sboms: [] },
    });
    const workspace = await repository.getLatestWorkspace({ orgId: ORG_A, customerId: CUSTOMER_A }, cluster.id);
    const finding = workspace.scannerEvidence.findings.find((item) => item.source === "exposed_secret_report");
    assert.ok(finding !== undefined, "the exposed-secret finding is stored");
    assert.equal(finding.checkId, "aws-access-key-id");
    assert.equal(finding.target, "/app/config.yaml");
    // The stored evidence carries only sanitized metadata — no field can hold the secret value.
    assert.equal(JSON.stringify(workspace.scannerEvidence).includes("AKIA"), false);
  });
});

test("a scanner finding carrying the raw secret match value is rejected at the DB boundary", async () => {
  await withDatabase(async (database, repository) => {
    const cluster = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production",
    });
    await assert.rejects(
      repository.publishScan({
        scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
        idempotencyKey: "exposed-secret-leak-0001", status: "complete",
        evidence: evidence("2026-07-17T14:00:00.000Z"), coverage: coverage(),
        scannerEvidence: {
          findings: [exposedSecretFinding({ match: "AKIAEXAMPLESHOULDNEVERPERSIST" })],
          sboms: [],
        },
      }),
      (error) => error instanceof repositoryModule.KubernetesRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});
