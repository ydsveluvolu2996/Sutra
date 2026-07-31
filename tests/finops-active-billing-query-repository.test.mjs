import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  FinopsBillingEngineRepository,
} = await import("../db/finops-billing-engine-repository.ts");
const {
  FinopsActiveBillingQueryRepository,
  FinopsActiveBillingQueryRepositoryError,
} = await import("../db/finops-active-billing-query-repository.ts");
const {
  validateFinopsDataExportManifest,
} = await import("../lib/finops-data-export.ts");
const {
  buildPersistedFinopsSourceEvidence,
} = await import("../lib/finops-source-health-evidence.ts");
const { parseCurCsv } = await import("../lib/finops-cur.ts");

const ORG_A = "org_cudos_read_a";
const ORG_B = "org_cudos_read_b";
const CUSTOMER_A = "cust_cudos_read_a";
const CUSTOMER_B = "cust_cudos_read_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const SIMULATED = `conn_${"c".repeat(32)}`;
const OWNER_A = {
  orgId: ORG_A,
  customerId: CUSTOMER_A,
  connectionId: CONNECTION_A,
};

function connectionRow(
  database,
  id,
  orgId,
  customerId,
  accountId,
  sourceKind = "aws_trust_role",
) {
  return database.prepare(
    `INSERT INTO aws_connections
       (id, org_id, customer_id, source_kind, fixture_id, aws_account_id,
        role_arn, external_id_ciphertext, external_id_key_version,
        permission_pack_version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ct', 'v1', 'pack-v1', 'active')`,
  ).bind(
    id,
    orgId,
    customerId,
    sourceKind,
    sourceKind === "simulated_fixture" ? "fixture-cudos" : null,
    accountId,
    sourceKind === "aws_trust_role"
      ? `arn:aws:iam::${accountId}:role/sutra`
      : "",
  );
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-cudos-read-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cudos-read-a', 'CUDOS A', 'active')",
      ).bind(ORG_A),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status) VALUES (?, 'cudos-read-b', 'CUDOS B', 'active')",
      ).bind(ORG_B),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cudos-cust-a', 'Customer A', 'active')",
      ).bind(CUSTOMER_A, ORG_A),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'cudos-cust-b', 'Customer B', 'active')",
      ).bind(CUSTOMER_B, ORG_B),
      connectionRow(
        database,
        CONNECTION_A,
        ORG_A,
        CUSTOMER_A,
        "111122223333",
      ),
      connectionRow(
        database,
        CONNECTION_B,
        ORG_B,
        CUSTOMER_B,
        "444455556666",
      ),
      connectionRow(
        database,
        SIMULATED,
        ORG_A,
        CUSTOMER_A,
        "999900001111",
        "simulated_fixture",
      ),
    ]);
    await run({
      database,
      writer: new FinopsBillingEngineRepository(database),
      reader: new FinopsActiveBillingQueryRepository(database),
    });
  } finally {
    await miniflare.dispose();
  }
}

async function manifest(revision) {
  const result = await validateFinopsDataExportManifest({
    scope: {
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
    },
    bucket: "sutra-customer-billing",
    manifestKey:
      "exports/aws-cur/metadata/BILLING_PERIOD=2026-07/aws-cur-Manifest.json",
    eTag: `"etag-${revision}"`,
    versionId: `version-${revision}`,
    observedAtIso: `2026-07-31T12:0${revision}:00Z`,
    body: {
      metadata: {
        exportName: "aws-cur",
        exportTableName: "COST_AND_USAGE_REPORT",
        exportLastUpdatedTime: `2026-07-31T11:0${revision}:00Z`,
      },
      columns: [
        "line_item_id",
        "line_item_unblended_cost",
        `revision_${revision}`,
      ],
      dataFiles: [
        `exports/aws-cur/data/BILLING_PERIOD=2026-07/aws-cur-${revision}.csv.gz`,
      ],
    },
  });
  if (!result.ok) throw new Error(result.rejection.message);
  return result.manifest;
}

