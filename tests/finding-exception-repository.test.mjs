import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { FindingExceptionRepository, FindingExceptionRepositoryError } = await import("../db/finding-exception-repository.ts");

const ORG_A = "org_fexc_a";
const ORG_B = "org_fexc_b";
const CUSTOMER_A = "cust_fexc_a";
const CUSTOMER_B = "cust_fexc_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-finding-exceptions-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'fexc-a', 'Fexc A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'fexc-b', 'Fexc B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'fexc-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'fexc-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new FindingExceptionRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0032 migration applies; a rule is created, listed newest-first, and scope round-trips", async () => {
  await withDatabase(async (repo) => {
    const first = await repo.create(SCOPE_A, { ruleId: "aws.s3.block-public-access", justification: "risk accepted for logs bucket", approvedBy: "op@sutra.dev" }, 1_000);
    const second = await repo.create(SCOPE_A, { resourceRef: "aws:ec2:sg:allow-ssh", justification: "bastion is jump-only", approvedBy: "op@sutra.dev" }, 2_000);
    const rules = await repo.list(SCOPE_A);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].id, second.id, "ordered by created_at descending");
    assert.equal(rules[0].ruleId, null);
    assert.equal(rules[0].resourceRef, "aws:ec2:sg:allow-ssh");
    assert.equal(rules[1].id, first.id);
    assert.equal(rules[1].ruleId, "aws.s3.block-public-access");
    assert.equal(rules[1].status, "active");
    assert.equal(rules[1].expiresAtMs, null);
  });
});

test("a rule with no scope field is refused (never a silent blanket suppression)", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.create(SCOPE_A, { justification: "accept everything please", approvedBy: "op@sutra.dev" }),
      (error) => error instanceof FindingExceptionRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});

test("a rule requires a non-empty justification and approver", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.create(SCOPE_A, { ruleId: "aws.s3.x", justification: "   ", approvedBy: "op@sutra.dev" }),
      (error) => error instanceof FindingExceptionRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      () => repo.create(SCOPE_A, { ruleId: "aws.s3.x", justification: "valid rationale", approvedBy: "" }),
      (error) => error instanceof FindingExceptionRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});

test("an expiry in the past is refused", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.create(SCOPE_A, { ruleId: "aws.s3.x", justification: "valid rationale", approvedBy: "op@sutra.dev", expiresAtMs: 500 }, 1_000),
      (error) => error instanceof FindingExceptionRepositoryError && error.code === "INVALID_INPUT",
    );
  });
});

test("a rule cannot be created for a customer outside the acting organization", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.create({ orgId: ORG_A, customerId: CUSTOMER_B }, { ruleId: "aws.s3.x", justification: "cross tenant attempt", approvedBy: "op@sutra.dev" }),
      (error) => error instanceof FindingExceptionRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("list is tenant-isolated and revoke is scoped to the tenant (org A cannot touch org B)", async () => {
  await withDatabase(async (repo) => {
    const created = await repo.create(SCOPE_A, { ruleId: "aws.s3.x", justification: "risk accepted here", approvedBy: "op@sutra.dev" });
    // Org B, which does not own the rule, sees nothing and cannot revoke it.
    assert.equal((await repo.list(SCOPE_B)).length, 0, "another tenant sees no rules");
    assert.equal(await repo.revoke(SCOPE_B, created.id), false, "cross-tenant revoke is a no-op");
    assert.equal((await repo.list(SCOPE_A)).length, 1, "the rule survives a cross-tenant revoke");
    // The owning tenant can revoke; the revoked rule leaves the active list.
    assert.equal(await repo.revoke(SCOPE_A, created.id), true);
    assert.equal((await repo.list(SCOPE_A)).length, 0);
  });
});
