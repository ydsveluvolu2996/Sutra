import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const auth = await import("../db/auth-repository.ts");
const invitations = await import("../db/identity-invitation-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const HOUR_MS = 60 * 60 * 1000;

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-invite-delivery-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    const owner = await auth.bootstrapLocalAdmin({
      email: "delivery-owner@sutra.invalid",
      password: "Invitation delivery repository passphrase 2026!",
      displayName: "Delivery Owner",
      organizationName: "Delivery Test",
    }, 1000);
    await run({ database, owner: owner.session, scope: { mode: "org" } });
  } finally {
    await miniflare.dispose();
  }
}

test("invitation delivery status is durable and never stores the plaintext URL token", async () => {
  await withDatabase(async ({ database, owner, scope }) => {
    const created = await invitations.createIdentityInvitation(owner, scope, {
      email: "recipient@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: 24 * HOUR_MS,
    }, 2000);
    const key = `creation-${created.invitation.id}`;
    const begun = await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: key,
      rotateToken: false,
    }, 3000);
    assert.equal(begun.invitation.delivery.status, "sending");
    const completed = await invitations.completeIdentityInvitationDelivery(
      owner,
      scope,
      created.invitation.id,
      key,
      { status: "accepted", transport: "email-api", provider: "zoho", errorCode: null, httpStatus: 202 },
      3100,
    );
    assert.deepEqual(completed.delivery, {
      status: "accepted",
      transport: "email-api",
      provider: "zoho",
      attempts: 1,
      lastAttemptedAt: new Date(3000).toISOString(),
      completedAt: new Date(3100).toISOString(),
      errorCode: null,
    });
    const persisted = await database.prepare(
      `SELECT token_digest, delivery_idempotency_digest, delivery_status FROM identity_invitations WHERE id = ?`,
    ).bind(created.invitation.id).first();
    assert.equal(persisted.delivery_status, "accepted");
    assert.notEqual(persisted.token_digest, created.token);
    assert.doesNotMatch(JSON.stringify(persisted), new RegExp(created.token, "u"));
    const events = await database.prepare(
      `SELECT action, metadata_json FROM identity_invitation_events WHERE invitation_id = ? ORDER BY occurred_at`,
    ).bind(created.invitation.id).all();
    assert.deepEqual(events.results.map((event) => event.action), [
      "created", "delivery_started", "delivery_accepted",
    ]);
    assert.doesNotMatch(JSON.stringify(events.results), new RegExp(created.token, "u"));
    const operation = await database.prepare(
      `SELECT operation_kind, operation_status, outcome_status, delivery_provider,
              request_fingerprint, idempotency_digest
         FROM identity_invitation_operations WHERE invitation_id = ?`,
    ).bind(created.invitation.id).first();
    assert.deepEqual({
      kind: operation.operation_kind,
      state: operation.operation_status,
      outcome: operation.outcome_status,
      provider: operation.delivery_provider,
    }, {
      kind: "initial_delivery",
      state: "completed",
      outcome: "accepted",
      provider: "zoho",
    });
    assert.match(operation.request_fingerprint, /^[a-f0-9]{64}$/u);
    assert.match(operation.idempotency_digest, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(operation), new RegExp(created.token, "u"));
  });
});

test("invitation creation replays durably without redisplaying a token or creating a duplicate", async () => {
  await withDatabase(async ({ database, owner, scope }) => {
    const input = {
      email: "idempotent-create@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: 24 * HOUR_MS,
    };
    const key = "create-invitation-0000000000000001";
    const first = await invitations.createIdentityInvitationIdempotently(owner, scope, input, key, 2000);
    assert.equal(first.replayed, false);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);

    const replay = await invitations.createIdentityInvitationIdempotently(owner, scope, input, key, 3000);
    assert.equal(replay.replayed, true);
    assert.equal(replay.token, null, "a replay never redisplays the bearer token");
    assert.equal(replay.invitation.id, first.invitation.id);

    const persisted = await database.prepare(
      `SELECT COUNT(*) AS count FROM identity_invitations WHERE org_id = ? AND email = ?`,
    ).bind(owner.subject.orgId, input.email).first();
    assert.equal(Number(persisted.count), 1);
    const operations = await database.prepare(
      `SELECT operation_kind, operation_status, invitation_id, request_fingerprint
         FROM identity_invitation_operations WHERE org_id = ? AND operation_kind = 'creation'`,
    ).bind(owner.subject.orgId).all();
    assert.equal(operations.results.length, 1);
    assert.deepEqual({
      operationKind: operations.results[0].operation_kind,
      operationStatus: operations.results[0].operation_status,
      invitationId: operations.results[0].invitation_id,
    }, {
      operationKind: "creation",
      operationStatus: "completed",
      invitationId: first.invitation.id,
    });
    assert.match(operations.results[0].request_fingerprint, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(operations.results), new RegExp(first.token, "u"));
  });
});

