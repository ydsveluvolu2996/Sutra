import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { ComplianceWorkspaceRepository, ComplianceWorkspaceRepositoryError } = await import("../db/compliance-workspace-repository.ts");
const { buildComplianceTrend } = await import("../lib/compliance-trend.ts");

const ORG_A = "org_cmp_a";
const ORG_B = "org_cmp_b";
const CUSTOMER_A = "cust_cmp_a";
const CUSTOMER_B = "cust_cmp_b";
const CONN_A = `conn_${"c".repeat(32)}`;
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };
const SHA = "d".repeat(64);

const DEFINITION = {
  name: "acme-baseline",
  title: "Acme baseline",
  controls: [{ controlId: "A-1", title: "Encrypt", sutraControlIds: ["SUTRA.AWS.EBS.1"] }],
};

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-cmp-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cmp-a', 'Cmp A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cmp-b', 'Cmp B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cmp-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cmp-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new ComplianceWorkspaceRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0027 migration applies; custom frameworks round-trip, upsert by name, stay org-scoped", async () => {
  await withDatabase(async (repo) => {
    const saved = await repo.saveCustomFramework(SCOPE_A, DEFINITION, "user_a");
    assert.match(saved.id, /^cf_[a-f0-9]{32}$/u);
    await repo.saveCustomFramework(SCOPE_A, { ...DEFINITION, title: "Acme baseline v2" }, "user_a");
    const listed = await repo.listCustomFrameworks(SCOPE_A);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].definition.title, "Acme baseline v2");
    assert.deepEqual(await repo.listCustomFrameworks(SCOPE_B), []);
    await assert.rejects(
      repo.saveCustomFramework(SCOPE_A, { name: "bad name!", title: "x", controls: [] }, "user_a"),
      (error) => error instanceof ComplianceWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repo.saveCustomFramework({ orgId: ORG_B, customerId: CUSTOMER_A }, DEFINITION, "user_b"),
      (error) => error instanceof ComplianceWorkspaceRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
    assert.equal(await repo.deleteCustomFramework(SCOPE_B, listed[0].id), false);
    assert.equal(await repo.deleteCustomFramework(SCOPE_A, listed[0].id), true);
  });
});

test("control assignments upsert per control id and stay org-scoped", async () => {
  await withDatabase(async (repo) => {
    await repo.assignControlOwner(SCOPE_A, "SUTRA.AWS.EBS.1", "storage", "storage@example.com", "user_a");
    await repo.assignControlOwner(SCOPE_A, "SUTRA.AWS.EBS.1", "platform", null, "user_a");
    const assignments = await repo.listControlAssignments(SCOPE_A);
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0].ownerTeam, "platform");
    assert.equal(assignments[0].ownerEmail, null);
    assert.deepEqual(await repo.listControlAssignments(SCOPE_B), []);
    await assert.rejects(
      repo.assignControlOwner(SCOPE_A, "SUTRA.AWS.EBS.1", null, "not-an-email", "user_a"),
      (error) => error instanceof ComplianceWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});

test("sign-offs are append-only and record the MFA state truthfully", async () => {
  await withDatabase(async (repo) => {
    await repo.recordSignoff(SCOPE_A, CONN_A, SHA, "approved", "Looks complete", "user_a", true);
    await repo.recordSignoff(SCOPE_A, CONN_A, SHA, "needs-work", "Two controls unknown", "user_b", false);
    const signoffs = await repo.listSignoffs(SCOPE_A, CONN_A);
    assert.equal(signoffs.length, 2);
    assert.deepEqual(signoffs.map((entry) => entry.decision).sort(), ["approved", "needs-work"]);
    assert.equal(signoffs.find((entry) => entry.signedBy === "user_b").mfaVerified, false);
    assert.deepEqual(await repo.listSignoffs(SCOPE_B, CONN_A), []);
    await assert.rejects(
      repo.recordSignoff(SCOPE_A, CONN_A, "nothex", "approved", null, "user_a", true),
      (error) => error instanceof ComplianceWorkspaceRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});

test("trend points are idempotent per snapshot and feed the trend engine", async () => {
  await withDatabase(async (repo) => {
    const base = { passCount: 8, failCount: 2, unknownCount: 0, notCollectedCount: 0 };
    await repo.recordTrendPoint(SCOPE_A, CONN_A, "pci-dss-v4", { ...base, snapshotId: "snap-1", collectedAtMs: 1_000 });
    await repo.recordTrendPoint(SCOPE_A, CONN_A, "pci-dss-v4", { ...base, snapshotId: "snap-1", collectedAtMs: 1_000 });
    await repo.recordTrendPoint(SCOPE_A, CONN_A, "pci-dss-v4", { ...base, passCount: 9, failCount: 1, snapshotId: "snap-2", collectedAtMs: 2_000 });
    const points = await repo.listTrendPoints(SCOPE_A, CONN_A, "pci-dss-v4");
    assert.equal(points.length, 2);
    const trend = buildComplianceTrend(points);
    assert.equal(trend.direction, "improving");
    assert.equal(trend.delta, 10);
    assert.deepEqual(await repo.listTrendPoints(SCOPE_B, CONN_A, "pci-dss-v4"), []);
  });
});
