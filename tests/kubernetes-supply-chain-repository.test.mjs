import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { KubernetesRepository } = await import("../db/kubernetes-repository.ts");
const {
  KubernetesSupplyChainRepository,
  KubernetesSupplyChainRepositoryError,
} = await import("../db/kubernetes-supply-chain-repository.ts");
const {
  KubernetesSbomRepository,
  KubernetesSbomRepositoryError,
} = await import("../db/kubernetes-sbom-repository.ts");
const { normalizeKubernetesSupplyChainEvidence } = await import("../lib/kubernetes-supply-chain.ts");

const ORG_A = "org_supply_chain_a";
const ORG_B = "org_supply_chain_b";
const CUSTOMER_A = "cust_supply_chain_a";
const CUSTOMER_B = "cust_supply_chain_b";

async function normalized(clusterId, character = "a", extra = {}) {
  return normalizeKubernetesSupplyChainEvidence({
    clusterId,
    collectedAt: "2026-07-17T09:00:00.000Z",
    evidence: {
      image: {
        repository: "738663485493.dkr.ecr.ap-south-1.amazonaws.com/payments",
        digest: `sha256:${character.repeat(64)}`,
        tag: "release-17",
      },
      vulnerabilityScan: {
        scannerVersion: "0.69.1",
        scannedAt: "2026-07-17T08:59:00.000Z",
        critical: 1,
        high: 2,
        medium: 3,
        low: 4,
        unknown: 0,
        fixedAvailable: 3,
      },
      sbom: {
        format: "CycloneDX",
        componentCount: 147,
        documentSha256: "b".repeat(64),
      },
      signature: {
        state: "verified",
        issuer: "https://token.actions.githubusercontent.com",
        subject: "repo:customer/payments:ref:refs/heads/main",
        transparencyLogVerified: true,
      },
      provenance: {
        state: "verified",
        builderId: "https://github.com/customer/build/.github/workflows/release.yml",
        sourceRepository: "https://github.com/customer/payments",
        commitSha: "c".repeat(40),
      },
      ...extra,
    },
  });
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-supply-chain-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'supply-a', 'Supply A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'supply-b', 'Supply B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'supply-customer-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'supply-customer-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    const clusters = new KubernetesRepository(database);
    const clusterA = await clusters.registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A },
      clusterUid: "738663485493:ap-south-1:prod-a",
      name: "Production A",
    });
    const clusterB = await clusters.registerCluster({
      scope: { orgId: ORG_B, customerId: CUSTOMER_B },
      clusterUid: "738663485493:ap-south-1:prod-b",
      name: "Production B",
    });
    await run(database, new KubernetesSupplyChainRepository(database), clusterA.id, clusterB.id);
  } finally {
    await miniflare.dispose();
  }
}

test("publishes immutable digest-bound evidence and replays idempotently", async () => {
  await withDatabase(async (database, repository, clusterA) => {
    const scope = { orgId: ORG_A, customerId: CUSTOMER_A, clusterId: clusterA };
    const evidence = await normalized(clusterA, "a", {
      registryToken: "must-not-survive",
      rawCertificate: "must-not-survive",
    });
    assert.deepEqual(await repository.publish(scope, evidence), evidence);
    assert.deepEqual(await repository.publish(scope, evidence), evidence);
    const stored = await repository.list(scope);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].image.digest, `sha256:${"a".repeat(64)}`);
    assert.equal(stored[0].evidenceSha256, evidence.evidenceSha256);
    const row = await database.prepare(
      "SELECT id, evidence_json FROM kubernetes_supply_chain_evidence WHERE cluster_id = ?",
    ).bind(clusterA).first();
    assert.equal(JSON.stringify(row).includes("must-not-survive"), false);
    assert.equal(JSON.stringify(row).includes("rawCertificate"), false);
    assert.equal(JSON.stringify(row).includes("registryToken"), false);
    await assert.rejects(
      database.prepare("UPDATE kubernetes_supply_chain_evidence SET priority_score = 0 WHERE id = ?")
        .bind(row.id).run(),
      /immutable/u,
    );
    await assert.rejects(
      database.prepare("DELETE FROM kubernetes_supply_chain_evidence WHERE id = ?")
        .bind(row.id).run(),
      /immutable/u,
    );
  });
});

