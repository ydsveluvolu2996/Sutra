import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const { normalizeHubbleFlowBatch, HubbleFlowEvidenceError } = await import("../lib/hubble-flow-evidence.ts");
const { HubbleFlowRepository } = await import("../db/hubble-flow-repository.ts");
const { KubernetesRepository } = await import("../db/kubernetes-repository.ts");
const migrations = await import("../db/runtime-migrations.ts");

function raw(extra = {}) {
  const now = new Date(Date.now() - 1_000).toISOString();
  return {
    collectedAt: now,
    hubbleVersion: "1.19.5",
    flows: [{
      observedAt: now,
      source: { namespace: "payments", workloadKind: "Deployment", workloadName: "api", serviceName: "api", world: false },
      destination: { namespace: null, workloadKind: null, workloadName: null, serviceName: null, world: true },
      direction: "egress", verdict: "forwarded", protocol: "TCP", destinationPort: 443, observations: 12,
      ...extra,
    }],
  };
}

test("normalizes bounded metadata and rejects payload, DNS-content, and header fields", async () => {
  const clusterId = `kcluster_${"a".repeat(48)}`;
  const batch = await normalizeHubbleFlowBatch({ clusterId, value: raw() });
  assert.equal(batch.flows[0].destination.world, true);
  assert.equal(batch.flows[0].destinationPort, 443);
  assert.match(batch.flows[0].evidenceSha256, /^[a-f0-9]{64}$/u);
  for (const forbidden of [
    { payload: "secret" }, { dnsQuery: "customer.example" }, { headers: { authorization: "secret" } },
  ]) {
    await assert.rejects(
      normalizeHubbleFlowBatch({ clusterId, value: raw(forbidden) }),
      HubbleFlowEvidenceError,
    );
  }
});

test("persists immutable flows inside exact tenant/customer/cluster scope", async () => {
  const miniflare = new Miniflare({
    modules: true, script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `hubble-${crypto.randomUUID()}` }, d1Persist: false,
  });
  try {
    const db = await miniflare.getD1Database("DB");
    migrations.resetRuntimeSchemaCacheForTests();
    await migrations.ensureRuntimeSchema(db);
    await db.batch([
      db.prepare("INSERT INTO organizations (id, slug, name, status) VALUES ('org_hubble_a', 'hub-a', 'Hub A', 'active')"),
      db.prepare("INSERT INTO organizations (id, slug, name, status) VALUES ('org_hubble_b', 'hub-b', 'Hub B', 'active')"),
      db.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES ('cust_hubble_a', 'org_hubble_a', 'ha', 'HA', 'active')"),
      db.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES ('cust_hubble_b', 'org_hubble_b', 'hb', 'HB', 'active')"),
    ]);
    const cluster = await new KubernetesRepository(db).registerCluster({
      scope: { orgId: "org_hubble_a", customerId: "cust_hubble_a" }, clusterUid: "eks:hubble:a", name: "Hubble A",
    });
    const scope = { orgId: "org_hubble_a", customerId: "cust_hubble_a", clusterId: cluster.id };
    const batch = await normalizeHubbleFlowBatch({ clusterId: cluster.id, value: raw() });
    const repository = new HubbleFlowRepository(db);
    assert.deepEqual(await repository.publish(scope, batch), { accepted: 1, duplicates: 0 });
    assert.deepEqual(await repository.publish(scope, batch), { accepted: 0, duplicates: 1 });
    const workspace = await repository.workspace(scope);
    assert.equal(workspace.coverage, "current");
    assert.equal(workspace.flows.length, 1);
    assert.equal((await repository.workspace({
      orgId: "org_hubble_b", customerId: "cust_hubble_b", clusterId: cluster.id,
    })).coverage, "not_configured");
    await db.prepare("UPDATE hubble_flow_sources SET last_batch_at = ? WHERE cluster_id = ?")
      .bind(Date.now() - 16 * 60 * 1_000, cluster.id).run();
    assert.equal((await repository.workspace(scope)).coverage, "stale");
    await assert.rejects(db.prepare("DELETE FROM hubble_flow_evidence WHERE cluster_id = ?").bind(cluster.id).run(), /immutable/u);
  } finally { await miniflare.dispose() }
});

test("agent upload, authenticated query, migrations, and pinned planning profile remain bounded", async () => {
  const files = await Promise.all([
    "../app/api/v1/kubernetes/agents/[agentId]/hubble-flows/route.ts",
    "../app/api/v1/kubernetes/network-flows/route.ts",
    "../drizzle/0018_hubble_network_visibility.sql",
    "../postgres/migrations/0012_hubble_network_visibility.sql",
    "../deploy/cilium/eks-aws-vpc-cni-hubble/values.yaml",
    "../deploy/cilium/eks-aws-vpc-cni-hubble/README.md",
    "../db/runtime-migrations.ts",
    "../db/postgres-runtime-migrations.ts",
    "../scripts/postgres-migrate.mjs",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const [agent, query, d1, postgres, values, docs, d1Runtime, postgresRuntime, postgresRunner] = files;
  assert.match(agent, /authenticate\(agentId, token/u);
  assert.match(agent, /clusterId: agent\.clusterId/u);
  assert.match(agent, /MAXIMUM_BODY_BYTES = 2 \* 1024 \* 1024/u);
  assert.match(query, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(query, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  for (const migration of [d1, postgres]) {
    assert.match(migration, /org_id/u); assert.match(migration, /customer_id/u);
    assert.match(migration, /cluster_id/u); assert.match(migration, /immutable/u);
    assert.doesNotMatch(migration, /payload|dns_query|header/u);
  }
  assert.match(values, /chainingMode: aws-cni/u);
  assert.match(values, /exclusive: false/u);
  assert.match(values, /enableIPv4Masquerade: false/u);
  assert.match(values, /routingMode: native/u);
  assert.match(values, /ui:\s+enabled: false/su);
  assert.match(docs, /1\.19\.5/u);
  assert.match(docs, /not installed/iu);
  assert.match(d1Runtime, /0018_hubble_network_visibility/u);
  assert.match(postgresRuntime, /0012_hubble_network_visibility/u);
  assert.match(postgresRunner, /0012_hubble_network_visibility\.sql/u);
});
