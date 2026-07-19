import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { ItsmConnectorRepository, ItsmConnectorRepositoryError } = await import("../db/itsm-connector-repository.ts");

const ORG_A = "org_itsm_a";
const ORG_B = "org_itsm_b";
const CUSTOMER_A = "cust_itsm_a";
const CUSTOMER_B = "cust_itsm_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-itsm-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'itsm-a', 'ITSM A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'itsm-b', 'ITSM B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'itsm-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'itsm-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new ItsmConnectorRepository(database));
  } finally {
    await miniflare.dispose();
  }
}

test("0030 migration stores connectors without ever listing the shared secret", async () => {
  await withDatabase(async (repository) => {
    const secret = "correct-horse-battery-staple";
    const saved = await repository.save(SCOPE_A, {
      name: "acme-jira", connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues", projectKey: "SEC", sharedSecret: secret,
    }, "user_a", Date.parse("2026-07-19T12:00:00Z"));
    assert.match(saved.id, /^itc_[a-f0-9]{32}$/u);
    assert.equal(saved.secretPreview, "corr…");
    const listed = await repository.list(SCOPE_A);
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes(secret), false);
    assert.deepEqual(await repository.list({ orgId: ORG_B, customerId: CUSTOMER_B }), []);
    assert.equal((await repository.getForInbound(saved.id))?.sharedSecret, secret);
    assert.equal(await repository.getForDispatch({ orgId: ORG_B, customerId: CUSTOMER_B }, saved.id), null);
    assert.equal(await repository.delete({ orgId: ORG_B, customerId: CUSTOMER_B }, saved.id), false);
    assert.equal(await repository.delete(SCOPE_A, saved.id), true);
  });
});

test("connector writes reject invalid endpoints and cross-org customer theft", async () => {
  await withDatabase(async (repository) => {
    await assert.rejects(
      repository.save(SCOPE_A, {
        name: "bad-http", connectorType: "jira", baseUrl: "http://jira.example.test",
        projectKey: null, sharedSecret: "sixteen-characters-minimum",
      }, "user_a"),
      (error) => error instanceof ItsmConnectorRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repository.save({ orgId: ORG_B, customerId: CUSTOMER_A }, {
        name: "stolen", connectorType: "servicenow", baseUrl: "https://snow.example.test/api",
        projectKey: null, sharedSecret: "sixteen-characters-minimum",
      }, "user_b"),
      (error) => error instanceof ItsmConnectorRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});
