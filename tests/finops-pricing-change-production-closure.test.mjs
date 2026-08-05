import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { PricingChangeCur2Reader } = await import("../db/finops-pricing-change-cur2-reader.ts");
const { PricingChangeRuntimeRepository } = await import("../db/finops-pricing-change-runtime-repository.ts");
const { createPricingChangeProductionJobHandler, pricingChangeRuntimeRequestKey } = await import("../lib/finops-pricing-change-production-composition.ts");
const root = path.resolve(import.meta.dirname, "..");
const org = "org_pricing_closure", customer = "customer_pricing_closure", connection = `conn_${"a".repeat(32)}`;
const scope = { organizationId: org, customerId: customer, connectionId: connection }, account = "111122223333";

async function database() {
  const miniflare = new Miniflare({ modules: true, script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `pricing-closure-${crypto.randomUUID()}` }, d1Persist: false });
  const db = await miniflare.getD1Database("DB"); runtimeMigrations.resetRuntimeSchemaCacheForTests(); await runtimeMigrations.ensureRuntimeSchema(db);
  await db.batch([
    db.prepare("INSERT INTO organizations(id,slug,name,status) VALUES(?,'pricing-closure','Pricing closure','active')").bind(org),
    db.prepare("INSERT INTO customers(id,org_id,slug,name,status) VALUES(?,?,'pricing-customer','Pricing customer','active')").bind(customer, org),
    db.prepare(`INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,external_id_ciphertext,
      external_id_key_version,permission_pack_version,status,enabled_regions_json) VALUES(?,?,?,'aws_trust_role','aws',?,?,'ct','v1',
      'standard-2026-08.17','active','["us-east-1"]')`).bind(connection, org, customer, account, `arn:aws:iam::${account}:role/sutra/SutraCollectorRole`),
  ]);
  return { miniflare, db };
}
function line(index) { const id = `line_${String(index).padStart(6, "0")}`; return { id, value: { lineItemId: id, sourceFormat: "aws-cur", sourceVersion: "2.0",
  payerAccountId: account, usageAccountId: account, productCode: "AmazonEC2", region: "us-east-1", usageStartIso: "2026-06-01T00:00:00.000Z",
  usageEndIso: "2026-06-01T01:00:00.000Z", chargeCategory: "Usage", pricingTerm: "OnDemand", pricingCurrency: "USD", currency: "USD",
  usageAmountMicros: "1000000", usageUnit: "Hrs", operation: "RunInstances", productFamily: "Compute Instance", usageType: "BoxUsage" } }; }

test("full CUR2 reader exhausts more than the UI query ceiling and pins one active generation", async () => {
  const { miniflare, db } = await database();
  try {
    const generationId = `fbg_${"b".repeat(64)}`, manifest = "c".repeat(64), rows = 1_001;
    await db.prepare(`INSERT INTO finops_export_partitions(id,org_id,customer_id,connection_id,export_name,billing_period,source_table,
      source_format,source_version,status,manifest_bucket,manifest_key,manifest_sha256,schema_sha256,source_updated_at,observed_at,
      active_generation_id,active_manifest_sha256,active_source_table,active_source_format,active_source_version,active_source_updated_at,
      active_observed_at,active_accepted_rows,active_rejected_rows,active_file_count,active_currency_totals_json,active_committed_at,
      accepted_rows,rejected_rows,file_count,columns_json,data_files_json,currency_totals_json,committed_at,created_at,updated_at)
      VALUES('partition-pricing',?,?,?,'cur2-main','2026-06','CUR2.0','aws-cur','2.0','ready','bucket','manifest.json',?,?,'2026-07-01T01:00:00.000Z',
      '2026-07-01T01:00:00.000Z',?,?,'CUR2.0','aws-cur','2.0','2026-07-01T01:00:00.000Z','2026-07-01T01:00:00.000Z',?,0,1,'{"USD":"0"}',
      '2026-07-01T01:00:00.000Z',?,0,1,'[]','[]','{"USD":"0"}','2026-07-01T01:00:00.000Z','2026-07-01T01:00:00.000Z','2026-07-01T01:00:00.000Z')`)
      .bind(org, customer, connection, manifest, "d".repeat(64), generationId, manifest, rows, rows).run();
    for (let offset = 0; offset < rows; offset += 100) {
      const statements = [];
      for (let index = offset; index < Math.min(rows, offset + 100); index += 1) { const item = line(index); statements.push(db.prepare(`INSERT INTO finops_billing_lines_v2
        (id,org_id,customer_id,connection_id,export_name,billing_period,generation_id,source_format,source_version,line_item_id,usage_account_id,
         service,charge_kind,charge_category,usage_start,amount_micros,currency,tags_json,cost_categories_json,canonical_json,created_at)
         VALUES(?,?,?,?,?,'2026-06',?,'aws-cur','2.0',?,?,'AmazonEC2','usage','Usage','2026-06-01T00:00:00.000Z','0','USD','{}','{}',?,'2026-07-01T01:00:00.000Z')`)
        .bind(`row-${item.id}`, org, customer, connection, "cur2-main", generationId, item.id, account, JSON.stringify(item.value))); }
      await db.batch(statements);
    }
    const active = { source: "ACTIVE_RECONCILED_CUR2_GENERATION", scope, partition: "aws", exportName: "cur2-main", billingPeriod: "2026-06",
      generationId, manifestSha256: manifest, generatedAtIso: "2026-07-01T01:00:00.000Z", usagePeriodStartAt: "2026-06-01T00:00:00.000Z",
      usagePeriodEndAt: "2026-07-01T00:00:00.000Z", sourceFormat: "aws-cur", sourceVersion: "2.0", payerAccountIds: [account],
      linkedAccountIds: [account], regions: ["us-east-1"], coverage: { readPermissionsValidated: true, manifestObjectCount: 1,
        processedObjectCount: 1, acceptedRowCount: rows, rejectedRowCount: 0 } };
    const artifact = await new PricingChangeCur2Reader(db).read(scope, active);
    assert.equal(artifact.sourceRowCount, rows); assert.equal(artifact.selectedUsageRowCount, rows); assert.equal(artifact.rowsExhausted, true);
    assert.equal(artifact.rows[1_000].usageId, "line_001000");
    await assert.rejects(new PricingChangeCur2Reader(db).read(scope, { ...active, generationId: `fbg_${"e".repeat(64)}` }), /generation could not be read/iu);
  } finally { await miniflare.dispose(); }
});