test("invitation creation rejects idempotency-key reuse with a different request", async () => {
  await withDatabase(async ({ owner, scope }) => {
    const key = "create-conflict-0000000000000001";
    await invitations.createIdentityInvitationIdempotently(owner, scope, {
      email: "create-conflict@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: HOUR_MS,
    }, key, 2000);
    await assert.rejects(
      invitations.createIdentityInvitationIdempotently(owner, scope, {
        email: "different-create@example.com",
        role: "analyst",
        scopeMode: "assigned_customers",
        lifetimeMs: HOUR_MS,
      }, key, 3000),
      (error) => error?.status === 409,
    );
  });
});

test("competing identical creation requests commit once and replay without a second token", async () => {
  await withDatabase(async ({ database, owner, scope }) => {
    const input = {
      email: "create-race@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: HOUR_MS,
    };
    const key = "create-race-key-0000000000000001";
    const results = await Promise.all([
      invitations.createIdentityInvitationIdempotently(owner, scope, input, key, 2000),
      invitations.createIdentityInvitationIdempotently(owner, scope, input, key, 2000),
    ]);
    assert.equal(results.filter((result) => result.replayed === false).length, 1);
    assert.equal(results.filter((result) => result.replayed === true).length, 1);
    assert.equal(results.filter((result) => result.token !== null).length, 1);
    assert.equal(new Set(results.map((result) => result.invitation.id)).size, 1);
    const invitationCount = await database.prepare(
      `SELECT COUNT(*) AS count FROM identity_invitations WHERE org_id = ? AND email = ?`,
    ).bind(owner.subject.orgId, input.email).first();
    const operationCount = await database.prepare(
      `SELECT COUNT(*) AS count FROM identity_invitation_operations
        WHERE org_id = ? AND operation_kind = 'creation'`,
    ).bind(owner.subject.orgId).first();
    assert.equal(Number(invitationCount.count), 1);
    assert.equal(Number(operationCount.count), 1);
  });
});

test("resend rotates the token once and replays the same idempotency key without a second send", async () => {
  await withDatabase(async ({ database, owner, scope }) => {
    const created = await invitations.createIdentityInvitation(owner, scope, {
      email: "resend@example.com",
      role: "customer_viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: HOUR_MS,
    }, 2000);
    const key = "resend-request-0000000000000001";
    const first = await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: key,
      rotateToken: true,
      lifetimeMs: 24 * HOUR_MS,
    }, 4000);
    assert.equal(first.replayed, false);
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(first.token, created.token);
    assert.equal(await invitations.previewPasswordInvitation(created.token, 4100), null, "the old URL is invalid immediately");
    assert.ok(await invitations.previewPasswordInvitation(first.token, 4100), "the rotated URL is valid");

    const replay = await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: key,
      rotateToken: true,
      lifetimeMs: 24 * HOUR_MS,
    }, 4200);
    assert.equal(replay.replayed, true);
    assert.equal(replay.token, null, "a replay never discloses or remints a token");
    assert.equal(replay.invitation.delivery.attempts, 1);

    const events = await database.prepare(
      `SELECT action, metadata_json FROM identity_invitation_events WHERE invitation_id = ? ORDER BY occurred_at`,
    ).bind(created.invitation.id).all();
    assert.deepEqual(events.results.map((event) => event.action), ["created", "resent"]);
    assert.doesNotMatch(JSON.stringify(events.results), new RegExp(first.token, "u"));
  });
});