function canonicalLines(count, prefix = "line") {
  const rows = Array.from({ length: count }, (_, index) =>
    `${prefix}-${String(index).padStart(5, "0")},111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD`);
  const parsed = parseCurCsv([
    "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code",
    ...rows,
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.lines;
}

async function publish(writer, revision, lines, rejectedRows = 0) {
  const began = await writer.beginValidatedManifest(await manifest(revision));
  if (began.action !== "stage") throw new Error("fixture must stage");
  for (let index = 0; index < lines.length; index += 250) {
    await writer.stageCanonicalLines(
      OWNER_A,
      began.generation,
      lines.slice(index, index + 250),
    );
  }
  await writer.commitGeneration(
    OWNER_A,
    began.generation,
    {
      acceptedRows: lines.length,
      rejectedRows,
      currencyTotals: { USD: String(lines.length * 1_000_000) },
    },
    Date.parse(`2026-07-31T12:${String(revision).padStart(2, "0")}:30Z`),
  );
  return began.generation;
}

function repositoryError(code) {
  return (error) =>
    error instanceof FinopsActiveBillingQueryRepositoryError
    && error.code === code;
}

function sourceHealthEvidence(partition) {
  const connection = {
    id: CONNECTION_A,
    customerId: CUSTOMER_A,
    sourceKind: "aws_trust_role",
    status: "active",
    lastSuccessfulSyncAt: null,
    updatedAt: "2026-07-31T12:00:00.000Z",
  };
  return buildPersistedFinopsSourceEvidence({
    scope: {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
    },
    connection,
    pilotState: {
      syncRuns: [],
      activeSnapshot: null,
      latestRunCoverage: null,
      coverage: [],
    },
    activeBillingPartitions: [partition],
  }).filter(({ sourceId }) => sourceId !== "data_collection_telemetry");
}

test("pages more than 1,000 active rows by stable ID and keeps staging corrections invisible", async () => {
  await withDatabase(async ({ database, writer, reader }) => {
    const activeGeneration = await publish(
      writer,
      1,
      canonicalLines(1_001, "active"),
      7,
    );
    const [ready] = await reader.listActivePartitions(OWNER_A);
    assert.ok(ready);
    assert.deepEqual(ready.scope, {
      organizationId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      exportName: "aws-cur",
      billingPeriod: "2026-07",
      generationId: activeGeneration.generationId,
    });
    assert.equal(ready.evidence.activeManifestSha256, activeGeneration.generationId.slice(4));
    assert.equal(ready.evidence.acceptedRows, 1_001);
    assert.equal(ready.evidence.rejectedRows, 7);
    assert.equal(
      ready.evidence.activeSourceUpdatedAtIso,
      "2026-07-31T11:01:00.000Z",
    );
    const sourceHealthBeforeCorrection = sourceHealthEvidence(ready);

    const firstPage = await reader.pageActiveRows(
      OWNER_A,
      ready,
      { limit: 1_000 },
    );
    assert.equal(firstPage.rows.length, 1_000);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextAfterId);
    const secondPage = await reader.pageActiveRows(OWNER_A, ready, {
      afterId: firstPage.nextAfterId,
      limit: 1_000,
    });
    assert.equal(secondPage.rows.length, 1);
    assert.equal(secondPage.hasMore, false);
    assert.equal(
      firstPage.rows.at(-1)?.line.lineItemId
        === secondPage.rows[0]?.line.lineItemId,
      false,
    );
    await assert.rejects(
      reader.pageActiveRows(OWNER_A, ready, { limit: 1_001 }),
      repositoryError("INVALID_INPUT"),
    );

    const correction = await writer.beginValidatedManifest(await manifest(2));
    if (correction.action !== "stage") throw new Error("fixture must stage");
    await writer.stageCanonicalLines(
      OWNER_A,
      correction.generation,
      canonicalLines(1, "staging"),
    );
    const [duringCorrection] = await reader.listActivePartitions(OWNER_A);
    assert.ok(duringCorrection);
    assert.equal(
      duringCorrection.scope.generationId,
      activeGeneration.generationId,
      "the active-generation join must not expose staging rows",
    );
    assert.equal(duringCorrection.evidence.acceptedRows, 1_001);
    assert.equal(
      duringCorrection.evidence.rejectedRows,
      7,
      "the active generation retains its immutable rejection evidence",
    );
    assert.equal(
      duringCorrection.evidence.activeSourceUpdatedAtIso,
      "2026-07-31T11:01:00.000Z",
    );
    assert.equal(
      duringCorrection.evidence.activeObservedAtIso,
      "2026-07-31T12:01:00.000Z",
    );
    assert.equal(
      duringCorrection.evidence.activeCommittedAtIso,
      "2026-07-31T12:01:30.000Z",
    );
    assert.deepEqual(
      sourceHealthEvidence(duringCorrection),
      sourceHealthBeforeCorrection,
      "staging correction metadata must not change active source health",
    );
    const currentPartition = await database.prepare(
      `SELECT source_updated_at, observed_at, accepted_rows, rejected_rows,
              active_source_updated_at, active_observed_at,
              active_accepted_rows, active_rejected_rows
         FROM finops_export_partitions
        WHERE connection_id = ? AND billing_period = ?`,
    ).bind(CONNECTION_A, "2026-07").first();
    assert.deepEqual(currentPartition, {
      source_updated_at: "2026-07-31T11:02:00.000Z",
      observed_at: "2026-07-31T12:02:00.000Z",
      accepted_rows: 0,
      rejected_rows: 0,
      active_source_updated_at: "2026-07-31T11:01:00.000Z",
      active_observed_at: "2026-07-31T12:01:00.000Z",
      active_accepted_rows: 1_001,
      active_rejected_rows: 7,
    });
    const materialized = await reader.loadActivePartition(
      OWNER_A,
      duringCorrection,
    );
    assert.equal(materialized.rows.length, 1_001);
    assert.equal(
      materialized.rows.some(({ line }) =>
        line.lineItemId.startsWith("staging-")),
      false,
    );
  });
});

test("rejects cross-tenant, fixture, disabled, malformed, and stale-generation reads", async () => {
  await withDatabase(async ({ database, writer, reader }) => {
    await publish(writer, 1, canonicalLines(1));
    const [partition] = await reader.listActivePartitions(OWNER_A);
    assert.ok(partition);
    const original = await database.prepare(
      `SELECT canonical_json
         FROM finops_billing_lines_v2
        WHERE connection_id = ? AND generation_id = ?
        LIMIT 1`,
    ).bind(
      CONNECTION_A,
      partition.scope.generationId,
    ).first();
    assert.equal(typeof original?.canonical_json, "string");

    await assert.rejects(
      reader.listActivePartitions({
        orgId: ORG_B,
        customerId: CUSTOMER_B,
        connectionId: CONNECTION_A,
      }),
      repositoryError("SCOPE_NOT_FOUND"),
    );
    await assert.rejects(
      reader.listActivePartitions({
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        connectionId: SIMULATED,
      }),
      repositoryError("SCOPE_NOT_FOUND"),
    );

    await database.prepare(
      `UPDATE finops_export_partitions
          SET active_accepted_rows = 250001
        WHERE connection_id = ? AND billing_period = ?`,
    ).bind(CONNECTION_A, partition.scope.billingPeriod).run();
    await assert.rejects(
      reader.listActivePartitions(OWNER_A),
      repositoryError("LIMIT_EXCEEDED"),
    );
    await database.prepare(
      `UPDATE finops_export_partitions
          SET active_accepted_rows = 1
        WHERE connection_id = ? AND billing_period = ?`,
    ).bind(CONNECTION_A, partition.scope.billingPeriod).run();

    await database.prepare(
      `UPDATE finops_billing_lines_v2
          SET canonical_json = '{'
        WHERE connection_id = ? AND generation_id = ?`,
    ).bind(CONNECTION_A, partition.scope.generationId).run();
    await assert.rejects(
      reader.loadActivePartition(OWNER_A, partition),
      repositoryError("MALFORMED_CANONICAL_JSON"),
    );

    await database.prepare(
      `UPDATE finops_billing_lines_v2
          SET canonical_json = ?
        WHERE connection_id = ? AND generation_id = ?`,
    ).bind(
      original.canonical_json,
      CONNECTION_A,
      partition.scope.generationId,
    ).run();
    await database.prepare(
      `UPDATE finops_export_partitions
          SET active_generation_id = ?
        WHERE connection_id = ? AND billing_period = ?`,
    ).bind(
      `fbg_${"f".repeat(64)}`,
      CONNECTION_A,
      partition.scope.billingPeriod,
    ).run();
    await assert.rejects(
      reader.pageActiveRows(OWNER_A, partition),
      repositoryError("GENERATION_MISMATCH"),
    );

    await database.prepare(
      "UPDATE aws_connections SET status = 'disabled' WHERE id = ?",
    ).bind(CONNECTION_A).run();
    await assert.rejects(
      reader.pageActiveRows(OWNER_A, partition),
      repositoryError("SCOPE_NOT_FOUND"),
    );
  });
});
