import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  ScimConnectorRepository,
  ScimResourceRepository,
  validateScimRoleMappings,
} = await import("../db/scim-repository.ts");
const usersRoute = await import("../app/api/scim/v2/Users/route.ts");
const userRoute = await import("../app/api/scim/v2/Users/[resourceId]/route.ts");

const ORG_B = "org_scim_foreign";
const USER_B_ADMIN = "user_scim_foreign_admin";

async function withScimDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-scim-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin({
      email: "scim-owner@sutra.invalid",
      password: "SCIM lifecycle repository passphrase 2026!",
      displayName: "SCIM Owner",
      organizationName: "SCIM Primary",
    }, 1_000);
    const orgA = bootstrap.session.subject.orgId;
    await database.batch([
      database.prepare(
        `INSERT INTO organizations (id, slug, name, status, created_at)
         VALUES (?, 'scim-foreign', 'SCIM Foreign', 'active', 1000)`,
      ).bind(ORG_B),
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status, created_at)
         VALUES (?, 'test', 'foreign-admin', 'foreign-admin@sutra.invalid', 'Foreign Admin', 'active', 1000)`,
      ).bind(USER_B_ADMIN),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status, created_at)
         VALUES ('member_scim_foreign_admin', ?, ?, 'org_admin', 'all_customers', 'active', 1000)`,
      ).bind(ORG_B, USER_B_ADMIN),
    ]);
    const connectorRepository = new ScimConnectorRepository(database);
    const connectorA = await connectorRepository.mint({
      orgId: orgA,
      actorId: bootstrap.session.subject.userId,
      name: "Entra production",
      identityIssuer: "https://sts.windows.net/primary/",
      subjectSource: "userName",
      roleMappings: { "Security Analysts": "analyst" },
      expiresAt: null,
    }, 2_000);
    const connectorB = await connectorRepository.mint({
      orgId: ORG_B,
      actorId: USER_B_ADMIN,
      name: "Okta production",
      identityIssuer: "https://foreign.okta.example",
      subjectSource: "externalId",
      roleMappings: {},
      expiresAt: null,
    }, 2_000);
    await run({
      database,
      orgA,
      bootstrap,
      connectorRepository,
      connectorA,
      connectorB,
      resourcesA: new ScimResourceRepository(await connectorRepository.verify(connectorA.token, 3_000), database),
      resourcesB: new ScimResourceRepository(await connectorRepository.verify(connectorB.token, 3_000), database),
    });
  } finally {
    await miniflare.dispose();
  }
}

test("connector tokens are one-time plaintext, tenant-derived, rotatable, and revocable", async () => {
  await withScimDatabase(async ({
    database,
    orgA,
    connectorRepository,
    connectorA,
    connectorB,
  }) => {
    const stored = await database.prepare(
      `SELECT org_id, token_prefix, token_sha256 FROM scim_connectors WHERE id = ?`,
    ).bind(connectorA.id).first();
    assert.equal(stored.org_id, orgA);
    assert.equal(stored.token_prefix, connectorA.token.slice(0, 20));
    assert.notEqual(stored.token_sha256, connectorA.token);
    assert.equal(stored.token_sha256.length, 64);
    assert.equal((await connectorRepository.verify(connectorA.token, 4_000)).orgId, orgA);
    assert.equal((await connectorRepository.verify(connectorB.token, 4_000)).orgId, ORG_B);

    const rotated = await connectorRepository.rotate(
      orgA,
      "user_scim_rotation_actor",
      connectorA.id,
      5_000,
    );
    await assert.rejects(
      connectorRepository.verify(connectorA.token, 5_001),
      (error) => error?.status === 401,
    );
    assert.equal((await connectorRepository.verify(rotated.token, 5_001)).orgId, orgA);
    assert.equal(await connectorRepository.revoke(orgA, "user_scim_rotation_actor", connectorA.id, 6_000), true);
    await assert.rejects(
      connectorRepository.verify(rotated.token, 6_001),
      (error) => error?.status === 401,
    );
  });
});