test("tenant and customer scope prevent cross-account reads and writes", async () => {
  await withDatabase(async (_database, repository, clusterA) => {
    const evidence = await normalized(clusterA);
    await repository.publish({ orgId: ORG_A, customerId: CUSTOMER_A, clusterId: clusterA }, evidence);
    assert.equal((await repository.list({
      orgId: ORG_B,
      customerId: CUSTOMER_B,
      clusterId: clusterA,
    })).length, 0);
    await assert.rejects(
      repository.publish({ orgId: ORG_B, customerId: CUSTOMER_B, clusterId: clusterA }, evidence),
      (error) => error instanceof KubernetesSupplyChainRepositoryError &&
        error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("rejects cluster and evidence digest mismatches", async () => {
  await withDatabase(async (_database, repository, clusterA, clusterB) => {
    const evidence = await normalized(clusterA);
    await assert.rejects(
      repository.publish({ orgId: ORG_B, customerId: CUSTOMER_B, clusterId: clusterB }, evidence),
      (error) => error instanceof KubernetesSupplyChainRepositoryError &&
        error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repository.publish(
        { orgId: ORG_A, customerId: CUSTOMER_A, clusterId: clusterA },
        { ...evidence, evidenceSha256: "d".repeat(64) },
      ),
      (error) => error instanceof KubernetesSupplyChainRepositoryError &&
        error.code === "EVIDENCE_MISMATCH",
    );
  });
});

test("license policy versions are scoped, append-only, and concurrency checked", async () => {
  await withDatabase(async (database, _repository, clusterA) => {
    const policies = new KubernetesSbomRepository(database);
    const scope = { orgId: ORG_A, customerId: CUSTOMER_A, clusterId: clusterA };
    const first = await policies.publishPolicyVersion(scope, {
      name: "Production policy",
      deniedLicenses: ["GPL-3.0-only"],
      allowedLicenses: ["MIT"],
      requireIdentifiedLicense: true,
    }, "user_security_admin", 0);
    assert.equal(first.version, 1);
    const second = await policies.publishPolicyVersion(scope, {
      ...first.policy,
      allowedLicenses: ["Apache-2.0", "MIT"],
    }, "user_security_admin", 1);
    assert.equal(second.version, 2);
    assert.equal((await policies.listPolicies(scope))[0].version, 2);
    assert.equal((await policies.listPolicies({
      orgId: ORG_B,
      customerId: CUSTOMER_B,
      clusterId: clusterA,
    })).length, 0);
    await assert.rejects(
      policies.publishPolicyVersion(scope, {
        ...second.policy,
        deniedLicenses: ["AGPL-3.0-only", "GPL-3.0-only"],
      }, "user_security_admin", 1),
      (error) => error instanceof KubernetesSbomRepositoryError &&
        error.code === "VERSION_CONFLICT",
    );
    const version = await database.prepare(
      "SELECT id FROM kubernetes_sbom_license_policy_versions WHERE policy_id = ? AND version = 1",
    ).bind(first.id).first();
    await assert.rejects(
      database.prepare("DELETE FROM kubernetes_sbom_license_policy_versions WHERE id = ?")
        .bind(version.id).run(),
      /immutable/u,
    );
  });
});

test("migration and API contracts enforce scope, normalization, and bounded evidence", async () => {
  const route = await readFile(
    new URL("../app/api/v1/kubernetes/supply-chain/route.ts", import.meta.url),
    "utf8",
  );
  const sqlite = await readFile(
    new URL("../drizzle/0016_kubernetes_supply_chain.sql", import.meta.url),
    "utf8",
  );
  const postgres = await readFile(
    new URL("../postgres/migrations/0010_kubernetes_supply_chain.sql", import.meta.url),
    "utf8",
  );
  const d1Runtime = await readFile(
    new URL("../db/runtime-migrations.ts", import.meta.url),
    "utf8",
  );
  const postgresRuntime = await readFile(
    new URL("../db/postgres-runtime-migrations.ts", import.meta.url),
    "utf8",
  );
  const postgresRunner = await readFile(
    new URL("../scripts/postgres-migrate.mjs", import.meta.url),
    "utf8",
  );
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, capability, connection\.customerId\)/u);
  assert.match(route, /normalizeKubernetesSupplyChainEvidence/u);
  assert.match(route, /readBoundedJson\(request, 64 \* 1_024\)/u);
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.doesNotMatch(route, /registryCredential|privateKey|certificate|kubeconfig|bearerToken/u);
  for (const migration of [sqlite, postgres]) {
    assert.match(migration, /kubernetes_supply_chain_evidence/u);
    assert.match(migration, /org_id/u);
    assert.match(migration, /customer_id/u);
    assert.match(migration, /cluster_id/u);
    assert.match(migration, /evidence_sha256/u);
    assert.match(migration, /immutable/u);
    assert.doesNotMatch(migration, /certificate|token|credential|raw_manifest/u);
  }
  assert.ok(d1Runtime.indexOf("0015_kubernetes_agent_control") < d1Runtime.indexOf("0016_kubernetes_supply_chain"));
  assert.ok(postgresRuntime.indexOf("0009_kubernetes_agent_control") < postgresRuntime.indexOf("0010_kubernetes_supply_chain"));
  assert.ok(postgresRunner.indexOf("0009_kubernetes_agent_control.sql") < postgresRunner.indexOf("0010_kubernetes_supply_chain.sql"));
});
