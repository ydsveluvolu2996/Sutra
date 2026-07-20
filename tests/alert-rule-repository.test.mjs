import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { AlertRuleRepository, AlertRuleRepositoryError } = await import("../db/alert-rule-repository.ts");

const ORG_A = "org_alert_a";
const ORG_B = "org_alert_b";
const CUSTOMER_A = "cust_alert_a";
const CUSTOMER_B = "cust_alert_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };
const CREATED_BY = "user_alert_a";
const T0 = Date.parse("2026-07-20T00:00:00.000Z");

function ruleInput(over = {}) {
  return {
    name: "critical-findings",
    metric: "open-critical-findings-count",
    comparator: "gt",
    threshold: 0,
    severity: "high",
    ...over,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-alerts-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'alert-a', 'Alert A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'alert-b', 'Alert B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'alert-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'alert-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new AlertRuleRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

test("save creates a rule for an owned customer and upserts by name", async () => {
  await withDatabase(async (repo) => {
    const created = await repo.save(SCOPE_A, ruleInput(), CREATED_BY, T0);
    assert.match(created.id, /^arule_[a-f0-9]{32}$/u);
    assert.equal(created.metric, "open-critical-findings-count");
    assert.equal(created.comparator, "gt");
    assert.equal(created.threshold, 0);
    assert.equal(created.severity, "high");
    assert.equal(created.enabled, true);
    assert.deepEqual(created.scope, SCOPE_A);

    // Same name -> update in place (comparator/threshold/severity change).
    const updated = await repo.save(
      SCOPE_A,
      ruleInput({ comparator: "gte", threshold: 3, severity: "medium" }),
      CREATED_BY,
      T0,
    );
    assert.equal(updated.comparator, "gte");
    assert.equal(updated.threshold, 3);
    assert.equal(updated.severity, "medium");
    assert.equal((await repo.list(SCOPE_A)).length, 1);
  });
});

test("save rejects unsupported metric/comparator/severity and out-of-range thresholds", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(() => repo.save(SCOPE_A, ruleInput({ metric: "made-up" }), CREATED_BY, T0), AlertRuleRepositoryError);
    await assert.rejects(() => repo.save(SCOPE_A, ruleInput({ comparator: "neq" }), CREATED_BY, T0), AlertRuleRepositoryError);
    await assert.rejects(() => repo.save(SCOPE_A, ruleInput({ severity: "critical" }), CREATED_BY, T0), AlertRuleRepositoryError);
    await assert.rejects(() => repo.save(SCOPE_A, ruleInput({ threshold: Number.POSITIVE_INFINITY }), CREATED_BY, T0), AlertRuleRepositoryError);
  });
});

test("save into an unowned customer scope is rejected", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.save({ orgId: ORG_A, customerId: CUSTOMER_B }, ruleInput(), CREATED_BY, T0),
      (error) => error instanceof AlertRuleRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("get/list/setEnabled/delete are tenant-scoped", async () => {
  await withDatabase(async (repo) => {
    const created = await repo.save(SCOPE_A, ruleInput(), CREATED_BY, T0);
    // Cross-tenant reads/writes see nothing.
    assert.equal(await repo.get(SCOPE_B, created.id), null);
    assert.deepEqual(await repo.list(SCOPE_B), []);
    assert.equal(await repo.setEnabled(SCOPE_B, created.id, false), false);
    assert.equal(await repo.delete(SCOPE_B, created.id), false);

    assert.equal(await repo.setEnabled(SCOPE_A, created.id, false), true);
    assert.equal((await repo.get(SCOPE_A, created.id)).enabled, false);
    assert.deepEqual(await repo.listEnabled(SCOPE_A), []);
    assert.equal(await repo.setEnabled(SCOPE_A, created.id, true), true);
    assert.equal((await repo.listEnabled(SCOPE_A)).length, 1);

    assert.equal(await repo.delete(SCOPE_A, created.id), true);
    assert.equal(await repo.get(SCOPE_A, created.id), null);
  });
});

test("listEnabledForAllTenants is a system-wide scan carrying each row's tenant", async () => {
  await withDatabase(async (repo) => {
    await repo.save(SCOPE_A, ruleInput({ name: "a-rule" }), CREATED_BY, T0);
    await repo.save(SCOPE_B, ruleInput({ name: "b-rule" }), "user_alert_b", T0);
    const disabled = await repo.save(SCOPE_A, ruleInput({ name: "a-disabled" }), CREATED_BY, T0);
    await repo.setEnabled(SCOPE_A, disabled.id, false);

    const all = await repo.listEnabledForAllTenants(T0);
    assert.equal(all.length, 2);
    const tenants = new Set(all.map((rule) => `${rule.scope.orgId}:${rule.scope.customerId}`));
    assert.ok(tenants.has(`${ORG_A}:${CUSTOMER_A}`));
    assert.ok(tenants.has(`${ORG_B}:${CUSTOMER_B}`));
    assert.ok(all.every((rule) => rule.enabled));
  });
});

test("recordEvent is gated to the owning tenant's rule and listEvents is scoped", async () => {
  await withDatabase(async (repo) => {
    const rule = await repo.save(SCOPE_A, ruleInput(), CREATED_BY, T0);

    // A record against the wrong tenant scope is rejected.
    await assert.rejects(
      () => repo.recordEvent({
        orgId: ORG_B,
        customerId: CUSTOMER_B,
        ruleId: rule.id,
        observedValue: 5,
        message: "should not persist",
        deliveryState: "queued",
        destinationCount: 1,
      }),
      (error) => error instanceof AlertRuleRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );

    const queued = await repo.recordEvent({
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      ruleId: rule.id,
      observedValue: 5,
      message: "open critical findings breached",
      deliveryState: "queued",
      destinationCount: 2,
    });
    assert.match(queued.id, /^aevt_[a-f0-9]{32}$/u);
    assert.equal(queued.deliveryState, "queued");
    assert.equal(queued.destinationCount, 2);

    await repo.recordEvent({
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      ruleId: rule.id,
      observedValue: 7,
      message: "recorded without a destination",
      deliveryState: "no_destination",
      destinationCount: 0,
    });

    const events = await repo.listEvents(SCOPE_A);
    assert.equal(events.length, 2);
    assert.deepEqual(await repo.listEvents(SCOPE_B), []);
    const states = new Set(events.map((event) => event.deliveryState));
    assert.ok(states.has("queued"));
    assert.ok(states.has("no_destination"));
  });
});