test("runtime acceptance is immutable, same-tenant, and replay-addressable", async () => {
  const { miniflare, db } = await database();
  try {
    const snapshotId = `pca_${"1".repeat(64)}`, evidence = `fss_${"2".repeat(64)}`, generation = `fbg_${"3".repeat(64)}`;
    await db.prepare(`INSERT INTO finops_pricing_change_materializations(snapshot_id,org_id,customer_id,connection_id,evidence_generation_id,state,
      content_sha256,evidence_reference_ciphertext,evidence_reference_key_version,captured_at,usage_period_start_at,usage_period_end_at,
      baseline_effective_at,comparison_effective_at,active_cur2_generation_id,input_line_count,modeled_line_count,excluded_line_count,
      catalog_snapshot_count,catalog_term_count,created_at) VALUES(?,?,?,?,?,'no_usage',?,'fsev1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','v1',
      '2026-08-02T00:00:00.000Z','2026-06-01T00:00:00.000Z','2026-07-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',?,0,0,0,0,0,1)`).bind(snapshotId, org, customer, connection, evidence, "4".repeat(64), generation).run();
    const repository = new PricingChangeRuntimeRepository(db), accepted = { requestKey: `pcrt_${"5".repeat(64)}`, scope, jobId: "job-pricing-1",
      policyId: "policy-pricing-1", snapshotId, evidenceGenerationId: evidence, contentSha256: "4".repeat(64), activeCur2GenerationId: generation,
      capturedAt: "2026-08-02T00:00:00.000Z", becameActive: true, acceptedAt: 10 };
    assert.deepEqual(await repository.accept(accepted), accepted);
    assert.deepEqual(await repository.getAccepted(scope, accepted.requestKey), accepted);
    await assert.rejects(repository.accept({ ...accepted, contentSha256: "6".repeat(64) }), /persistence rejected/iu);
    await assert.rejects(db.prepare("UPDATE finops_pricing_change_runtime_acceptances SET accepted_at=11").run(), /FINOPS_PRICING_CHANGE_RUNTIME_IMMUTABLE/u);
  } finally { await miniflare.dispose(); }
});

test("closure pins exact shared deltas without normalizing upstream discrepancies", async () => {
  const [definition, sqlite, postgres, provider] = await Promise.all([
    readFile(path.join(root, "lib/finops-pricing-change-official-definition.ts"), "utf8"),
    readFile(path.join(root, "drizzle/0128_finops_pricing_change_runtime.sql"), "utf8"),
    readFile(path.join(root, "postgres/migrations/0124_finops_pricing_change_runtime.sql"), "utf8"),
    readFile(path.join(root, "services/aws-collector/src/pricing-change-provider-adapter.ts"), "utf8"),
  ]);
  assert.match(definition, /guidanceCategory: "Additional"/u); assert.match(definition, /manifestCategory: "ADVANCED"/u);
  assert.match(definition, /version: "v1\.1\.0"/u); assert.match(definition, /changelogVersion: "v1\.0\.1"/u);
  for (const sql of [sqlite, postgres]) assert.match(sql, /PRICING_CHANGE_RUNTIME_IMMUTABLE/u);
  assert.match(provider, /standard-2026-08\.17/u); assert.match(provider, /pricing:ListPriceLists/u); assert.match(provider, /pricing:GetPriceListFileUrl/u);
});

test("durably accepted queue replay performs no policy, CUR2, provider, archive, or persistence work", async () => {
  const job = { id: "pricing-job-1", orgId: org, customerId: customer, connectionId: connection,
    kind: "finops-pricing-change-materialize", payload: { connectionId: connection, policyId: "policy-pricing" }, attempt: 2, maxAttempts: 5 };
  const requestKey = await pricingChangeRuntimeRequestKey(job); let work = 0;
  const accepted = { requestKey, scope, jobId: job.id, policyId: "policy-pricing", snapshotId: `pca_${"1".repeat(64)}`,
    evidenceGenerationId: `fss_${"2".repeat(64)}`, contentSha256: "3".repeat(64), activeCur2GenerationId: `fbg_${"4".repeat(64)}`,
    capturedAt: "2026-08-02T00:00:00.000Z", becameActive: true, acceptedAt: 1 };
  const handler = createPricingChangeProductionJobHandler({
    dependencies: { loadPolicy: async () => { work += 1; return null; }, loadActiveCur2: async () => { work += 1; return null; },
      evidence: { archive: async () => { work += 1; throw new Error("unexpected"); } },
      sealer: { seal: async () => { work += 1; throw new Error("unexpected"); } },
      materializations: { recordMaterialization: async () => { work += 1; throw new Error("unexpected"); } } },
    materializer: { collect: async () => { work += 1; throw new Error("unexpected"); } },
    runtime: { getAccepted: async () => accepted, accept: async (value) => value, recordFailure: async () => { work += 1; } },
  });
  await handler(job); assert.equal(work, 0);
});