test("users and externalIds are connector-isolated across tenants", async () => {
  await withScimDatabase(async ({ resourcesA, resourcesB }) => {
    const alpha = await resourcesA.createUser({
      userName: "alpha@sutra.invalid",
      displayName: "Alpha User",
      externalId: "entra-alpha",
      active: true,
    }, 10_000);
    const foreign = await resourcesB.createUser({
      userName: "foreign@sutra.invalid",
      displayName: "Foreign User",
      externalId: "okta-foreign",
      active: true,
    }, 10_000);
    await assert.rejects(
      resourcesA.getUser(String(foreign.id)),
      (error) => error?.status === 404,
    );
    await assert.rejects(
      resourcesA.createUser({
        userName: "second@sutra.invalid",
        displayName: "Duplicate External",
        externalId: "entra-alpha",
        active: true,
      }, 10_001),
      (error) => error?.status === 409 && error?.scimType === "uniqueness",
    );
    const listed = await resourcesA.listUsers(
      { startIndex: 1, count: 100 },
      { attribute: "externalId", value: "entra-alpha" },
    );
    assert.equal(listed.total, 1);
    assert.equal(listed.resources[0].id, alpha.id);
  });
});

test("active=false suspends the scoped identity and atomically revokes its sessions", async () => {
  await withScimDatabase(async ({ database, orgA, resourcesA }) => {
    const user = await resourcesA.createUser({
      userName: "deactivate@sutra.invalid",
      displayName: "Deactivate Me",
      externalId: "deactivate-1",
      active: true,
    }, 20_000);
    const link = await database.prepare(
      `SELECT user_id FROM scim_user_links WHERE id = ? AND org_id = ?`,
    ).bind(user.id, orgA).first();
    await database.prepare(
      `INSERT INTO local_sessions
        (id, token_digest, user_id, selected_org_id, created_at, expires_at, last_seen_at)
       VALUES ('sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, ?, ?, 20000, 999999, 20000)`,
    ).bind("a".repeat(64), link.user_id, orgA).run();

    const deactivated = await resourcesA.replaceUser(String(user.id), 1, {
      userName: "deactivate@sutra.invalid",
      displayName: "Deactivate Me",
      externalId: "deactivate-1",
      active: false,
    }, 21_000);
    assert.equal(deactivated.active, false);
    const state = await database.prepare(
      `SELECT u.status AS user_status, m.status AS membership_status, s.revoked_at
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
         JOIN local_sessions s ON s.user_id = u.id AND s.selected_org_id = ?
        WHERE u.id = ?`,
    ).bind(orgA, orgA, link.user_id).first();
    assert.deepEqual(state, {
      user_status: "suspended",
      membership_status: "suspended",
      revoked_at: 21_000,
    });
    await assert.rejects(
      database.prepare(`UPDATE scim_audit_events SET outcome = 'denied'`).run(),
      /SCIM audit events are immutable/u,
    );
  });
});

