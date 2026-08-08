import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const onboarding = await import("../db/onboarding-repository.ts");

const ORG = "org_onbrd";
const OTHER_ORG = "org_other";

function subject(orgId = ORG) {
  return { orgId, userId: "user_x", role: "org_owner", scopeMode: "all_customers", grants: [] };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-onboarding-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status, plan) VALUES (?, 'onbrd', 'Fresh Org', 'active', 'trial')",
      ).bind(ORG),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'other', 'Other Org', 'active')",
      ).bind(OTHER_ORG),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

test("a fresh org has nothing done and completion is fully derived", async () => {
  await withDatabase(async () => {
    const progress = await onboarding.getOnboardingProgress(subject());
    assert.deepEqual(progress, {
      goals: [],
      steps: { goals: false, name: false, connect: false },
      completed: false,
    });
  });
});

test("goals persist in canonical order, reject unknowns, and require at least one", async () => {
  await withDatabase(async () => {
    const progress = await onboarding.chooseOnboardingGoals(subject(), ["vulnerabilities", "cmdb"]);
    // Click order does not matter: the same choice always serializes the same.
    assert.deepEqual(progress.goals, ["cmdb", "vulnerabilities"]);
    assert.equal(progress.steps.goals, true);
    assert.equal(progress.completed, false);
    await assert.rejects(onboarding.chooseOnboardingGoals(subject(), []), /at least one goal/u);
    await assert.rejects(onboarding.chooseOnboardingGoals(subject(), ["bitcoin"]), /Unknown goal/u);
    await assert.rejects(
      onboarding.chooseOnboardingGoals(subject(), ["cmdb", "cmdb"]),
      /unique/u,
    );
    // Re-choosing replaces rather than accumulates.
    const rechosen = await onboarding.chooseOnboardingGoals(subject(), ["finops"]);
    assert.deepEqual(rechosen.goals, ["finops"]);
  });
});

test("sharing the name renames the organization and stamps the step", async () => {
  await withDatabase(async (database) => {
    const progress = await onboarding.shareWorkspaceName(subject(), "  Acme   Cloud  ");
    assert.equal(progress.steps.name, true);
    const row = await database.prepare("SELECT name FROM organizations WHERE id = ?").bind(ORG).first();
    // Whitespace is collapsed; the org row carries the operator's chosen name.
    assert.equal(row.name, "Acme Cloud");
    await assert.rejects(onboarding.shareWorkspaceName(subject(), "x"), /between 2 and 100/u);
    await assert.rejects(onboarding.shareWorkspaceName(subject(), "<script>alert(1)</script>"), /between 2 and 100/u);
    // A subject whose org does not exist renames nothing.
    await assert.rejects(onboarding.shareWorkspaceName(subject("org_missing"), "Ghost"), /could not be renamed/u);
  });
});

test("the connect step derives from a real connection and never from fixtures", async () => {
  await withDatabase(async (database) => {
    await onboarding.chooseOnboardingGoals(subject(), ["cmdb"]);
    await onboarding.shareWorkspaceName(subject(), "Acme Cloud");
    // A simulated fixture must not satisfy "connect your infrastructure".
    await database.prepare(
      `INSERT INTO aws_connections
        (id, org_id, customer_id, source_kind, aws_account_id, role_arn,
         external_id_ciphertext, external_id_key_version, permission_pack_version, status)
       SELECT 'conn_${"f".repeat(32)}', ?, c.id, 'simulated_fixture', '123456789012', '',
              'ct', 'v1', 'standard-2026-08.12', 'active'
         FROM customers c WHERE c.org_id = ? LIMIT 1`,
    ).bind(ORG, ORG).run().catch(() => undefined);
    let progress = await onboarding.getOnboardingProgress(subject());
    assert.equal(progress.steps.connect, false);
    assert.equal(progress.completed, false);

    // A real trust-role connection in ANOTHER org proves nothing here.
    await database.batch([
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES ('cust_other', ?, 'oc', 'OC', 'active')",
      ).bind(OTHER_ORG),
      database.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, source_kind, aws_account_id, role_arn,
           external_id_ciphertext, external_id_key_version, permission_pack_version, status)
         VALUES ('conn_${"e".repeat(32)}', ?, 'cust_other', 'aws_trust_role', '999988887777',
                 'arn:aws:iam::999988887777:role/sutra/SutraCollectorRole', 'ct', 'v1', 'standard-2026-08.12', 'active')`,
      ).bind(OTHER_ORG),
    ]);
    progress = await onboarding.getOnboardingProgress(subject());
    assert.equal(progress.steps.connect, false);

    // A real connection in THIS org completes the derived step and the flow.
    await database.batch([
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES ('cust_onbrd', ?, 'ac', 'AC', 'active')",
      ).bind(ORG),
      database.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, source_kind, aws_account_id, role_arn,
           external_id_ciphertext, external_id_key_version, permission_pack_version, status)
         VALUES ('conn_${"d".repeat(32)}', ?, 'cust_onbrd', 'aws_trust_role', '111122223333',
                 'arn:aws:iam::111122223333:role/sutra/SutraCollectorRole', 'ct', 'v1', 'standard-2026-08.12', 'active')`,
      ).bind(ORG),
    ]);
    progress = await onboarding.getOnboardingProgress(subject());
    assert.deepEqual(progress.steps, { goals: true, name: true, connect: true });
    assert.equal(progress.completed, true);
  });
});
