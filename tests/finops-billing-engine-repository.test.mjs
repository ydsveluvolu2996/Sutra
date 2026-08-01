import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  FinopsBillingEngineRepository,
  FinopsBillingEngineRepositoryError,
} = await import("../db/finops-billing-engine-repository.ts");
const { validateFinopsDataExportManifest } = await import("../lib/finops-data-export.ts");
const { parseCurCsv } = await import("../lib/finops-cur.ts");

const ORG_A = "org_bill_a";
const ORG_B = "org_bill_b";
const CUSTOMER_A = "cust_bill_a";
const CUSTOMER_B = "cust_bill_b";
const CONN_A = "conn_" + "a".repeat(32);
const CONN_B = "conn_" + "b".repeat(32);
const SIMULATED = "conn_" + "c".repeat(32);
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONN_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B, connectionId: CONN_B };

function connectionRow(database, id, orgId, customerId, account, sourceKind = "aws_trust_role", status = "active") {
  return database.prepare(
    `INSERT INTO aws_connections
       (id, org_id, customer_id, source_kind, fixture_id, aws_account_id,
        role_arn, external_id_ciphertext, external_id_key_version,
        permission_pack_version, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ct', 'v1', 'pack-v1', ?)`,
  ).bind(
    id, orgId, customerId, sourceKind,
    sourceKind === "simulated_fixture" ? "fixture-one" : null,
    account,
    sourceKind === "aws_trust_role" ? `arn:aws:iam::${account}:role/sutra` : "",
    status,
  );
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-finops-billing-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'bill-a', 'Bill A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'bill-b', 'Bill B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'bill-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'bill-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
      connectionRow(database, CONN_A, ORG_A, CUSTOMER_A, "111122223333"),
      connectionRow(database, CONN_B, ORG_B, CUSTOMER_B, "444455556666"),
      connectionRow(database, SIMULATED, ORG_A, CUSTOMER_A, "999900001111", "simulated_fixture"),
    ]);
    await run(new FinopsBillingEngineRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

async function validatedManifest(scope = SCOPE_A, revision = 1, fileCount = 1) {
  const result = await validateFinopsDataExportManifest({
    scope: {
      organizationId: scope.orgId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
    },
    bucket: "sutra-customer-billing",
    manifestKey: "exports/aws-cur/metadata/BILLING_PERIOD=2026-07/aws-cur-Manifest.json",
    eTag: `"etag-${revision}"`,
    versionId: `version-${revision}`,
    observedAtIso: `2026-07-31T12:0${revision}:00Z`,
    body: {
      metadata: { exportName: "aws-cur", exportTableName: "COST_AND_USAGE_REPORT" },
      columns: ["line_item_id", "line_item_unblended_cost", `revision_${revision}`],
      dataFiles: Array.from({ length: fileCount }, (_, index) =>
        `exports/aws-cur/data/BILLING_PERIOD=2026-07/aws-cur-${String(revision).padStart(5, "0")}-${String(index).padStart(5, "0")}.csv.gz`),
    },
  });
  if (!result.ok) throw new Error(result.rejection.message);
  return result.manifest;
}

function canonicalLines(rows) {
  const parsed = parseCurCsv([
    "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,resource_tags_user_env",
    ...rows,
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.lines;
}

function repositoryError(code) {
  return (error) => error instanceof FinopsBillingEngineRepositoryError && error.code === code;
}

test("a reconciled generation becomes visible atomically and duplicate content is idempotent", async () => {
  await withDatabase(async (repo, database) => {
    const manifest = await validatedManifest();
    const began = await repo.beginValidatedManifest(manifest, Date.parse("2026-07-31T12:01:00Z"));
    assert.equal(began.action, "stage");
    assert.equal(began.reason, "first_delivery");

    const lines = canonicalLines([
      "li-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,10.50,USD,prod",
      "li-2,111122223333,AmazonS3,Usage,2026-07-01T01:00:00Z,0.25,USD,prod",
      "li-3,111122223333,AmazonRDS,Usage,2026-07-01T02:00:00Z,3.00,EUR,prod",
    ]);
    await repo.stageCanonicalLines(SCOPE_A, began.generation, lines.slice(0, 2));
    await repo.stageCanonicalLines(SCOPE_A, began.generation, lines.slice(2));
    assert.deepEqual(await repo.listActiveLines(SCOPE_A), [], "staging rows must not be visible");

    const committed = await repo.commitGeneration(SCOPE_A, began.generation, {
      acceptedRows: 3,
      rejectedRows: 1,
      processedObjectCount: 1,
      currencyTotals: { EUR: "3000000", USD: "10750000" },
    }, Date.parse("2026-07-31T12:02:00Z"));
    assert.equal(committed.alreadyCommitted, false);
    assert.equal(committed.processedObjectCount, 1);
    assert.deepEqual(
      (await repo.listActiveLines(SCOPE_A)).map((row) => row.line.lineItemId),
      ["li-1", "li-2", "li-3"],
    );
    assert.deepEqual(await repo.activeCurrencyTotals(SCOPE_A), [
      { currency: "EUR", amountMicros: "3000000", lineCount: 1 },
      { currency: "USD", amountMicros: "10750000", lineCount: 2 },
    ]);

    const duplicateBegin = await repo.beginValidatedManifest(manifest);
    assert.equal(duplicateBegin.action, "skip");
    assert.equal(duplicateBegin.generation.generationId, began.generation.generationId);
    const duplicateCommit = await repo.commitGeneration(SCOPE_A, began.generation, {
      acceptedRows: 3,
      rejectedRows: 1,
      processedObjectCount: 1,
      currencyTotals: { EUR: "3000000", USD: "10750000" },
    });
    assert.equal(duplicateCommit.alreadyCommitted, true);

    const count = await database.prepare(
      "SELECT COUNT(*) AS count FROM finops_billing_lines_v2 WHERE generation_id = ?",
    ).bind(began.generation.generationId).first();
    assert.equal(Number(count?.count), 3);
  });
});

test("same-content chunk retries do not duplicate rows and conflicting line content is rejected", async () => {
  await withDatabase(async (repo, database) => {
    const began = await repo.beginValidatedManifest(await validatedManifest());
    if (began.action !== "stage") throw new Error("fixture must stage");
    const [line] = canonicalLines([
      "stable-id,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD,prod",
    ]);
    await repo.stageCanonicalLines(SCOPE_A, began.generation, [line]);
    await repo.stageCanonicalLines(SCOPE_A, began.generation, [line]);
    const count = await database.prepare(
      "SELECT COUNT(*) AS count FROM finops_billing_lines_v2 WHERE generation_id = ?",
    ).bind(began.generation.generationId).first();
    assert.equal(Number(count?.count), 1);

    await assert.rejects(
      repo.stageCanonicalLines(SCOPE_A, began.generation, [{ ...line, amountMicros: "2000000" }]),
      repositoryError("LINE_CONFLICT"),
    );
    await repo.commitGeneration(SCOPE_A, began.generation, {
      acceptedRows: 1,
      rejectedRows: 0,
      processedObjectCount: 1,
      currencyTotals: { USD: "1000000" },
    });
  });
});

test("failed corrected generations leave the previous active generation and file evidence visible", async () => {
  await withDatabase(async (repo, database) => {
    const first = await repo.beginValidatedManifest(await validatedManifest(SCOPE_A, 1, 2));
    if (first.action !== "stage") throw new Error("fixture must stage");
    const firstLines = canonicalLines([
      "old-line,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,5.00,USD,prod",
    ]);
    await repo.stageCanonicalLines(SCOPE_A, first.generation, firstLines);
    await repo.commitGeneration(SCOPE_A, first.generation, {
      acceptedRows: 1,
      rejectedRows: 0,
      processedObjectCount: 2,
      currencyTotals: { USD: "5000000" },
    });

    const correction = await repo.beginValidatedManifest(await validatedManifest(SCOPE_A, 2, 3));
    if (correction.action !== "stage") throw new Error("fixture must stage");
    const activeWhileCorrecting = await database.prepare(
      `SELECT active_generation_id, active_manifest_sha256,
              active_source_table, active_source_format, active_source_version,
              active_observed_at, active_accepted_rows, active_rejected_rows,
              active_file_count, file_count,
              active_currency_totals_json, active_committed_at,
              observed_at, accepted_rows, rejected_rows
         FROM finops_export_partitions
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
          AND export_name = ? AND billing_period = ?`,
    ).bind(
      SCOPE_A.orgId,
      SCOPE_A.customerId,
      SCOPE_A.connectionId,
      first.generation.exportName,
      first.generation.billingPeriod,
    ).first();
    assert.equal(activeWhileCorrecting?.active_generation_id, first.generation.generationId);
    assert.equal(activeWhileCorrecting?.active_manifest_sha256, first.generation.generationId.slice(4));
    assert.equal(activeWhileCorrecting?.active_source_table, "COST_AND_USAGE_REPORT");
    assert.equal(activeWhileCorrecting?.active_source_format, "aws-cur");
    assert.equal(activeWhileCorrecting?.active_source_version, "2.0");
    assert.equal(activeWhileCorrecting?.active_observed_at, "2026-07-31T12:01:00.000Z");
    assert.equal(Number(activeWhileCorrecting?.active_accepted_rows), 1);
    assert.equal(Number(activeWhileCorrecting?.active_rejected_rows), 0);
    assert.equal(Number(activeWhileCorrecting?.active_file_count), 2);
    assert.equal(Number(activeWhileCorrecting?.file_count), 3);
    assert.equal(activeWhileCorrecting?.active_currency_totals_json, "{\"USD\":\"5000000\"}");
    assert.equal(typeof activeWhileCorrecting?.active_committed_at, "string");
    assert.equal(activeWhileCorrecting?.observed_at, "2026-07-31T12:02:00.000Z");
    assert.equal(Number(activeWhileCorrecting?.accepted_rows), 0);
    assert.equal(Number(activeWhileCorrecting?.rejected_rows), 0);
    const correctedLines = canonicalLines([
      "new-line,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,7.00,USD,prod",
    ]);
    await repo.stageCanonicalLines(SCOPE_A, correction.generation, correctedLines);
    assert.equal((await repo.listActiveLines(SCOPE_A))[0]?.line.lineItemId, "old-line");
    await assert.rejects(
      repo.commitGeneration(SCOPE_A, correction.generation, {
        acceptedRows: 1,
        rejectedRows: 0,
        processedObjectCount: 2,
        currencyTotals: { USD: "7000000" },
      }),
      repositoryError("OBJECT_COUNT_MISMATCH"),
    );
    assert.equal((await repo.listActiveLines(SCOPE_A))[0]?.line.lineItemId, "old-line");
    const afterObjectMismatch = await database.prepare(
      "SELECT active_generation_id, active_file_count, status FROM finops_export_partitions WHERE connection_id = ?",
    ).bind(CONN_A).first();
    assert.equal(afterObjectMismatch?.active_generation_id, first.generation.generationId);
    assert.equal(Number(afterObjectMismatch?.active_file_count), 2);
    assert.equal(afterObjectMismatch?.status, "failed");

    const badRows = await repo.beginValidatedManifest(await validatedManifest(SCOPE_A, 3, 3));
    if (badRows.action !== "stage") throw new Error("fixture must stage");
    await repo.stageCanonicalLines(SCOPE_A, badRows.generation, correctedLines);
    await assert.rejects(
      repo.commitGeneration(SCOPE_A, badRows.generation, {
        acceptedRows: 2,
        rejectedRows: 0,
        processedObjectCount: 3,
        currencyTotals: { USD: "7000000" },
      }),
      repositoryError("ROW_COUNT_MISMATCH"),
    );
    assert.equal((await repo.listActiveLines(SCOPE_A))[0]?.line.lineItemId, "old-line");

    const badTotals = await repo.beginValidatedManifest(await validatedManifest(SCOPE_A, 4, 4));
    if (badTotals.action !== "stage") throw new Error("fixture must stage");
    await repo.stageCanonicalLines(SCOPE_A, badTotals.generation, correctedLines);
    await assert.rejects(
      repo.commitGeneration(SCOPE_A, badTotals.generation, {
        acceptedRows: 1,
        rejectedRows: 0,
        processedObjectCount: 4,
        currencyTotals: { USD: "8000000" },
      }),
      repositoryError("CURRENCY_TOTAL_MISMATCH"),
    );
    assert.equal((await repo.listActiveLines(SCOPE_A))[0]?.line.lineItemId, "old-line");

    const replacement = await repo.beginValidatedManifest(await validatedManifest(SCOPE_A, 5, 5));
    if (replacement.action !== "stage") throw new Error("fixture must stage");
    await repo.stageCanonicalLines(SCOPE_A, replacement.generation, correctedLines);
    await repo.commitGeneration(SCOPE_A, replacement.generation, {
      acceptedRows: 1,
      rejectedRows: 0,
      processedObjectCount: 5,
      currencyTotals: { USD: "7000000" },
    });
    assert.equal((await repo.listActiveLines(SCOPE_A))[0]?.line.lineItemId, "new-line");
    const activeReplacement = await database.prepare(
      "SELECT active_file_count FROM finops_export_partitions WHERE connection_id = ?",
    ).bind(CONN_A).first();
    assert.equal(Number(activeReplacement?.active_file_count), 5);
  });
});

test("currency reconciliation uses bigint-safe totals above Number and signed-bigint ranges", async () => {
  await withDatabase(async (repo) => {
    const began = await repo.beginValidatedManifest(await validatedManifest());
    if (began.action !== "stage") throw new Error("fixture must stage");
    const [base, second] = canonicalLines([
      "huge-line,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD,prod",
      "huge-line-2,111122223333,AmazonEC2,Usage,2026-07-01T01:00:00Z,1.00,USD,prod",
    ]);
    const each = "9000000000000000000";
    const exact = "18000000000000000000";
    await repo.stageCanonicalLines(SCOPE_A, began.generation, [
      { ...base, amountMicros: each },
      { ...second, amountMicros: each },
    ]);
    await repo.commitGeneration(SCOPE_A, began.generation, {
      acceptedRows: 2,
      rejectedRows: 0,
      processedObjectCount: 1,
      currencyTotals: { USD: exact },
    });
    assert.deepEqual(await repo.activeCurrencyTotals(SCOPE_A), [
      { currency: "USD", amountMicros: exact, lineCount: 2 },
    ]);
  });
});

test("tenant, customer, connection, generation, and live-source ownership are enforced", async () => {
  await withDatabase(async (repo, database) => {
    await assert.rejects(
      repo.beginValidatedManifest(await validatedManifest(
        { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: SIMULATED },
      )),
      repositoryError("SCOPE_NOT_FOUND"),
    );
    const began = await repo.beginValidatedManifest(await validatedManifest(SCOPE_A));
    if (began.action !== "stage") throw new Error("fixture must stage");
    const lines = canonicalLines([
      "tenant-line,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD,prod",
    ]);
    await assert.rejects(
      repo.stageCanonicalLines(SCOPE_B, began.generation, lines),
      repositoryError("GENERATION_MISMATCH"),
    );
    await assert.rejects(
      repo.stageCanonicalLines(SCOPE_A, {
        ...began.generation,
        generationId: "fbg_" + "f".repeat(64),
      }, lines),
      repositoryError("GENERATION_MISMATCH"),
    );
    await repo.stageCanonicalLines(SCOPE_A, began.generation, lines);
    await repo.commitGeneration(SCOPE_A, began.generation, {
      acceptedRows: 1,
      rejectedRows: 0,
      processedObjectCount: 1,
      currencyTotals: { USD: "1000000" },
    });
    assert.deepEqual(await repo.listActiveLines(SCOPE_B), []);

    await database.prepare("UPDATE aws_connections SET status = 'disabled' WHERE id = ?").bind(CONN_A).run();
    assert.deepEqual(await repo.listActiveLines(SCOPE_A), [], "disabled connections are not live query sources");
    await assert.rejects(
      repo.beginValidatedManifest(await validatedManifest(SCOPE_A, 2)),
      repositoryError("SCOPE_NOT_FOUND"),
    );
  });
});
