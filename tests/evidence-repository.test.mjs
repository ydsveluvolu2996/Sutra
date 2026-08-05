import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { EvidenceRepository } = await import("../db/evidence-repository.ts");

const ORG_A = "org_evidence_alpha";
const ORG_B = "org_evidence_beta";
const CUSTOMER_A = "cust_evidence_alpha";
const CUSTOMER_B = "cust_evidence_beta";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACTOR_A = "usr_evidence_alpha";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-evidence-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, ?, 'active')",
      ).bind(ORG_A, "evidence-alpha", "Evidence Alpha"),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, ?, 'active')",
      ).bind(ORG_B, "evidence-beta", "Evidence Beta"),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, 'active')",
      ).bind(CUSTOMER_A, ORG_A, "evidence-alpha", "Evidence Alpha"),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, 'active')",
      ).bind(CUSTOMER_B, ORG_B, "evidence-beta", "Evidence Beta"),
      database.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, source_kind, partition, aws_account_id,
           role_arn, external_id_ciphertext, external_id_key_version,
           permission_pack_version, status, enabled_regions_json)
         VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'encrypted-test',
                 'test-v1', 'standard-2026-07.4', 'active', '["ap-south-1"]')`,
      ).bind(
        CONNECTION_A,
        ORG_A,
        CUSTOMER_A,
        "111122223333",
        "arn:aws:iam::111122223333:role/sutra/SutraReadOnlyRole",
      ),
      database.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, source_kind, partition, aws_account_id,
           role_arn, external_id_ciphertext, external_id_key_version,
           permission_pack_version, status, enabled_regions_json)
         VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'encrypted-test',
                 'test-v1', 'standard-2026-07.4', 'active', '["ap-south-1"]')`,
      ).bind(
        CONNECTION_B,
        ORG_B,
        CUSTOMER_B,
        "444455556666",
        "arn:aws:iam::444455556666:role/sutra/SutraReadOnlyRole",
      ),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

test("evidence grants are opaque, tenant/actor-bound, digest-only, and single-use", async () => {
  await withDatabase(async (database) => {
    const repository = new EvidenceRepository(database, {
      objectStore: null,
      retentionDays: 30,
      environment: { SUTRA_DEPLOYMENT_ENV: "test" },
    });
    const body = new TextEncoder().encode('{"signed":"exact bytes"}');
    const scope = { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A };
    const object = await repository.archive({
      scope,
      runId: "run_evidence_alpha",
      snapshotId: "snap_evidence_alpha",
      artifactKind: "aws_snapshot_raw",
      contentType: "application/json",
      body,
      createdBy: ACTOR_A,
    });
    assert.equal((await repository.list(scope))[0]?.id, object.id);
    assert.equal("objectKey" in object, false);

    const grant = await repository.issueGrant({
      scope,
      objectId: object.id,
      actorId: ACTOR_A,
      purpose: "raw_evidence_review",
    });
    const row = await database.prepare(
      "SELECT token_sha256, actor_id, customer_id FROM evidence_download_grants WHERE object_id = ?",
    ).bind(object.id).first();
    assert.equal(row.actor_id, ACTOR_A);
    assert.equal(row.customer_id, CUSTOMER_A);
    assert.notEqual(row.token_sha256, grant.token);
    assert.equal(JSON.stringify(row).includes(grant.token), false);
    assert.equal(await repository.peekGrantScope({
      orgId: ORG_A,
      actorId: "usr_evidence_wrong",
      token: grant.token,
    }), null);
    assert.equal(await repository.peekGrantScope({
      orgId: ORG_B,
      actorId: ACTOR_A,
      token: grant.token,
    }), null);

    const attempts = await Promise.all([
      repository.consumeGrant({ orgId: ORG_A, actorId: ACTOR_A, token: grant.token }),
      repository.consumeGrant({ orgId: ORG_A, actorId: ACTOR_A, token: grant.token }),
    ]);
    assert.equal(attempts.filter(Boolean).length, 1);
    assert.equal(await repository.consumeGrant({
      orgId: ORG_A,
      actorId: ACTOR_A,
      token: grant.token,
    }), null);
    const stored = await repository.readVerified(attempts.find(Boolean));
    assert.deepEqual(stored.body, body);
  });
});

test("cross-tenant objects cannot receive grants and local evidence is immutable", async () => {
  await withDatabase(async (database) => {
    const repository = new EvidenceRepository(database, {
      objectStore: null,
      retentionDays: 30,
      environment: { SUTRA_DEPLOYMENT_ENV: "test" },
    });
    const scopeA = { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A };
    const object = await repository.archive({
      scope: scopeA,
      runId: "run_evidence_isolation",
      artifactKind: "export_json",
      contentType: "application/json",
      body: new TextEncoder().encode('{"tenant":"alpha"}'),
      createdBy: ACTOR_A,
    });
    await assert.rejects(
      repository.issueGrant({
        scope: { orgId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B },
        objectId: object.id,
        actorId: ACTOR_A,
        purpose: "export_download",
      }),
      (error) => error?.code === "SCOPE_NOT_FOUND",
    );
    await assert.rejects(
      database.prepare(
        "UPDATE evidence_local_payloads SET body_base64 = 'dGFtcGVyZWQ=' WHERE object_id = ?",
      ).bind(object.id).run(),
      /immutable local evidence payload/u,
    );
    await assert.rejects(
      database.prepare(
        "UPDATE evidence_objects SET object_key = ? WHERE id = ?",
      ).bind(`evidence/v1/${"f".repeat(64)}`, object.id).run(),
      /immutable evidence identity/u,
    );
  });
});
