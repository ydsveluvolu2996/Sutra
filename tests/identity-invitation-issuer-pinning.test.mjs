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

// LOW-2: an invitation can be PINNED to a specific issuer/provider at create
// time; an identity from a different issuer can never accept it, even with the
// right token and email. Unpinned invitations behave exactly as before.

const GOOGLE = "https://accounts.google.com";
const ENTRA = "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0";

const root = resolve(import.meta.dirname, "..");
const signupRateLimitSchema = (await readFile(resolve(root, "drizzle/0048_hosted_signup_rate_limits.sql"), "utf8"))
  .split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

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

async function withOwnerAndScope(database, run) {
  const owner = await authRepo.provisionSelfServeHostedOrg(
    identity({ subject: "sub-owner", email: "owner@corp.example" }),
    { sourceKey: "owner-source" },
  );
  const scope = authPolicy.resolveMembershipManagementScope(owner.session.subject);
  await run(owner, scope);
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-invite-pin-${crypto.randomUUID()}` },
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

test("an issuer-pinned invitation cannot be accepted by an identity from a different issuer", async () => {
  await withDatabase(async (database) => {
    await withOwnerAndScope(database, async (owner, scope) => {
      const { token } = await invitationRepo.createIdentityInvitation(owner.session, scope, {
        email: "invitee@corp.example",
        role: "analyst",
        scopeMode: "all_customers",
        lifetimeMs: 2 * 60 * 60 * 1000,
        allowedIssuer: GOOGLE, // pinned to Google
      });
      // An identity from a DIFFERENT issuer (Entra), with the correct token and
      // the correct email, is refused with a MISMATCH — never joins the org.
      await assert.rejects(
        invitationRepo.acceptIdentityInvitation(
          identity({ issuer: ENTRA, subject: "sub-wrong-idp", email: "invitee@corp.example" }),
          token,
        ),
        (error) => error?.code === "IDENTITY_ISSUER_MISMATCH" && error?.status === 401,
      );
      // The invitation is still pending (the failed accept did not consume it): the
      // identity from the PINNED issuer accepts successfully.
      const accepted = await invitationRepo.acceptIdentityInvitation(
        identity({ issuer: GOOGLE, subject: "sub-right-idp", email: "invitee@corp.example" }),
        token,
      );
      assert.equal(accepted.session.subject.orgId, owner.session.subject.orgId);
      assert.equal(accepted.session.subject.role, "analyst");
    });
  });
});

test("an UNPINNED invitation still accepts from any issuer (invited-join unchanged)", async () => {
  await withDatabase(async (database) => {
    await withOwnerAndScope(database, async (owner, scope) => {
      const { token } = await invitationRepo.createIdentityInvitation(owner.session, scope, {
        email: "anyone@corp.example",
        role: "viewer",
        scopeMode: "all_customers",
        lifetimeMs: 2 * 60 * 60 * 1000,
        // no allowedIssuer => unpinned
      });
      const accepted = await invitationRepo.acceptIdentityInvitation(
        identity({ issuer: ENTRA, subject: "sub-any-idp", email: "anyone@corp.example" }),
        token,
      );
      assert.equal(accepted.session.subject.orgId, owner.session.subject.orgId);
      assert.equal(accepted.session.subject.role, "viewer");
    });
  });
});

test("a malformed issuer pin is refused at create time", async () => {
  await withDatabase(async (database) => {
    await withOwnerAndScope(database, async (owner, scope) => {
      await assert.rejects(
        invitationRepo.createIdentityInvitation(owner.session, scope, {
          email: "invitee@corp.example",
          role: "analyst",
          scopeMode: "all_customers",
          lifetimeMs: 2 * 60 * 60 * 1000,
          allowedIssuer: "http://accounts.google.com", // non-HTTPS
        }),
        (error) => error?.code === "INVALID_INPUT" && error?.status === 400,
      );
    });
  });
});
