import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  FinopsFoundationalConfigRepository,
  FinopsFoundationalConfigRepositoryError,
} = await import("../db/finops-foundational-config-repository.ts");

const ORG_A = "org_foundational_a";
const ORG_B = "org_foundational_b";
const CUSTOMER_A = "customer_foundational_a";
const CUSTOMER_B = "customer_foundational_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const FIXTURE = `conn_${"c".repeat(32)}`;
const DISABLED = `conn_${"d".repeat(32)}`;
const SCOPE_A = {
  organizationId: ORG_A,
  customerId: CUSTOMER_A,
  connectionId: CONNECTION_A,
};
const SCOPE_B = {
  organizationId: ORG_B,
  customerId: CUSTOMER_B,
  connectionId: CONNECTION_B,
};

function connection(database, {
  id,
  orgId,
  customerId,
  sourceKind = "aws_trust_role",
  status = "active",
  accountId,
}) {
  return database.prepare(
    `INSERT INTO aws_connections (
      id, org_id, customer_id, source_kind, fixture_id, aws_account_id,
      role_arn, external_id_ciphertext, external_id_key_version,
      permission_pack_version, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ciphertext', 'v1', 'pack-v1', ?)`,
  ).bind(
    id,
    orgId,
    customerId,
    sourceKind,
    sourceKind === "simulated_fixture" ? "fixture-one" : null,
    accountId,
    sourceKind === "aws_trust_role"
      ? `arn:aws:iam::${accountId}:role/SutraCollectorRole`
      : "",
    status,
  );
}

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-foundational-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'found-a', 'Found A', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'found-b', 'Found B', 'active')",
      ).bind(ORG_B),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'found-ca', 'Found CA', 'active')",
      ).bind(CUSTOMER_A, ORG_A),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'found-cb', 'Found CB', 'active')",
      ).bind(CUSTOMER_B, ORG_B),
      connection(database, {
        id: CONNECTION_A,
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        accountId: "111122223333",
      }),
      connection(database, {
        id: CONNECTION_B,
        orgId: ORG_B,
        customerId: CUSTOMER_B,
        accountId: "444455556666",
      }),
      connection(database, {
        id: FIXTURE,
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        sourceKind: "simulated_fixture",
        accountId: "999900001111",
      }),
      connection(database, {
        id: DISABLED,
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        status: "disabled",
        accountId: "999900002222",
      }),
    ]);
    await run(new FinopsFoundationalConfigRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

function goal({
  id = `fkg_${"1".repeat(32)}`,
  version = 1,
  from = "2026-07-01T00:00:00.000Z",
  to = null,
} = {}) {
  const actorId = "admin-one";
  return {
    id,
    version,
    kpiId: "ec2_graviton_share",
    targetDirection: "higher_is_better",
    targetBasisPoints: 7_500,
    effectiveFromIso: from,
    effectiveToIso: to,
    actorId,
    auditReference: `audit://kpi-goal/${version}`,
    rbacDecision: {
      decisionId: `decision-${version}`,
      decision: "allow",
      action: "finops:kpi-goal:write",
      resource: [
        "finops-kpi",
        SCOPE_A.organizationId,
        SCOPE_A.customerId,
        SCOPE_A.connectionId,
        "ec2_graviton_share",
      ].join(":"),
      actorId,
      decidedAtIso: "2026-06-30T00:00:00.000Z",
      policyVersion: "policy-v1",
      evidenceReference: `audit://rbac/${version}`,
    },
  };
}

function taxonomy(version, environment) {
  return {
    version,
    taxonomy: {
      scope: SCOPE_A,
      evidence: {
        source: "aws_organizations",
        sourceEvidenceId: `aws://organizations/taxonomy/v${version}`,
        observedAtIso: `2026-07-${String(20 + version).padStart(2, "0")}T00:00:00.000Z`,
      },
      allowLists: {
        company: ["Sutra"],
        business_unit: ["Platform"],
        environment: [environment],
        cost_center: ["CC-100"],
        account: ["111122223333"],
      },
      assignments: [{
        accountId: "111122223333",
        company: "Sutra",
        businessUnit: "Platform",
        environment,
        costCenter: "CC-100",
        owner: "platform@example.com",
      }],
    },
    actorId: "admin-one",
    auditReference: `audit://taxonomy/${version}`,
  };
}

function repositoryError(code) {
  return (error) =>
    error instanceof FinopsFoundationalConfigRepositoryError
    && error.code === code;
}

test("KPI goal versions persist independently across active billing-generation corrections", async () => {
  await withRepository(async (repository, database) => {
    const saved = await repository.saveKpiGoal(
      SCOPE_A,
      goal(),
      Date.parse("2026-07-01T00:01:00Z"),
    );
    assert.equal(saved.scope.connectionId, CONNECTION_A);
    assert.equal(saved.targetBasisPoints, 7_500);
    assert.equal(saved.rbacDecision.actorId, saved.actorId);

    const firstEvaluation = await repository.goalsForEvaluation({
      ...SCOPE_A,
      exportName: "aws-cur",
      billingPeriod: "2026-07",
      generationId: `fbg_${"a".repeat(64)}`,
    });
    const correctedEvaluation = await repository.goalsForEvaluation({
      ...SCOPE_A,
      exportName: "aws-cur",
      billingPeriod: "2026-07",
      generationId: `fbg_${"b".repeat(64)}`,
    });
    assert.deepEqual(firstEvaluation, correctedEvaluation);
    assert.equal(firstEvaluation[0].id, saved.id);
    assert.equal(firstEvaluation[0].billingPeriod, undefined);
    assert.equal(firstEvaluation[0].generationId, undefined);
    assert.equal(correctedEvaluation[0].billingPeriod, undefined);
    assert.equal(correctedEvaluation[0].generationId, undefined);

    const columns = await database.prepare(
      "PRAGMA table_info('finops_kpi_goal_versions')",
    ).all();
    const names = (columns.results ?? []).map((column) => column.name);
    assert.doesNotMatch(names.join(","), /generation|billing_period/u);
  });
});

test("overlapping KPI windows and duplicate versions are rejected without changing prior goals", async () => {
  await withRepository(async (repository) => {
    await repository.saveKpiGoal(SCOPE_A, goal({
      to: "2026-07-15T00:00:00.000Z",
    }));
    await assert.rejects(
      repository.saveKpiGoal(SCOPE_A, goal({
        id: `fkg_${"2".repeat(32)}`,
        version: 2,
        from: "2026-07-10T00:00:00.000Z",
      })),
      repositoryError("OVERLAPPING_GOAL"),
    );
    await assert.rejects(
      repository.saveKpiGoal(SCOPE_A, goal({
        id: `fkg_${"3".repeat(32)}`,
        version: 1,
        from: "2026-07-15T00:00:00.000Z",
      })),
      repositoryError("VERSION_CONFLICT"),
    );
    assert.equal((await repository.listKpiGoals(SCOPE_A)).length, 1);
  });
});

test("taxonomy corrections publish normalized immutable snapshots and move the active head atomically", async () => {
  await withRepository(async (repository, database) => {
    const first = await repository.publishTaxonomy(
      SCOPE_A,
      {
        ...taxonomy(1, "production"),
        snapshotId: `fts_${"1".repeat(32)}`,
      },
      Date.parse("2026-07-25T00:00:00Z"),
    );
    assert.equal(first.version, 1);
    assert.equal(first.taxonomy.assignments[0].environment, "production");

    const corrected = await repository.publishTaxonomy(
      SCOPE_A,
      {
        ...taxonomy(2, "prod"),
        snapshotId: `fts_${"2".repeat(32)}`,
      },
      Date.parse("2026-07-26T00:00:00Z"),
    );
    assert.equal(corrected.version, 2);
    assert.equal(corrected.taxonomy.assignments[0].environment, "prod");
    assert.equal(corrected.taxonomy.evidence.source, "aws_organizations");

    await assert.rejects(
      repository.publishTaxonomy(
        SCOPE_A,
        {
          ...taxonomy(2, "broken"),
          snapshotId: `fts_${"3".repeat(32)}`,
        },
        Date.parse("2026-07-27T00:00:00Z"),
      ),
      repositoryError("VERSION_CONFLICT"),
    );
    const stillActive = await repository.activeTaxonomy(SCOPE_A);
    assert.equal(stillActive.snapshotId, corrected.snapshotId);
    assert.equal(stillActive.taxonomy.assignments[0].environment, "prod");

    await assert.rejects(
      database.prepare(
        "UPDATE finops_taxonomy_snapshots SET source = 'cmdb' WHERE id = ?",
      ).bind(corrected.snapshotId).run(),
      /IMMUTABLE/iu,
    );
  });
});

test("every read and write enforces live aws_trust_role ownership and rejects foreign scopes or fixtures", async () => {
  await withRepository(async (repository) => {
    assert.deepEqual(await repository.listKpiGoals(SCOPE_B), []);
    await assert.rejects(
      repository.listKpiGoals({
        organizationId: ORG_B,
        customerId: CUSTOMER_B,
        connectionId: CONNECTION_A,
      }),
      repositoryError("SCOPE_NOT_FOUND"),
    );
    await assert.rejects(
      repository.listKpiGoals({ ...SCOPE_A, connectionId: FIXTURE }),
      repositoryError("SCOPE_NOT_FOUND"),
    );
    await assert.rejects(
      repository.activeTaxonomy({ ...SCOPE_A, connectionId: DISABLED }),
      repositoryError("SCOPE_NOT_FOUND"),
    );
    await assert.rejects(
      repository.publishTaxonomy(
        { ...SCOPE_A, connectionId: FIXTURE },
        taxonomy(1, "prod"),
      ),
      repositoryError("SCOPE_NOT_FOUND"),
    );
  });
});
