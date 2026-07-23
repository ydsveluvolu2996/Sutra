import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const sessions = await import("../db/session-administration-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const ORG_B = "org_switch_b";
const ORG_C = "org_switch_c";
// A single consistent clock for the whole flow: the session is created at NOW
// and switched at NOW, so the "expires_at > now" guard on the session holds.
const NOW = Date.now();

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-switch-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin({
      email: "switch-owner@sutra.invalid",
      password: "Membership switching passphrase 2026!",
      displayName: "Switch Owner",
      organizationName: "Switch Home",
    }, NOW);
    const actor = bootstrap.session;
    const token = bootstrap.token;
    const userId = actor.subject.userId;
    const orgA = actor.subject.orgId;
    await database.batch([
      // A second org the user DOES belong to.
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'switch-b', 'Switch B', 'active')").bind(ORG_B),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES ('mem_switch_b', ?, ?, 'org_admin', 'all_customers', 'active')`,
      ).bind(ORG_B, userId),
      // A third org the user is NOT a member of.
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'switch-c', 'Switch C', 'active')").bind(ORG_C),
    ]);
    await run({ database, actor, orgA, token });
  } finally {
    await miniflare.dispose();
  }
}

async function selectedOrg(database, sessionId) {
  const row = await database.prepare("SELECT selected_org_id FROM local_sessions WHERE id = ?").bind(sessionId).first();
  return row?.selected_org_id ?? null;
}

async function switchAuditCount(database, orgId) {
  const row = await database
    .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ? AND action = 'auth.session.org_switched'")
    .bind(orgId)
    .first();
  return Number(row?.n ?? 0);
}

test("cannot switch to an organization the user does not belong to", async () => {
  await withDatabase(async ({ database, actor, orgA }) => {
    await assert.rejects(
      () => sessions.switchActiveOrganization(actor, ORG_C, NOW),
      (error) => error?.code === "AUTHORIZATION_DENIED" && error?.status === 403,
    );
    assert.equal(await selectedOrg(database, actor.session.id), orgA, "active org is unchanged");
    assert.equal(await switchAuditCount(database, ORG_C), 0, "no audit row is written to the foreign org");
  });
});

test("switching to a member org moves the active org and audits the target chain", async () => {
  await withDatabase(async ({ database, actor, orgA }) => {
    const result = await sessions.switchActiveOrganization(actor, ORG_B, NOW);
    assert.deepEqual(result, { switched: true });
    assert.equal(await selectedOrg(database, actor.session.id), ORG_B, "active org moved to B");
    assert.equal(await switchAuditCount(database, ORG_B), 1, "exactly one switch audit row on the target chain");
    assert.equal(await switchAuditCount(database, orgA), 0, "no audit row on the source chain");
    const meta = await database
      .prepare("SELECT metadata_json FROM audit_events WHERE org_id = ? AND action = 'auth.session.org_switched'")
      .bind(ORG_B)
      .first();
    const parsed = JSON.parse(meta.metadata_json);
    assert.equal(parsed.fromOrgId, orgA);
    assert.equal(parsed.toOrgId, ORG_B);
  });
});

test("switching to the already-active org is an idempotent no-op", async () => {
  await withDatabase(async ({ database, actor, orgA }) => {
    const result = await sessions.switchActiveOrganization(actor, orgA, NOW);
    assert.deepEqual(result, { switched: false });
    assert.equal(await switchAuditCount(database, orgA), 0, "a no-op writes no audit row");
  });
});

test("the session reports every active membership for the switcher", async () => {
  await withDatabase(async ({ actor, token }) => {
    // Re-read the session after the second membership was granted (the bootstrap
    // snapshot predates it) — availableOrganizations is derived per request.
    const refreshed = await auth.getLocalSession(token, NOW);
    assert.notEqual(refreshed, null);
    const orgs = refreshed.session.availableOrganizations.map((entry) => entry.id).sort();
    assert.ok(orgs.includes(ORG_B), "the second membership is listed");
    assert.ok(orgs.includes(actor.subject.orgId), "the active org is listed");
    assert.ok(!orgs.includes(ORG_C), "an org the user does not belong to is never listed");
  });
});