test("group mappings can grant analyst but never an administrator role", async () => {
  assert.throws(
    () => validateScimRoleMappings({ Administrators: "org_admin" }),
    (error) => error?.code === "INVALID_INPUT",
  );
  await withScimDatabase(async ({ database, orgA, resourcesA, resourcesB }) => {
    const alpha = await resourcesA.createUser({
      userName: "analyst@sutra.invalid",
      displayName: "Analyst",
      externalId: "analyst-1",
      active: true,
    }, 30_000);
    const foreign = await resourcesB.createUser({
      userName: "outsider@sutra.invalid",
      displayName: "Outsider",
      externalId: "outsider-1",
      active: true,
    }, 30_000);
    const group = await resourcesA.createGroup({
      displayName: "Security Analysts",
      externalId: "group-analysts",
      memberIds: [String(alpha.id)],
    }, 31_000);
    const role = await database.prepare(
      `SELECT m.role FROM memberships m
         JOIN scim_user_links l ON l.user_id = m.user_id AND l.org_id = m.org_id
        WHERE l.id = ? AND m.org_id = ?`,
    ).bind(alpha.id, orgA).first();
    assert.equal(role.role, "analyst");
    await assert.rejects(
      resourcesA.replaceGroup(String(group.id), 1, {
        displayName: "Security Analysts",
        externalId: "group-analysts",
        memberIds: [String(alpha.id), String(foreign.id)],
      }, 32_000),
      (error) => error?.status === 400,
    );
    await resourcesA.replaceGroup(String(group.id), 1, {
      displayName: "Unmapped Team",
      externalId: "group-analysts",
      memberIds: [String(alpha.id)],
    }, 33_000);
    const downgraded = await database.prepare(
      `SELECT m.role FROM memberships m
         JOIN scim_user_links l ON l.user_id = m.user_id AND l.org_id = m.org_id
        WHERE l.id = ? AND m.org_id = ?`,
    ).bind(alpha.id, orgA).first();
    assert.equal(downgraded.role, "viewer");
  });
});

test("the HTTP SCIM surface enforces bearer auth, media type, filters, patches, and ETags", async () => {
  await withScimDatabase(async ({ connectorA }) => {
    const unauthorized = await usersRoute.GET(new Request("https://sutra.invalid/api/scim/v2/Users"));
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("content-type"), "application/scim+json");
    assert.match(unauthorized.headers.get("www-authenticate"), /Bearer/u);

    const wrongMedia = await usersRoute.POST(new Request("https://sutra.invalid/api/scim/v2/Users", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connectorA.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    }));
    assert.equal(wrongMedia.status, 415);
    assert.equal(wrongMedia.headers.get("content-type"), "application/scim+json");

    const createdResponse = await usersRoute.POST(new Request("https://sutra.invalid/api/scim/v2/Users", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connectorA.token}`,
        "content-type": "application/scim+json",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "http-user-1",
        userName: "http-user@sutra.invalid",
        displayName: "HTTP User",
        active: true,
      }),
    }));
    const createdBody = await createdResponse.clone().json();
    assert.equal(createdResponse.status, 201, JSON.stringify(createdBody));
    assert.equal(createdResponse.headers.get("content-type"), "application/scim+json");
    assert.equal(createdResponse.headers.get("etag"), 'W/"1"');
    const created = createdBody;

    const filtered = await usersRoute.GET(new Request(
      "https://sutra.invalid/api/scim/v2/Users?filter=userName%20eq%20%22http-user%40sutra.invalid%22&startIndex=1&count=1",
      { headers: { authorization: `Bearer ${connectorA.token}` } },
    ));
    assert.equal(filtered.status, 200);
    assert.equal((await filtered.json()).totalResults, 1);

    const context = { params: Promise.resolve({ resourceId: created.id }) };
    const patched = await userRoute.PATCH(new Request(
      `https://sutra.invalid/api/scim/v2/Users/${created.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${connectorA.token}`,
          "content-type": "application/scim+json",
          "if-match": 'W/"1"',
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "Replace", path: "active", value: false }],
        }),
      },
    ), context);
    assert.equal(patched.status, 200);
    assert.equal(patched.headers.get("etag"), 'W/"2"');
    assert.equal((await patched.json()).active, false);

    const stale = await userRoute.PATCH(new Request(
      `https://sutra.invalid/api/scim/v2/Users/${created.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${connectorA.token}`,
          "content-type": "application/scim+json",
          "if-match": 'W/"1"',
        },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "Replace", path: "active", value: true }],
        }),
      },
    ), context);
    assert.equal(stale.status, 412);
    assert.equal((await stale.json()).scimType, "mutability");

    const unbounded = await usersRoute.GET(new Request(
      "https://sutra.invalid/api/scim/v2/Users?count=101",
      { headers: { authorization: `Bearer ${connectorA.token}` } },
    ));
    assert.equal(unbounded.status, 400);
    assert.equal((await unbounded.json()).scimType, "invalidValue");
  });
});
