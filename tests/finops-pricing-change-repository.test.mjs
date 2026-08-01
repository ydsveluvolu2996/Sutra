import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { PricingChangeMaterializationRepository, PricingChangeRepositoryError } =
  await import("../db/finops-pricing-change-repository.ts");

const ORG_A = "org_pca_a";
const ORG_B = "org_pca_b";
const CUSTOMER_A = "customer_pca_a";
const CUSTOMER_B = "customer_pca_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const SCOPE_A = { organizationId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A };
const SCOPE_B = { organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B };

function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(`INSERT INTO aws_connections (
    id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
    external_id_ciphertext, external_id_key_version, permission_pack_version,
    status, enabled_regions_json
  ) VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ct', 'v1',
    'standard-2026-08.1', 'active', '[]')`).bind(
      id, orgId, customerId, accountId,
      `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`,
    );
}

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-pca-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'pca-a', 'PCA A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'pca-b', 'PCA B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'pca-ca', 'PCA CA', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'pca-cb', 'PCA CB', 'active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, "111122223333"),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, "999900001111"),
    ]);
    await run({ database, repository: new PricingChangeMaterializationRepository(database) });
  } finally {
    await miniflare.dispose();
  }
}

function snapshot(idCharacter, state = "READY", generatedAt = "2026-08-01T01:00:00.000Z") {
  const input = state === "NO_USAGE" ? 0 : 1;
  const modeled = state === "READY" ? 1 : 0;
  return {
    schemaVersion: "sutra.pricing-change.snapshot.v1",
    scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A },
    collectionId: `pca_${idCharacter.repeat(64)}`,
    generatedAt,
    state,
    usagePeriodStartAt: "2026-06-01T00:00:00.000Z",
    usagePeriodEndAt: "2026-07-01T00:00:00.000Z",
    baselineEffectiveAt: "2025-01-15T00:00:00.000Z",
    comparisonEffectiveAt: "2026-01-15T00:00:00.000Z",
    activeCur2GenerationId: `gen_${"d".repeat(64)}`,
    activeCur2GeneratedAt: "2026-08-01T00:00:00.000Z",
    activeCur2ManifestSha256: "e".repeat(64),
    assumptions: [],
    catalogEvidence: [{ snapshotId: "a" }, { snapshotId: "b" }],
    summary: {
      inputLineCount: input,
      modeledLineCount: modeled,
      excludedLineCount: input - modeled,
      catalogSnapshotCount: 2,
      catalogTermCount: 2,
      modeledTotalsByCurrency: [],
    },
    groups: [],
    exclusions: [],
  };
}

function recordInput(report, generationCharacter) {
  return {
    snapshot: report,
    evidenceGenerationId: `fss_${generationCharacter.repeat(64)}`,
    contentSha256: generationCharacter.repeat(64),
    evidenceReference: { ciphertext: `fsev1.${"A".repeat(40)}`, keyVersion: "pricing-change-v1" },
  };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof PricingChangeRepositoryError);
    assert.equal(error.code, code);
    return true;
  };
}

test("complete materializations are replay-safe, tenant-bound, and advance monotonically", async () => {
  await withRepository(async ({ repository }) => {
    const firstInput = recordInput(snapshot("a"), "1");
    const first = await repository.recordMaterialization(SCOPE_A, firstInput, 10);
    assert.equal(first.becameActive, true);
    const replay = await repository.recordMaterialization(SCOPE_A, firstInput, 20);
    assert.equal(replay.becameActive, false);
    assert.equal((await repository.getActive(SCOPE_A))?.snapshotId, firstInput.snapshot.collectionId);
    assert.equal(await repository.getActive(SCOPE_B), null);

    const newerInput = recordInput(snapshot("b", "READY", "2026-08-01T02:00:00.000Z"), "2");
    await repository.recordMaterialization(SCOPE_A, newerInput, 30);
    assert.equal((await repository.getActive(SCOPE_A))?.snapshotId, newerInput.snapshot.collectionId);
  });
});

test("partial captures remain history-only and immutable conflicts are rejected", async () => {
  await withRepository(async ({ database, repository }) => {
    const ready = recordInput(snapshot("a"), "1");
    await repository.recordMaterialization(SCOPE_A, ready, 10);
    const partial = recordInput(snapshot("c", "PARTIAL", "2026-08-01T03:00:00.000Z"), "3");
    await repository.recordMaterialization(SCOPE_A, partial, 20);
    assert.equal((await repository.getLatest(SCOPE_A))?.snapshotId, partial.snapshot.collectionId);
    assert.equal((await repository.getActive(SCOPE_A))?.snapshotId, ready.snapshot.collectionId);

    await assert.rejects(repository.recordMaterialization(SCOPE_A, {
      ...ready,
      contentSha256: "f".repeat(64),
    }, 30), expectCode("IMMUTABLE_CONFLICT"));
    await assert.rejects(database.prepare(
      "UPDATE finops_pricing_change_materializations SET state = 'partial' WHERE snapshot_id = ?",
    ).bind(ready.snapshot.collectionId).run(), /FINOPS_PRICING_CHANGE_IMMUTABLE/u);
  });
});
