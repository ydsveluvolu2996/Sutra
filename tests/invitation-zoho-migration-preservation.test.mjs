import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

const root = resolve(import.meta.dirname, "..");
const migration = await readFile(
  resolve(root, "drizzle/0066_invitation_zoho_provider.sql"),
  "utf8",
);

test("the SQLite Zoho migration preserves invitations, operations, and immutable events", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-zoho-migration-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    const preMigrationSchema = `
      CREATE TABLE organizations (id text PRIMARY KEY NOT NULL);
      CREATE TABLE users (id text PRIMARY KEY NOT NULL);
      CREATE TABLE identity_invitations (
        id text PRIMARY KEY NOT NULL,
        org_id text NOT NULL REFERENCES organizations(id),
        email text NOT NULL,
        role text NOT NULL,
        scope_mode text DEFAULT 'assigned_customers' NOT NULL,
        token_digest text NOT NULL,
        invited_by text NOT NULL REFERENCES users(id),
        expires_at integer NOT NULL,
        accepted_at integer,
        accepted_user_id text,
        revoked_at integer,
        created_at integer NOT NULL,
        customer_id text,
        delivery_status text DEFAULT 'not_attempted' NOT NULL
          CHECK (delivery_status IN ('not_attempted', 'sending', 'accepted', 'failed', 'unknown')),
        delivery_transport text DEFAULT 'none' NOT NULL
          CHECK (delivery_transport IN ('none', 'email-api')),
        delivery_provider text DEFAULT 'none' NOT NULL
          CHECK (delivery_provider IN ('none', 'resend', 'sendgrid', 'generic')),
        delivery_attempts integer DEFAULT 0 NOT NULL CHECK (delivery_attempts >= 0),
        delivery_last_attempted_at integer,
        delivery_completed_at integer,
        delivery_error_code text,
        delivery_http_status integer,
        delivery_idempotency_digest text,
        delivery_revision integer DEFAULT 0 NOT NULL CHECK (delivery_revision >= 0)
      );
      CREATE UNIQUE INDEX identity_invitations_token_uq ON identity_invitations (token_digest);
      CREATE UNIQUE INDEX identity_invitations_active_email_uq
        ON identity_invitations (org_id, email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL;
      CREATE INDEX identity_invitations_org_expiry_idx
        ON identity_invitations (org_id, expires_at, revoked_at);
      CREATE INDEX identity_invitations_org_delivery_idx
        ON identity_invitations (org_id, delivery_status, delivery_last_attempted_at);
      CREATE TABLE identity_invitation_operations (
        id text PRIMARY KEY NOT NULL,
        org_id text NOT NULL REFERENCES organizations(id),
        operation_kind text NOT NULL CHECK (operation_kind IN ('creation', 'initial_delivery', 'resend')),
        idempotency_scope_id text NOT NULL,
        invitation_id text REFERENCES identity_invitations(id),
        idempotency_digest text NOT NULL CHECK (length(idempotency_digest) = 64),
        request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
        operation_status text DEFAULT 'claimed' NOT NULL CHECK (operation_status IN ('claimed', 'completed')),
        outcome_status text CHECK (outcome_status IN ('accepted', 'failed', 'unknown')),
        delivery_transport text DEFAULT 'none' NOT NULL CHECK (delivery_transport IN ('none', 'email-api')),
        delivery_provider text DEFAULT 'none' NOT NULL
          CHECK (delivery_provider IN ('none', 'resend', 'sendgrid', 'generic')),
        delivery_error_code text,
        delivery_http_status integer,
        created_at integer NOT NULL,
        completed_at integer
      );
      CREATE UNIQUE INDEX identity_invitation_operations_scope_key_uq
        ON identity_invitation_operations (org_id, operation_kind, idempotency_scope_id, idempotency_digest);
      CREATE UNIQUE INDEX identity_invitation_operations_invitation_key_uq
        ON identity_invitation_operations (org_id, invitation_id, idempotency_digest)
        WHERE invitation_id IS NOT NULL;
      CREATE INDEX identity_invitation_operations_invitation_time_idx
        ON identity_invitation_operations (org_id, invitation_id, created_at, id);
      CREATE TABLE identity_invitation_events (
        id text PRIMARY KEY NOT NULL,
        invitation_id text NOT NULL REFERENCES identity_invitations(id),
        org_id text NOT NULL REFERENCES organizations(id),
        actor_id text NOT NULL,
        action text NOT NULL,
        occurred_at integer NOT NULL,
        metadata_json text DEFAULT '{}' NOT NULL,
        previous_event_hash text,
        event_hash text NOT NULL
      );
      CREATE UNIQUE INDEX identity_invitation_events_hash_uq
        ON identity_invitation_events (invitation_id, event_hash);
      CREATE UNIQUE INDEX identity_invitation_events_previous_hash_uq
        ON identity_invitation_events (invitation_id, previous_event_hash)
        WHERE previous_event_hash IS NOT NULL;
      CREATE INDEX identity_invitation_events_org_time_idx
        ON identity_invitation_events (org_id, occurred_at, id);
      CREATE TRIGGER identity_invitation_events_no_update
        BEFORE UPDATE ON identity_invitation_events
        BEGIN SELECT RAISE(ABORT, 'identity invitation activity is immutable'); END;
      CREATE TRIGGER identity_invitation_events_no_delete
        BEFORE DELETE ON identity_invitation_events
        BEGIN SELECT RAISE(ABORT, 'identity invitation activity is immutable'); END;
    `;
    for (const statement of preMigrationSchema
      .split(/;\s*\n(?=\s*CREATE)/u)
      .map((candidate) => candidate.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }
    const digest = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    await database.batch([
      database.prepare("INSERT INTO organizations (id) VALUES ('org_test')"),
      database.prepare("INSERT INTO users (id) VALUES ('user_test')"),
      database.prepare(
        `INSERT INTO identity_invitations
          (id, org_id, email, role, token_digest, invited_by, expires_at, created_at,
           delivery_status, delivery_transport, delivery_provider, delivery_attempts,
           delivery_revision)
         VALUES ('invite_test', 'org_test', 'invitee@example.com', 'viewer', ?,
                 'user_test', 999999, 1000, 'accepted', 'email-api', 'resend', 1, 1)`,
      ).bind(digest),
      database.prepare(
        `INSERT INTO identity_invitation_operations
          (id, org_id, operation_kind, idempotency_scope_id, invitation_id,
           idempotency_digest, request_fingerprint, operation_status, outcome_status,
           delivery_transport, delivery_provider, created_at, completed_at)
         VALUES ('operation_test', 'org_test', 'initial_delivery', 'invite_test',
                 'invite_test', ?, ?, 'completed', 'accepted', 'email-api', 'resend',
                 1001, 1002)`,
      ).bind(digest, fingerprint),
      database.prepare(
        `INSERT INTO identity_invitation_events
          (id, invitation_id, org_id, actor_id, action, occurred_at, event_hash)
         VALUES ('event_test', 'invite_test', 'org_test', 'user_test',
                 'delivery_accepted', 1002, ?)`,
      ).bind(fingerprint),
    ]);

    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((candidate) => candidate.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }

    assert.deepEqual(
      await database.prepare(
        `SELECT delivery_status, delivery_provider, delivery_attempts
           FROM identity_invitations WHERE id = 'invite_test'`,
      ).first(),
      { delivery_status: "accepted", delivery_provider: "resend", delivery_attempts: 1 },
    );
    assert.deepEqual(
      await database.prepare(
        `SELECT operation_status, outcome_status, delivery_provider
           FROM identity_invitation_operations WHERE id = 'operation_test'`,
      ).first(),
      { operation_status: "completed", outcome_status: "accepted", delivery_provider: "resend" },
    );
    assert.equal(
      await database.prepare(
        "SELECT action FROM identity_invitation_events WHERE id = 'event_test'",
      ).first("action"),
      "delivery_accepted",
    );
    await database.prepare(
      "UPDATE identity_invitations SET delivery_provider = 'zoho' WHERE id = 'invite_test'",
    ).run();
    await database.prepare(
      "UPDATE identity_invitation_operations SET delivery_provider = 'zoho' WHERE id = 'operation_test'",
    ).run();
    await assert.rejects(
      database.prepare(
        "UPDATE identity_invitation_events SET action = 'revoked' WHERE id = 'event_test'",
      ).run(),
      /identity invitation activity is immutable/u,
    );
  } finally {
    await miniflare.dispose();
  }
});
