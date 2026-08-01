import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  FinopsDataExportObservationRepository,
  FinopsDataExportObservationRepositoryError,
} = await import("../db/finops-data-export-observation-repository.ts");

const ORG_A = "org_observation_a";
const ORG_B = "org_observation_b";
const CUSTOMER_A = "customer_observation_a";
const CUSTOMER_B = "customer_observation_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const EXPORT_NAME = "sutra_foundational_cur2_v1";
const PREFIX = `sutra/cur2/${EXPORT_NAME}/`;

const PAYLOAD = {
  schema: "sutra.finops-data-export-ingest.v2",
  connectionId: CONNECTION_A,
  contractId: "foundational-cur2-export-v1",
  exportName: EXPORT_NAME,
  region: "us-east-1",
  bucket: "customer-billing-export",
  prefix: PREFIX,
  manifestKey:
    `${PREFIX}metadata/BILLING_PERIOD=2026-07/manifest.json`,
  evidence: {
    sourceEvidenceId: "aws-data-export-execution:execution-1",
    manifestSha256:
      "bedde6a148c07cb6a62494ff2fb0136b79a7d5b7d2c00ac3ac15251992a8a21c",
    rowCount: 1,
    currencies: [{ currency: "USD", rowCount: 1, totalMicros: "1000000" }],
  },
};

function connectionInsert(database, input) {
  return database.prepare(
    `INSERT INTO aws_connections
      (id, org_id, customer_id, source_kind, partition, aws_account_id,
       role_arn, external_id_ciphertext, external_id_key_version,
       permission_pack_version, status, enabled_regions_json)
     VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ct', 'v1',
       'standard-2026-08.1', 'active', '["us-east-1"]')`,
  ).bind(
    input.connectionId,
    input.orgId,
    input.customerId,
    input.accountId,
    `arn:aws:iam::${input.accountId}:role/sutra/SutraCollectorRole`,
  );
}

test("verified billing observations are immutable and tenant/connection scoped", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-finops-observation-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'obs-a', 'Observation A', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'obs-b', 'Observation B', 'active')",
      ).bind(ORG_B),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'obs-ca', 'Observation A', 'active')",
      ).bind(CUSTOMER_A, ORG_A),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'obs-cb', 'Observation B', 'active')",
      ).bind(CUSTOMER_B, ORG_B),
      connectionInsert(database, {
        connectionId: CONNECTION_A,
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        accountId: "111122223333",
      }),
      connectionInsert(database, {
        connectionId: CONNECTION_B,
        orgId: ORG_B,
        customerId: CUSTOMER_B,
        accountId: "444455556666",
      }),
    ]);

    const repository = new FinopsDataExportObservationRepository(database);
    const scope = {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
    };
    const body = new TextEncoder().encode(JSON.stringify(PAYLOAD));
    const verification = {
      tenantId: ORG_A,
      connectionId: CONNECTION_A,
      jobId: "discover-cur2-2026-07",
      keyId: "broker-production-1",
      nonce: "nonce_0000000000000000000001",
      timestamp: Date.parse("2026-07-31T12:00:00.000Z"),
      bodySha256: createHash("sha256").update(body).digest("hex"),
    };
    const stored = await repository.recordVerifiedObservation({
      scope,
      body,
      verification,
    });
    assert.match(stored.id, /^fdo_[a-f0-9]{32}$/u);
    assert.deepEqual(stored.payload, PAYLOAD);
    assert.deepEqual(stored.attestation, {
      scheme: "hosted-broker-ed25519-v1",
      keyId: verification.keyId,
      operationId: verification.jobId,
      nonce: verification.nonce,
      bodySha256: verification.bodySha256,
      observedAtIso: "2026-07-31T12:00:00.000Z",
    });

    const duplicate = await repository.recordVerifiedObservation({
      scope,
      body,
      verification,
    });
    assert.equal(duplicate.id, stored.id);
    assert.deepEqual(await repository.getExact(scope, stored.id), stored);
    assert.equal(await repository.getExact({
      orgId: ORG_B,
      customerId: CUSTOMER_B,
      connectionId: CONNECTION_B,
    }, stored.id), null);

    await assert.rejects(
      repository.recordVerifiedObservation({
        scope,
        body: new TextEncoder().encode(JSON.stringify({
          ...PAYLOAD,
          connectionId: CONNECTION_B,
        })),
        verification,
      }),
      (error) =>
        error instanceof FinopsDataExportObservationRepositoryError
        && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repository.recordVerifiedObservation({
        scope,
        body,
        verification: { ...verification, tenantId: ORG_B },
      }),
      (error) =>
        error instanceof FinopsDataExportObservationRepositoryError
        && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repository.recordVerifiedObservation({
        scope,
        body: new TextEncoder().encode(JSON.stringify({
          ...PAYLOAD,
          exportName: "substituted_export",
        })),
        verification,
      }),
      (error) =>
        error instanceof FinopsDataExportObservationRepositoryError
        && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      database.prepare(
        "UPDATE finops_data_export_observations SET producer_key_id = 'substituted' WHERE id = ?",
      ).bind(stored.id).run(),
      /FINOPS_DATA_EXPORT_OBSERVATION_IMMUTABLE/u,
    );
    await assert.rejects(
      database.prepare(
        "DELETE FROM finops_data_export_observations WHERE id = ?",
      ).bind(stored.id).run(),
      /FINOPS_DATA_EXPORT_OBSERVATION_IMMUTABLE/u,
    );
  } finally {
    await miniflare.dispose();
  }
});
