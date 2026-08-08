import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const root = resolve(import.meta.dirname, "..");
// The signup rate-limit table ships as an unregistered migration (drizzle 0048,
// parent registers). Apply it here so provisionSelfServeHostedOrg's durable
// per-source counter is exercised end to end.
const signupRateLimitSchema = (await readFile(resolve(root, "drizzle/0048_hosted_signup_rate_limits.sql"), "utf8"))
  .split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const authRepo = await import("../db/auth-repository.ts");
const invitationRepo = await import("../db/identity-invitation-repository.ts");
const authPolicy = await import("../lib/auth-policy.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { getPortfolio } = await import("../db/portfolio-repository.ts");
const hostedRuntime = await import("../lib/hosted-oidc-runtime.ts");

const GOOGLE = "https://accounts.google.com";
const ENTRA = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0";

function identity(overrides) {
  const now = Date.now();
  return {
    issuer: GOOGLE,
    subject: "subject-default",
    email: "person@example.com",
    displayName: "Federated Person",
    authenticatedAt: now,
    expiresAt: now + 15 * 60 * 1000,
    ...overrides,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-self-serve-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    for (const statement of signupRateLimitSchema) await database.prepare(statement).run();
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function seedConnectionResource(database, orgId) {
  const now = Date.now();
  const customerId = `cust_${crypto.randomUUID().replaceAll("-", "")}`;
  const connectionId = `conn_${crypto.randomUUID().replaceAll("-", "")}`;
  const syncRunId = `sync_${crypto.randomUUID().replaceAll("-", "")}`;
  const snapshotId = `snap_${crypto.randomUUID().replaceAll("-", "")}`;
  const accountId = "444455556666";
  await database.batch([
    database.prepare(
      "INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).bind(customerId, orgId, "victim-customer", "Victim Customer", now, now),
    database.prepare(
      `INSERT INTO aws_connections
        (id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
         external_id_ciphertext, external_id_key_version, permission_pack_version,
         status, enabled_regions_json, created_at, updated_at)
       VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, ?, 'test-key-v1', ?, 'active', '["us-east-1"]', ?, ?)`,
    ).bind(
      connectionId, orgId, customerId, accountId,
      `arn:aws:iam::${accountId}:role/sutra/SutraReadOnlyRole`,
      "ciphertext-not-a-real-secret", pilotRepository.CURRENT_PILOT_PERMISSION_PACK, now, now,
    ),
    database.prepare(
      `INSERT INTO sync_runs
        (id, org_id, customer_id, connection_id, trigger_kind, status, coverage_state,
         collector_pack_version, totals_json, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, 'manual', 'succeeded', 'complete', 'test', '{}', ?, ?)`,
    ).bind(syncRunId, orgId, customerId, connectionId, "self-serve-isolation", now),
    database.prepare(
      `INSERT INTO cmdb_snapshots
        (id, org_id, customer_id, connection_id, sync_run_id, status, collected_at,
         completed_at, coverage_json, summary_json, snapshot_sha256, origin_kind)
       VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, '[]', '{}', ?, 'live_aws')`,
    ).bind(snapshotId, orgId, customerId, connectionId, syncRunId, now, now, "b".repeat(64)),
    database.prepare(
      `INSERT INTO connection_heads (connection_id, org_id, customer_id, snapshot_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(connectionId, orgId, customerId, snapshotId, now),
    database.prepare(
      `INSERT INTO cmdb_resources
        (id, snapshot_id, org_id, customer_id, connection_id, resource_key, provider_key,
         service, resource_type, native_id, name, region_key, state, tags_json,
         configuration_json, source_json, content_sha256, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, 'aws', 'ec2', 'ec2.instance', 'i-victim', 'victim', 'us-east-1',
               'running', '{}', '{}', ?, ?, ?)`,
    ).bind(
      `res_${crypto.randomUUID().replaceAll("-", "")}`, snapshotId, orgId, customerId, connectionId,
      `aws:ec2:us-east-1:${accountId}:instance/i-victim`,
      JSON.stringify({ api: "EC2.DescribeInstances", accountId, collectedAt: new Date(now).toISOString() }),
      "c".repeat(64), now,
    ),
  ]);
  return { customerId, connectionId };
}

test("a brand-new verified identity is provisioned into its OWN new org as sole owner", async () => {
  await withDatabase(async () => {
    const id = identity({ subject: "google-owner-1", email: "owner1@example.com" });
    const { session } = await authRepo.provisionSelfServeHostedOrg(id);
    assert.match(session.subject.orgId, /^org_[a-f0-9]{32}$/u);
    assert.equal(session.subject.role, "org_owner");
    assert.equal(session.subject.scopeMode, "all_customers");
    assert.deepEqual(session.subject.grants, []);
    // A self-serve org is born on the trial plan, and the session carries it so
    // the UI can render the trial badge without a second lookup. Provisioned
    // (invited/bootstrap) orgs stay 'standard' by column default.
    assert.equal(session.session.organization.plan, "trial");
    // A subsequent normal login for the SAME identity resolves to that same org.
    const relogin = await authRepo.loginHostedUser(id);
    assert.equal(relogin.session.subject.orgId, session.subject.orgId);
    assert.equal(relogin.session.subject.userId, session.subject.userId);
    assert.equal(relogin.session.session.organization.plan, "trial");
  });
});

test("two distinct identities receive two distinct orgs; same email on a different issuer is a different identity", async () => {
  await withDatabase(async () => {
    const a = await authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-a", email: "shared@corp.example" }));
    const b = await authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-b", email: "different@corp.example" }));
    assert.notEqual(a.session.subject.orgId, b.session.subject.orgId);
    assert.notEqual(a.session.subject.userId, b.session.subject.userId);
    // Same email as A, but a DIFFERENT provider (issuer) => a different identity,
    // so it gets its OWN new org and never joins A's org.
    const crossProvider = await authRepo.provisionSelfServeHostedOrg(
      identity({ issuer: ENTRA, subject: "sub-a", email: "shared@corp.example" }),
    );
    assert.notEqual(crossProvider.session.subject.orgId, a.session.subject.orgId);
  });
});

test("self-serve NEVER lets a new identity join or read an existing org", async () => {
  await withDatabase(async () => {
    const owner = await authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-owner", email: "owner@corp.example" }));
    const ownerOrg = owner.session.subject.orgId;
    // loginHostedUser matches on the FULL (issuer, subject, email); a different
    // subject with the SAME issuer+email is NOT the owner and is refused, never
    // silently mapped into the owner's org.
    await assert.rejects(
      authRepo.loginHostedUser(identity({ issuer: GOOGLE, subject: "sub-impostor", email: "owner@corp.example" })),
      (error) => error?.code === "IDENTITY_NOT_PROVISIONED",
    );
    // Self-serve for an identity that collides on the (issuer, email) unique key
    // (same issuer+email, different subject) fails closed rather than minting a
    // second org or joining the owner's org.
    await assert.rejects(
      authRepo.provisionSelfServeHostedOrg(identity({ issuer: GOOGLE, subject: "sub-impostor", email: "owner@corp.example" })),
      (error) => error?.code === "IDENTITY_NOT_PROVISIONED",
    );
    // The owner's org still has exactly one active membership (the owner).
    const memberships = await cloudflare.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active'",
    ).bind(ownerOrg).first();
    assert.equal(Number(memberships.n), 1);
  });
});

test("an invited join still binds to the PRE-CREATED org and is unchanged by self-serve", async () => {
  await withDatabase(async () => {
    const owner = await authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-host", email: "host@corp.example" }));
    const scope = authPolicy.resolveMembershipManagementScope(owner.session.subject);
    assert.deepEqual(scope, { mode: "org" });
    const { token } = await invitationRepo.createIdentityInvitation(owner.session, scope, {
      email: "invitee@corp.example",
      role: "analyst",
      scopeMode: "all_customers",
      lifetimeMs: 2 * 60 * 60 * 1000,
    });
    const invitee = identity({ issuer: ENTRA, subject: "sub-invitee", email: "invitee@corp.example" });
    const accepted = await invitationRepo.acceptIdentityInvitation(invitee, token);
    // The invited identity lands in the OWNER's org (the pre-created one) with
    // exactly the invitation's role — the only path that joins an existing org.
    assert.equal(accepted.session.subject.orgId, owner.session.subject.orgId);
    assert.equal(accepted.session.subject.role, "analyst");
    // The same token cannot be reused (single-use).
    await assert.rejects(invitationRepo.acceptIdentityInvitation(invitee, token));
  });
});

test("org A's self-serve session cannot read org B's connection, cmdb, or portfolio", async () => {
  await withDatabase(async (database) => {
    const a = await authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-a", email: "a@corp.example" }));
    const b = await authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-b", email: "b@corp.example" }));
    const orgA = a.session.subject.orgId;
    const orgB = b.session.subject.orgId;
    const victim = await seedConnectionResource(database, orgB);

    // Central authorization gate: A's subject can never authorize against B.
    assert.deepEqual(
      authPolicy.authorize(a.session.subject, { orgId: orgB, capability: "workspace:read" }),
      { allowed: false, reason: "CROSS_ORG" },
    );
    // Connection + trust secret lookups are org-scoped: A cannot resolve B's.
    assert.equal(await pilotRepository.getConnectionForOrg(orgA, victim.connectionId), null);
    await assert.rejects(
      pilotRepository.getStoredConnectionSecretForOrg(orgA, victim.connectionId),
      (error) => error?.code === "NOT_FOUND",
    );
    // CMDB state for A is empty; B's seeded resource never leaks across.
    const stateA = await pilotRepository.getPilotStateForOrg(orgA);
    assert.equal(stateA.connection, null);
    assert.deepEqual(stateA.resources, []);
    // Portfolio aggregation is scoped to A's own (empty) org.
    const portfolioA = await getPortfolio(a.session.subject);
    assert.equal(portfolioA.organizationId, orgA);
    assert.deepEqual(portfolioA.customers, []);
    // B, by contrast, sees its own connection.
    assert.equal(
      (await pilotRepository.getConnectionForOrg(orgB, victim.connectionId))?.id,
      victim.connectionId,
    );
  });
});

test("the self-serve signup switch is OFF unless it is exactly \"true\"", async () => {
  const original = cloudflare.env.SUTRA_HOSTED_SELF_SERVE_SIGNUP;
  try {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true", "true "]) {
      if (value === undefined) delete cloudflare.env.SUTRA_HOSTED_SELF_SERVE_SIGNUP;
      else cloudflare.env.SUTRA_HOSTED_SELF_SERVE_SIGNUP = value;
      assert.equal(hostedRuntime.isHostedSelfServeSignupEnabled(), false, `${JSON.stringify(value)} must keep signup OFF`);
    }
    cloudflare.env.SUTRA_HOSTED_SELF_SERVE_SIGNUP = "true";
    assert.equal(hostedRuntime.isHostedSelfServeSignupEnabled(), true);
  } finally {
    if (original === undefined) delete cloudflare.env.SUTRA_HOSTED_SELF_SERVE_SIGNUP;
    else cloudflare.env.SUTRA_HOSTED_SELF_SERVE_SIGNUP = original;
  }
});