test("competing resend keys use compare-and-swap so only one token and send claim wins", async () => {
  await withDatabase(async ({ database, owner, scope }) => {
    const created = await invitations.createIdentityInvitation(owner, scope, {
      email: "resend-race@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: HOUR_MS,
    }, 2000);
    const resend = (idempotencyKey) => invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey,
      rotateToken: true,
      lifetimeMs: HOUR_MS,
    }, 4000);
    const results = await Promise.allSettled([
      resend("resend-race-key-0000000000000001"),
      resend("resend-race-key-0000000000000002"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejection = results.find((result) => result.status === "rejected");
    assert.equal(rejection.reason?.status, 409);

    const persisted = await database.prepare(
      `SELECT delivery_attempts FROM identity_invitations WHERE id = ?`,
    ).bind(created.invitation.id).first();
    assert.equal(persisted.delivery_attempts, 1);
    const events = await database.prepare(
      `SELECT action FROM identity_invitation_events WHERE invitation_id = ? ORDER BY occurred_at, id`,
    ).bind(created.invitation.id).all();
    assert.deepEqual(events.results.map((event) => event.action), ["created", "resent"]);
    const operations = await database.prepare(
      `SELECT id FROM identity_invitation_operations WHERE invitation_id = ?`,
    ).bind(created.invitation.id).all();
    assert.equal(operations.results.length, 1);
  });
});

test("historical resend keys never mint again and key reuse with a different lifetime is rejected", async () => {
  await withDatabase(async ({ database, owner, scope }) => {
    const created = await invitations.createIdentityInvitation(owner, scope, {
      email: "resend-history@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: HOUR_MS,
    }, 2000);
    const firstKey = "resend-history-key-000000000000001";
    const secondKey = "resend-history-key-000000000000002";
    const first = await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: firstKey,
      rotateToken: true,
      lifetimeMs: HOUR_MS,
    }, 3000);
    await invitations.completeIdentityInvitationDelivery(
      owner,
      scope,
      created.invitation.id,
      firstKey,
      { status: "accepted", transport: "email-api", provider: "resend", errorCode: null, httpStatus: 202 },
      3100,
    );
    const second = await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: secondKey,
      rotateToken: true,
      lifetimeMs: 24 * HOUR_MS,
    }, 4000);
    await invitations.completeIdentityInvitationDelivery(
      owner,
      scope,
      created.invitation.id,
      secondKey,
      { status: "failed", transport: "email-api", provider: "resend", errorCode: "PROVIDER_REJECTED", httpStatus: 400 },
      4100,
    );

    const historicalReplay = await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: firstKey,
      rotateToken: true,
      lifetimeMs: HOUR_MS,
    }, 5000);
    assert.equal(historicalReplay.replayed, true);
    assert.equal(historicalReplay.token, null);
    assert.equal(historicalReplay.invitation.delivery.attempts, 2);
    assert.equal(await invitations.previewPasswordInvitation(first.token, 5000), null);
    assert.ok(await invitations.previewPasswordInvitation(second.token, 5000));

    await assert.rejects(
      invitations.beginIdentityInvitationDelivery(owner, scope, {
        invitationId: created.invitation.id,
        idempotencyKey: firstKey,
        rotateToken: true,
        lifetimeMs: 2 * HOUR_MS,
      }, 5100),
      (error) => error?.status === 409,
    );

    const operations = await database.prepare(
      `SELECT operation_status, outcome_status FROM identity_invitation_operations
        WHERE invitation_id = ? ORDER BY created_at, id`,
    ).bind(created.invitation.id).all();
    assert.deepEqual(operations.results, [
      { operation_status: "completed", outcome_status: "accepted" },
      { operation_status: "completed", outcome_status: "failed" },
    ]);
    const events = await database.prepare(
      `SELECT previous_event_hash, event_hash FROM identity_invitation_events
        WHERE invitation_id = ? AND previous_event_hash IS NOT NULL`,
    ).bind(created.invitation.id).all();
    assert.equal(new Set(events.results.map((event) => event.previous_event_hash)).size, events.results.length);
  });
});

test("an unresolved send ages to unknown and is not falsely marked failed", async () => {
  await withDatabase(async ({ owner, scope }) => {
    const created = await invitations.createIdentityInvitation(owner, scope, {
      email: "unknown@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: HOUR_MS,
    }, 2000);
    await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: "unknown-send-0000000000000001",
      rotateToken: false,
    }, 3000);
    const listed = await invitations.listIdentityInvitations(owner, scope, 63_001);
    assert.equal(listed[0].delivery.status, "unknown");
    assert.equal(listed[0].delivery.completedAt, null);
  });
});

test("resending preserves the original identity-provider pin", async () => {
  await withDatabase(async ({ owner, scope }) => {
    const allowedIssuer = "https://login.example.com/tenant/v2.0";
    const created = await invitations.createIdentityInvitation(owner, scope, {
      email: "pinned@example.com",
      role: "viewer",
      scopeMode: "assigned_customers",
      lifetimeMs: HOUR_MS,
      allowedIssuer,
    }, 2000);
    const resent = await invitations.beginIdentityInvitationDelivery(owner, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: "pinned-resend-0000000000000001",
      rotateToken: true,
      lifetimeMs: HOUR_MS,
    }, 3000);
    assert.match(resent.token, /^[A-Za-z0-9_-]{43}$/u);
    await assert.rejects(
      invitations.acceptIdentityInvitation({
        issuer: "https://attacker.example.com/tenant/v2.0",
        subject: "attacker-subject",
        email: "pinned@example.com",
        displayName: "Wrong Issuer",
        authenticatedAt: 4000,
        expiresAt: 4000 + HOUR_MS,
      }, resent.token, 4000),
      (error) => error?.code === "IDENTITY_ISSUER_MISMATCH",
    );
    assert.equal(await invitations.previewPasswordInvitation(resent.token, 4000) !== null, true);
    await assert.rejects(
      invitations.acceptPasswordInvitation(resent.token, {
        password: "Pinned invitation passphrase 2026!",
        displayName: "Pinned User",
      }, 4000),
      (error) => error?.code === "IDENTITY_ISSUER_MISMATCH",
    );
  });
});
