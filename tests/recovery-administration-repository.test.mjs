import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const pilot = await import("../db/pilot-repository.ts");
const recovery = await import("../db/recovery-administration-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const TARGET_USER = `user_${"a".repeat(32)}`;
const TARGET_MEMBERSHIP = `member_${"a".repeat(32)}`;
const SECOND_USER = `user_${"b".repeat(32)}`;
const SECOND_MEMBERSHIP = `member_${"b".repeat(32)}`;
const FOREIGN_ORG = "org_recovery_foreign";
const FOREIGN_USER = `user_${"c".repeat(32)}`;
const FOREIGN_MEMBERSHIP = `member_${"c".repeat(32)}`;

function operationId(hexChar) {
  return `rec_${hexChar.repeat(32)}`;
}

function actorLike({ role, userId, membershipId, orgId }) {
  return {
    tokenDigest: "digest",
    mfaVerifiedAt: 1,
    subject: { userId, orgId, membershipId, role, scopeMode: "all_customers", grants: [] },
    session: {},
  };
}

async function headHash(database, orgId) {
  const row = await database.prepare(
    `SELECT event_hash FROM audit_events WHERE org_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`,
  ).bind(orgId).first();
  return row?.event_hash ?? null;
}

async function auditCount(database, orgId, action) {
  const row = await database.prepare(
    `SELECT COUNT(*) AS count FROM audit_events WHERE org_id = ? AND action = ?`,
  ).bind(orgId, action).first();
  return Number(row?.count ?? 0);
}

async function seedTotp(database, userId, now = 1000) {
  await database.prepare(
    `INSERT INTO totp_credentials
       (user_id, secret_ciphertext, secret_key_version, confirmed_at, last_used_step, created_at, updated_at)
     VALUES (?, 'ciphertext', 'local-auth-v1', ?, 1, ?, ?)`,
  ).bind(userId, now, now, now).run();
}

async function seedSession(database, id, userId, orgId, now = 1000) {
  await database.prepare(
    `INSERT INTO local_sessions
       (id, token_digest, user_id, selected_org_id, created_at, expires_at, last_seen_at, mfa_verified_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(id, `digest_${id}`, userId, orgId, now, now + 60 * 60 * 1000, now).run();
}

async function withRecoveryDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-recovery-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const bootstrap = await auth.bootstrapLocalAdmin({
      email: "recovery-owner@sutra.invalid",
      password: "Recovery administration repository passphrase 2026!",
      displayName: "Recovery Owner",
      organizationName: "Recovery Test",
    }, 1000);
    const owner = bootstrap.session;
    const orgId = owner.subject.orgId;
    await database.batch([
      // Active local member missing their MFA / locked out.
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES (?, 'sutra-local', 'recovery-target', 'target@sutra.invalid', 'Recovery Target', 'active')`,
      ).bind(TARGET_USER),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES (?, ?, ?, 'analyst', 'assigned_customers', 'active')`,
      ).bind(TARGET_MEMBERSHIP, orgId, TARGET_USER),
      database.prepare(
        `INSERT INTO local_password_credentials
           (user_id, algorithm, iterations, salt, password_hash, failed_attempts, locked_until, changed_at, updated_at)
         VALUES (?, 'pbkdf2-sha256', 200000, 'salt', 'hash', 4, 9999999999999, 1000, 1000)`,
      ).bind(TARGET_USER),
      // Second active member used for owner provisioning / transfer.
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES (?, 'sutra-local', 'recovery-second', 'second@sutra.invalid', 'Recovery Second', 'active')`,
      ).bind(SECOND_USER),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES (?, ?, ?, 'org_admin', 'assigned_customers', 'active')`,
      ).bind(SECOND_MEMBERSHIP, orgId, SECOND_USER),
      database.prepare(
        `INSERT INTO customers (id, org_id, slug, name, status)
         VALUES ('cust_recovery_alpha', ?, 'recovery-alpha', 'Recovery Alpha', 'active')`,
      ).bind(orgId),
      database.prepare(
        `INSERT INTO customer_access (id, org_id, customer_id, membership_id, role, created_at)
         VALUES ('access_recovery_alpha', ?, 'cust_recovery_alpha', ?, 'viewer', 1000)`,
      ).bind(orgId, SECOND_MEMBERSHIP),
      // Foreign organization + local owner used for cross-org isolation.
      database.prepare(
        `INSERT INTO organizations (id, slug, name, status)
         VALUES (?, 'recovery-foreign', 'Foreign organization', 'active')`,
      ).bind(FOREIGN_ORG),
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name, status)
         VALUES (?, 'sutra-local', 'recovery-foreign', 'foreign@sutra.invalid', 'Foreign', 'active')`,
      ).bind(FOREIGN_USER),
      database.prepare(
        `INSERT INTO memberships (id, org_id, user_id, role, scope_mode, status)
         VALUES (?, ?, ?, 'org_owner', 'all_customers', 'active')`,
      ).bind(FOREIGN_MEMBERSHIP, FOREIGN_ORG, FOREIGN_USER),
    ]);
    await seedTotp(database, TARGET_USER);
    await seedTotp(database, FOREIGN_USER);
    await seedSession(database, `sess_${"a".repeat(32)}`, TARGET_USER, orgId);
    await run({ database, owner, orgId });
  } finally {
    await miniflare.dispose();
  }
}

