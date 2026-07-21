import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const authRepo = await import("../db/auth-repository.ts");
const invitationRepo = await import("../db/identity-invitation-repository.ts");
const authPolicy = await import("../lib/auth-policy.ts");

// INFO-2: self-serve signup abuse controls — a durable per-source-IP rate limit
// and an OPTIONAL verified-email domain allowlist — apply ONLY to the create-
// new-org path, never to invited-join or an existing-identity login.

const GOOGLE = "https://accounts.google.com";
const ENTRA = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0";

const root = resolve(import.meta.dirname, "..");
const signupRateLimitSchema = (await readFile(resolve(root, "drizzle/0048_hosted_signup_rate_limits.sql"), "utf8"))
  .split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

const NOW = 1_700_000_000_000;

function identity(overrides) {
  return {
    issuer: GOOGLE,
    subject: "subject-default",
    email: "person@example.com",
    displayName: "Federated Person",
    authenticatedAt: NOW,
    expiresAt: NOW + 15 * 60 * 1000,
    ...overrides,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-abuse-${crypto.randomUUID()}` },
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

test("the per-source rate limit blocks the Nth+1 signup from an IP within the window", async () => {
  await withDatabase(async () => {
    const options = { sourceKey: "203.0.113.7", maxSignupsPerWindow: 3, now: NOW };
    // Three DISTINCT identities from the same IP each get their own new org.
    for (let index = 0; index < 3; index += 1) {
      const result = await authRepo.provisionSelfServeHostedOrg(
        identity({ subject: `sub-${index}`, email: `user${index}@example.com` }),
        options,
      );
      assert.match(result.session.subject.orgId, /^org_[a-f0-9]{32}$/u);
    }
    // The 4th signup from the SAME IP in the SAME window is refused (deny-by-default).
    await assert.rejects(
      authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-3", email: "user3@example.com" }), options),
      (error) => error?.code === "SIGNUP_RATE_LIMITED" && error?.status === 429,
    );
    // A DIFFERENT source IP has its own independent budget.
    const other = await authRepo.provisionSelfServeHostedOrg(
      identity({ subject: "sub-other", email: "other@example.com" }),
      { sourceKey: "198.51.100.4", maxSignupsPerWindow: 3, now: NOW },
    );
    assert.match(other.session.subject.orgId, /^org_[a-f0-9]{32}$/u);
  });
});

test("the domain allowlist refuses a non-listed domain and permits a listed one", async () => {
  await withDatabase(async () => {
    const base = { sourceKey: "203.0.113.20", allowedEmailDomains: ["corp.example"], now: NOW };
    // A verified email on the allowlisted domain is provisioned.
    const allowed = await authRepo.provisionSelfServeHostedOrg(
      identity({ subject: "sub-ok", email: "founder@corp.example" }),
      base,
    );
    assert.match(allowed.session.subject.orgId, /^org_[a-f0-9]{32}$/u);
    // An email whose domain is NOT on the list is refused, no org is created.
    await assert.rejects(
      authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-bad", email: "intruder@evil.example" }), base),
      (error) => error?.code === "SIGNUP_DOMAIN_NOT_ALLOWED" && error?.status === 403,
    );
    // With NO allowlist (null), any verified domain is permitted (default behaviour).
    const unrestricted = await authRepo.provisionSelfServeHostedOrg(
      identity({ subject: "sub-any", email: "anyone@anywhere.example" }),
      { sourceKey: "203.0.113.21", now: NOW },
    );
    assert.match(unrestricted.session.subject.orgId, /^org_[a-f0-9]{32}$/u);
  });
});

test("invited-join is unaffected by the signup rate limit AND the domain allowlist", async () => {
  await withDatabase(async () => {
    // Exhaust the self-serve budget for the owner's IP entirely.
    const ownerOptions = { sourceKey: "203.0.113.30", maxSignupsPerWindow: 1, now: NOW };
    const owner = await authRepo.provisionSelfServeHostedOrg(
      identity({ subject: "sub-owner", email: "owner@corp.example" }),
      ownerOptions,
    );
    await assert.rejects(
      authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-x", email: "x@corp.example" }), ownerOptions),
      (error) => error?.code === "SIGNUP_RATE_LIMITED",
    );

    // The owner invites a user whose domain would NOT pass a self-serve allowlist.
    const scope = authPolicy.resolveMembershipManagementScope(owner.session.subject);
    const { token } = await invitationRepo.createIdentityInvitation(owner.session, scope, {
      email: "invitee@outside.example",
      role: "analyst",
      scopeMode: "all_customers",
      lifetimeMs: 2 * 60 * 60 * 1000,
    });
    // Accepting the invitation joins the owner's org regardless of the rate limit
    // or any domain allowlist — the invited-join path never touches either gate.
    // The invitee identity is validated against the real clock by accept/login,
    // so give it current-time validity (the fixed NOW above only drives the
    // rate-limit window for provisioning).
    const nowReal = Date.now();
    const invitee = identity({
      issuer: ENTRA,
      subject: "sub-invitee",
      email: "invitee@outside.example",
      authenticatedAt: nowReal,
      expiresAt: nowReal + 15 * 60 * 1000,
    });
    const accepted = await invitationRepo.acceptIdentityInvitation(invitee, token);
    assert.equal(accepted.session.subject.orgId, owner.session.subject.orgId);
    assert.equal(accepted.session.subject.role, "analyst");
  });
});

test("a self-serve signup fails CLOSED when the durable counter table is absent", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-abuse-notable-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    // The migration is now registered, so ensureRuntimeSchema creates the table.
    // Drop it to genuinely simulate the durable counter being unavailable, and
    // assert self-serve signup fails CLOSED rather than proceeding un-throttled.
    await database.prepare("DROP TABLE IF EXISTS hosted_signup_rate_limits").run();
    await assert.rejects(
      authRepo.provisionSelfServeHostedOrg(identity({ subject: "sub-notable", email: "notable@example.com" }), {
        sourceKey: "203.0.113.99",
        now: NOW,
      }),
      (error) => error?.code === "SIGNUP_RATE_LIMITED",
    );
  } finally {
    await miniflare.dispose();
  }
});
