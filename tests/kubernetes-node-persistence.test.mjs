import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const repositoryModule = await import("../db/kubernetes-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const projectionModule = await import("../lib/finops-k8s-allocation-projection.ts");

const { projectKubernetesAllocationInput, NODE_MONTHLY_LIST_PRICE_USD_MICROS } = projectionModule;

const ORG_A = "org_k8s_nodes_a";
const ORG_B = "org_k8s_nodes_b";
const CUSTOMER_A = "cust_k8s_nodes_a";
const CUSTOMER_B = "cust_k8s_nodes_b";
const clusterUid = "cluster-nodes-01";
const allKinds = ["Workload", "Service", "Ingress", "RbacRole", "RbacBinding", "ServiceAccount", "Namespace", "NetworkPolicy"];

// Two collected nodes: both instance types are in the bundled catalog so a node
// cost is derivable, and both report allocatable capacity.
const NODES = [
  { name: "node-a", allocatableCpuMillicores: 4000, allocatableMemoryBytes: 16_000_000_000, instanceType: "m5.xlarge" },
  { name: "node-b", allocatableCpuMillicores: 2000, allocatableMemoryBytes: 8_000_000_000, instanceType: "m5.large" },
];

function evidence(collectedAt, { nodes } = {}) {
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
          name: "api", image: `registry.example/api@sha256:${"a".repeat(64)}`,
          privileged: false, allowPrivilegeEscalation: false, runAsNonRoot: true,
          capabilitiesAdd: [], capabilitiesDrop: ["ALL"],
          hasCpuRequest: true, hasMemoryRequest: true, hasCpuLimit: true, hasMemoryLimit: true,
          hasLivenessProbe: true, hasReadinessProbe: true,
          // Real numeric requests so the projection's pod rows are non-empty too.
          cpuRequestMillicores: 500, memoryRequestBytes: 1_000_000_000,
        }],
      },
      { kind: "Service", namespace: "payments", name: "api", serviceType: "ClusterIP", externalAddressCount: 0 },
      { kind: "Ingress", namespace: "payments", name: "api", ruleHosts: ["api.example.com"], tlsHosts: ["api.example.com"] },
      {
        kind: "RbacRole", namespace: "payments", name: "reader", clusterScoped: false,
        rules: [{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }],
      },
      {
        kind: "RbacBinding", namespace: "payments", name: "reader-binding", clusterScoped: false,
        roleRefKind: "Role", roleRefName: "reader",
        subjects: [{ kind: "ServiceAccount", namespace: "payments", name: "api" }],
      },
      { kind: "ServiceAccount", namespace: "payments", name: "api", iamRoleArn: "arn:aws:iam::111122223333:role/payments-api" },
      { kind: "NetworkPolicy", namespace: "payments", name: "default-deny", coversAllPods: true },
    ],
    // The optional side array is OMITTED entirely when no nodes were collected.
    ...(nodes === undefined ? {} : { nodes }),
  };
}