test("owner MFA recovery resets credentials and links one audit event, minting no session", async () => {
  await withRecoveryDatabase(async ({ database, owner, orgId }) => {
    await pilot.appendAuditEvent({
      orgId,
      actorId: owner.subject.userId,
      action: "recovery.test.seed",
      targetType: "test",
      targetId: null,
      customerId: null,
      outcome: "allowed",
      metadata: {},
    });
    const previousHead = await headHash(database, orgId);
    assert.equal(typeof previousHead, "string");

    const sessionsBefore = await database.prepare(
      `SELECT COUNT(*) AS count FROM local_sessions WHERE user_id = ?`,
    ).bind(TARGET_USER).first();

    await recovery.recoverMemberMfa(owner, { targetUserId: TARGET_USER, operationId: operationId("a") }, 5000);

    const totp = await database.prepare(
      `SELECT COUNT(*) AS count FROM totp_credentials WHERE user_id = ?`,
    ).bind(TARGET_USER).first();
    assert.equal(Number(totp?.count ?? -1), 0);

    const session = await database.prepare(
      `SELECT revoked_at, mfa_verified_at FROM local_sessions WHERE user_id = ?`,
    ).bind(TARGET_USER).first();
    assert.equal(session?.revoked_at, 5000);
    assert.equal(session?.mfa_verified_at, null);

    const sessionsAfter = await database.prepare(
      `SELECT COUNT(*) AS count FROM local_sessions WHERE user_id = ?`,
    ).bind(TARGET_USER).first();
    assert.equal(Number(sessionsAfter?.count), Number(sessionsBefore?.count));

    const lock = await database.prepare(
      `SELECT failed_attempts, locked_until FROM local_password_credentials WHERE user_id = ?`,
    ).bind(TARGET_USER).first();
    assert.equal(Number(lock?.failed_attempts), 0);
    assert.equal(lock?.locked_until, null);

    const row = await database.prepare(
      `SELECT actor_type, actor_id, target_id, previous_event_hash, event_hash
         FROM audit_events WHERE org_id = ? AND action = 'auth.recovery.mfa_reset'`,
    ).bind(orgId).first();
    assert.equal(row?.actor_type, "user");
    assert.equal(row?.actor_id, owner.subject.userId);
    assert.equal(row?.target_id, TARGET_USER);
    assert.equal(row?.previous_event_hash, previousHead);
    assert.match(String(row?.event_hash), /^[a-f0-9]{64}$/u);
  });
});

test("non-owner actors are refused recovery with no mutation and no audit", async () => {
  await withRecoveryDatabase(async ({ database, orgId }) => {
    for (const role of ["org_admin", "analyst"]) {
      const actor = actorLike({
        role,
        userId: `user_${"d".repeat(32)}`,
        membershipId: `member_${"d".repeat(32)}`,
        orgId,
      });
      await assert.rejects(
        recovery.recoverMemberMfa(actor, { targetUserId: TARGET_USER, operationId: operationId("a") }),
        (error) => error?.status === 403 && error?.code === "AUTHORIZATION_DENIED",
      );
    }
    const totp = await database.prepare(
      `SELECT COUNT(*) AS count FROM totp_credentials WHERE user_id = ?`,
    ).bind(TARGET_USER).first();
    assert.equal(Number(totp?.count), 1);
    assert.equal(await auditCount(database, orgId, "auth.recovery.mfa_reset"), 0);
  });
});

test("cross-org target resolves to 404 and leaves the foreign account untouched", async () => {
  await withRecoveryDatabase(async ({ database, owner, orgId }) => {
    await assert.rejects(
      recovery.recoverMemberMfa(owner, { targetUserId: FOREIGN_USER, operationId: operationId("a") }),
      (error) => error?.status === 404,
    );
    const totp = await database.prepare(
      `SELECT COUNT(*) AS count FROM totp_credentials WHERE user_id = ?`,
    ).bind(FOREIGN_USER).first();
    assert.equal(Number(totp?.count), 1);
    assert.equal(await auditCount(database, orgId, "auth.recovery.mfa_reset"), 0);
    assert.equal(await auditCount(database, FOREIGN_ORG, "auth.recovery.mfa_reset"), 0);
  });
});

test("provision_owner sets owner role/scope and clears the membership's customer access", async () => {
  await withRecoveryDatabase(async ({ database, owner, orgId }) => {
    await recovery.provisionOwner(owner, { targetMembershipId: SECOND_MEMBERSHIP, operationId: operationId("b") });
    const membership = await database.prepare(
      `SELECT role, scope_mode, status FROM memberships WHERE id = ? AND org_id = ?`,
    ).bind(SECOND_MEMBERSHIP, orgId).first();
    assert.equal(membership?.role, "org_owner");
    assert.equal(membership?.scope_mode, "all_customers");
    assert.equal(membership?.status, "active");
    const grants = await database.prepare(
      `SELECT COUNT(*) AS count FROM customer_access WHERE org_id = ? AND membership_id = ?`,
    ).bind(orgId, SECOND_MEMBERSHIP).first();
    assert.equal(Number(grants?.count), 0);
    assert.equal(await auditCount(database, orgId, "auth.recovery.owner_provisioned"), 1);
  });
});

test("the org always keeps at least one active owner across transfer", async () => {
  await withRecoveryDatabase(async ({ database, owner, orgId }) => {
    // Sole owner: a transfer that would remove the last owner is refused (409).
    await assert.rejects(
      recovery.transferOwner(owner, { targetMembershipId: SECOND_MEMBERSHIP, operationId: operationId("c") }),
      (error) => error?.status === 409 && error?.code === "INVALID_INPUT",
    );
    assert.equal(await auditCount(database, orgId, "auth.recovery.owner_transferred"), 0);

    // Provision a second owner, then the transfer succeeds and demotes it.
    await recovery.provisionOwner(owner, { targetMembershipId: SECOND_MEMBERSHIP, operationId: operationId("b") });
    await recovery.transferOwner(owner, { targetMembershipId: SECOND_MEMBERSHIP, operationId: operationId("d") });

    const demoted = await database.prepare(
      `SELECT role FROM memberships WHERE id = ? AND org_id = ?`,
    ).bind(SECOND_MEMBERSHIP, orgId).first();
    assert.equal(demoted?.role, "org_admin");
    const owners = await database.prepare(
      `SELECT COUNT(*) AS count FROM memberships WHERE org_id = ? AND status = 'active' AND role = 'org_owner'`,
    ).bind(orgId).first();
    assert.equal(Number(owners?.count), 1);
    assert.equal(await auditCount(database, orgId, "auth.recovery.owner_transferred"), 1);
  });
});

test("replaying the same recovery operation writes no second audit row", async () => {
  await withRecoveryDatabase(async ({ database, owner, orgId }) => {
    const op = operationId("a");
    await recovery.recoverMemberMfa(owner, { targetUserId: TARGET_USER, operationId: op }, 5000);
    await recovery.recoverMemberMfa(owner, { targetUserId: TARGET_USER, operationId: op }, 6000);
    const row = await database.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE org_id = ? AND request_id = ?`,
    ).bind(orgId, `auth.recovery.mfa_reset:${op}`).first();
    assert.equal(Number(row?.count), 1);
  });
});

test("platform cold path clears an owner's MFA + lockout and audits as the system actor", async () => {
  await withRecoveryDatabase(async ({ database, owner, orgId }) => {
    const ownerUserId = owner.subject.userId;
    await seedTotp(database, ownerUserId, 1000);
    await database.prepare(
      `UPDATE local_password_credentials SET failed_attempts = 5, locked_until = 9999999999999 WHERE user_id = ?`,
    ).bind(ownerUserId).run();

    await recovery.platformRecoverOwnerMfa(
      { orgId, targetUserId: ownerUserId, operationId: operationId("e") },
      7000,
    );

    const totp = await database.prepare(
      `SELECT COUNT(*) AS count FROM totp_credentials WHERE user_id = ?`,
    ).bind(ownerUserId).first();
    assert.equal(Number(totp?.count), 0);
    const lock = await database.prepare(
      `SELECT failed_attempts, locked_until FROM local_password_credentials WHERE user_id = ?`,
    ).bind(ownerUserId).first();
    assert.equal(Number(lock?.failed_attempts), 0);
    assert.equal(lock?.locked_until, null);
    const activeSessions = await database.prepare(
      `SELECT COUNT(*) AS count FROM local_sessions
        WHERE user_id = ? AND selected_org_id = ? AND revoked_at IS NULL`,
    ).bind(ownerUserId, orgId).first();
    assert.equal(Number(activeSessions?.count), 0);

    const row = await database.prepare(
      `SELECT actor_type, actor_id, target_id FROM audit_events
        WHERE org_id = ? AND action = 'auth.recovery.platform_mfa_reset'`,
    ).bind(orgId).first();
    assert.equal(row?.actor_type, "system");
    assert.equal(row?.actor_id, "system_platform_recovery");
    assert.equal(row?.target_id, ownerUserId);
  });
});

test("platform cold path refuses a non-owner target with 404", async () => {
  await withRecoveryDatabase(async ({ database, orgId }) => {
    await assert.rejects(
      recovery.platformRecoverOwnerMfa({ orgId, targetUserId: TARGET_USER, operationId: operationId("e") }),
      (error) => error?.status === 404,
    );
    const totp = await database.prepare(
      `SELECT COUNT(*) AS count FROM totp_credentials WHERE user_id = ?`,
    ).bind(TARGET_USER).first();
    assert.equal(Number(totp?.count), 1);
    assert.equal(await auditCount(database, orgId, "auth.recovery.platform_mfa_reset"), 0);
  });
});