function coverage() {
  return allKinds.map((evidenceKind) => ({ evidenceKind, state: "COMPLETE", itemsObserved: 1 }));
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-k8s-nodes-${crypto.randomUUID()}` },
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

test("a scan saved WITH nodes round-trips to a priced, capacity-bearing allocation input", async () => {
  await withDatabase(async (_database, repository) => {
    const cluster = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production",
    });
    await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "node-scan-with-0001", status: "complete",
      evidence: evidence("2026-07-17T10:00:00.000Z", { nodes: NODES }), coverage: coverage(),
    });

    const snapshot = await repository.getLatestAllocationEvidence(
      { orgId: ORG_A, customerId: CUSTOMER_A }, cluster.id,
    );
    assert.ok(snapshot !== null, "the latest complete scan is reconstructed");
    assert.equal(snapshot.clusterId, clusterUid);
    // Nodes survive persistence: validated, sorted by name, with their capacity
    // and instance type intact.
    assert.deepEqual(snapshot.nodes, [
      { name: "node-a", allocatableCpuMillicores: 4000, allocatableMemoryBytes: 16_000_000_000, instanceType: "m5.xlarge" },
      { name: "node-b", allocatableCpuMillicores: 2000, allocatableMemoryBytes: 8_000_000_000, instanceType: "m5.large" },
    ]);

    // End-to-end: the reconstructed snapshot feeds the FinOps projection.
    const projected = projectKubernetesAllocationInput(snapshot);
    const expectedMicros = (
      BigInt(NODE_MONTHLY_LIST_PRICE_USD_MICROS["m5.xlarge"]) +
      BigInt(NODE_MONTHLY_LIST_PRICE_USD_MICROS["m5.large"])
    ).toString();
    assert.deepEqual(projected.clusterCosts, [
      { clusterId: clusterUid, currency: "USD", amountMicros: expectedMicros },
    ]);
    assert.deepEqual(projected.capacity, [
      { clusterId: clusterUid, cpuMillicores: 6000, memoryBytes: 24_000_000_000 },
    ]);
    assert.equal(projected.costCatalogCoverage.costDerivable, true);
    assert.equal(projected.costCatalogCoverage.nodesPriced, 2);
    // The numeric pod requests also survive so allocation has demand to divide.
    const payments = projected.pods.find((pod) => pod.namespace === "payments" && pod.workload === "api");
    assert.ok(payments !== undefined);
    assert.equal(payments.cpuRequestMillicores, 500);
    assert.equal(payments.memoryRequestBytes, 1_000_000_000);
  });
});

test("a scan saved WITHOUT nodes stays honest: no nodes, no derivable node cost", async () => {
  await withDatabase(async (_database, repository) => {
    const cluster = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production",
    });
    await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: cluster.id,
      idempotencyKey: "node-scan-without-0001", status: "complete",
      evidence: evidence("2026-07-17T10:00:00.000Z"), coverage: coverage(),
    });

    const snapshot = await repository.getLatestAllocationEvidence(
      { orgId: ORG_A, customerId: CUSTOMER_A }, cluster.id,
    );
    assert.ok(snapshot !== null);
    // Omitted-when-empty, exactly like the collector path — never fabricated.
    assert.deepEqual(snapshot.nodes ?? [], []);

    const projected = projectKubernetesAllocationInput(snapshot);
    assert.deepEqual(projected.clusterCosts, []);
    assert.deepEqual(projected.capacity, []);
    assert.equal(projected.costCatalogCoverage.costDerivable, false);
    assert.equal(projected.costCatalogCoverage.nodesTotal, 0);
  });
});

test("allocation-evidence reads are tenant and cluster scoped", async () => {
  await withDatabase(async (_database, repository) => {
    const clusterA = await repository.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterUid, name: "Production A",
    });
    const clusterB = await repository.registerCluster({
      scope: { orgId: ORG_B, customerId: CUSTOMER_B }, clusterUid, name: "Production B",
    });
    await repository.publishScan({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A }, clusterId: clusterA.id,
      idempotencyKey: "node-scan-scope-0001", status: "complete",
      evidence: evidence("2026-07-17T10:00:00.000Z", { nodes: NODES }), coverage: coverage(),
    });

    // The other tenant cannot read tenant A's cluster nodes.
    assert.equal(
      await repository.getLatestAllocationEvidence({ orgId: ORG_B, customerId: CUSTOMER_B }, clusterA.id),
      null,
    );
    // A different, node-less cluster in the reading tenant yields no snapshot.
    assert.equal(
      await repository.getLatestAllocationEvidence({ orgId: ORG_B, customerId: CUSTOMER_B }, clusterB.id),
      null,
    );
    // The owning tenant still gets its nodes back.
    const owned = await repository.getLatestAllocationEvidence(
      { orgId: ORG_A, customerId: CUSTOMER_A }, clusterA.id,
    );
    assert.equal(owned?.nodes?.length, 2);
  });
});
