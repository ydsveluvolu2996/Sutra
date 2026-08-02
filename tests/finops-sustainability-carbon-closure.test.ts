import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { normalizeSustainabilityCarbonCapture } from "../lib/finops-sustainability-carbon.ts";
import { buildSustainabilityDashboard } from "../lib/finops-sustainability-dashboard.ts";

const root = path.resolve(import.meta.dirname, "..");
const connectionId = `conn_${"a".repeat(32)}`;
const scope = { orgId: "org_sustainability", customerId: "customer_sustainability", connectionId, accountId: "111122223333", partition: "aws" as const };
const unavailable = { state: "unavailable" as const, value: null, sourceField: null, sourceVersion: null };
const ready = (value: string, sourceField: string) => ({ state: "ready" as const, value, sourceField, sourceVersion: "cur2-contract-2026-08" });

function capture() {
  return { schemaVersion: "sutra.sustainability-carbon.v1" as const, scope,
    captureId: `sustainability_${"b".repeat(64)}`, startedAtIso: "2026-08-02T00:00:00.000Z", completedAtIso: "2026-08-02T00:01:00.000Z",
    allowedUsageAccountIds: [scope.accountId], configuration: { cur2Configured: true, carbonExportConfigured: true, carbonExportAccessValidated: true },
    proxyEvidence: { source: "AWS_CUR2_ACTIVE_GENERATION" as const, generationId: `fbg_${"c".repeat(64)}`, manifestSha256: "d".repeat(64), dataThroughAtIso: "2026-08-02T00:00:00.000Z", rowsExhausted: true,
      rows: [{ lineItemId: "line-1", usageAccountId: scope.accountId, service: "AmazonEC2", region: "us-east-1", resourceId: "i-1", usageStartIso: "2026-08-01T00:00:00.000Z", usageEndIso: "2026-08-01T01:00:00.000Z", usageType: "BoxUsage:m7g.large", sourceUsageUnit: "vCPU-Hours", sourceUsageQuantityMicros: "2000000", metric: "COMPUTE_VCPU_HOURS" as const, normalization: { kind: "IDENTITY" as const, numerator: "1", denominator: "1", evidenceSource: null, evidenceVersion: null }, workloadTagKey: "Workload", workloadTagValue: "payments",
        dimensions: { processorArchitecture: ready("AWS Graviton", "product_physical_processor"), instanceFamily: ready("m7g", "product_instance_family"), storageClass: unavailable, transferPath: unavailable, idleNetworkResource: unavailable, regionLatitudeE6: ready("39043000", "pinned_region_reference.latitude"), regionLongitudeE6: ready("-77048000", "pinned_region_reference.longitude"), renewableEnergyClass: ready("95_PERCENT_RENEWABLE_2023", "pinned_region_reference.is95percentrenewable") } }] },
    carbonEvidence: null };
}

test("versioned dimensions carry exact lineage and never infer unavailable fields", () => {
  const snapshot = normalizeSustainabilityCarbonCapture(capture(), scope, Date.parse("2026-08-02T01:00:00.000Z"));
  const dimensions = snapshot.proxy.rows[0]?.dimensions;
  assert.equal(dimensions?.processorArchitecture.value, "AWS Graviton");
  assert.equal(dimensions?.processorArchitecture.sourceField, "product_physical_processor");
  assert.equal(dimensions?.storageClass.state, "unavailable");
  assert.equal(dimensions?.storageClass.value, null);
});

test("governed targets evaluate technical proxy evidence without becoming carbon claims", () => {
  const snapshot = normalizeSustainabilityCarbonCapture(capture(), scope, Date.parse("2026-08-02T01:00:00.000Z"));
  const report = buildSustainabilityDashboard(snapshot, {}, Date.parse("2026-08-02T01:00:00.000Z"), [{ targetId: `stgt_${"1".repeat(64)}`, versionId: `stgv_${"2".repeat(64)}`, metric: "COMPUTE_VCPU_HOURS", workloadTagKey: "Workload", workloadTagValue: "payments", periodStart: "2026-08", targetValueMicros: "1500000", unit: "vCPU-hours", state: "ACTIVE", reason: "Approved efficiency threshold", actorId: "user_admin", createdAtIso: "2026-08-01T00:00:00.000Z" }]);
  assert.equal(report.proxy.targets.configured, true);
  assert.equal(report.proxy.targets.workloadTagGoals[0]?.state, "ABOVE_TARGET");
  assert.equal(report.proxy.targets.workloadTagGoals[0]?.interpretation, "TECHNICAL_RESOURCE_USE_TARGET_NOT_CARBON_TARGET");
  assert.equal(Object.hasOwn(report.proxy.targets.workloadTagGoals[0] ?? {}, "carbon"), false);
});

test("target, runtime replay migrations and mutation route are immutable and tenant-authorized", async () => {
  const [sqlite, postgres, route, runtime] = await Promise.all([
    readFile(path.join(root, "drizzle/0126_finops_sustainability_targets.sql"), "utf8"),
    readFile(path.join(root, "postgres/migrations/0122_finops_sustainability_targets.sql"), "utf8"),
    readFile(path.join(root, "app/api/v1/finops/sustainability-carbon/targets/route.ts"), "utf8"),
    readFile(path.join(root, "db/finops-sustainability-runtime-repository.ts"), "utf8"),
  ]);
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /finops_sustainability_target_versions/u);
    assert.match(sql, /FINOPS_SUSTAINABILITY_TARGET_VERSION_IMMUTABLE/u);
    assert.match(sql, /finops_sustainability_runtime_attempts/u);
  }
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /connection:manage/u);
  assert.match(runtime, /getAccepted/u);
  assert.match(runtime, /ON CONFLICT DO NOTHING/u);
});

test("SQLite target heads accept only a linked immutable successor", async () => {
  const [snapshotSql, targetSql] = await Promise.all([
    readFile(path.join(root, "drizzle/0099_finops_sustainability_carbon.sql"), "utf8"),
    readFile(path.join(root, "drizzle/0126_finops_sustainability_targets.sql"), "utf8"),
  ]);
  const miniflare = new Miniflare({ modules: true,
    script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `sustain-target-${crypto.randomUUID()}` }, d1Persist: false });
  try {
    const db = await miniflare.getD1Database("DB");
    await db.prepare("CREATE TABLE organizations(id text PRIMARY KEY)").run();
    await db.prepare("CREATE TABLE customers(id text PRIMARY KEY)").run();
    await db.prepare("CREATE TABLE aws_connections(id text PRIMARY KEY)").run();
    for (const sql of [snapshotSql, targetSql]) for (const statement of sql.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    await db.batch([db.prepare("INSERT INTO organizations VALUES('org_sustainability')"), db.prepare("INSERT INTO customers VALUES('customer_sustainability')"), db.prepare("INSERT INTO aws_connections VALUES(?)").bind(connectionId)]);
    const targetId = `stgt_${"1".repeat(64)}`, first = `stgv_${"2".repeat(64)}`, second = `stgv_${"3".repeat(64)}`, forged = `stgv_${"4".repeat(64)}`;
    const insert = (versionId: string, prior: string | null, at: number) => db.prepare("INSERT INTO finops_sustainability_target_versions(version_id,target_id,org_id,customer_id,connection_id,metric,workload_tag_key,workload_tag_value,period_start,target_value_micros,unit,state,reason,actor_id,prior_version_id,content_sha256,created_at) VALUES(?,?,?,?,?,'COMPUTE_VCPU_HOURS',NULL,NULL,'2026-08','1000000','vCPU-hours','ACTIVE','approved','user_admin',?,?,?)").bind(versionId, targetId, "org_sustainability", "customer_sustainability", connectionId, prior, versionId.slice(5), at);
    await insert(first, null, 1).run();
    await db.prepare("INSERT INTO finops_sustainability_target_heads VALUES(?,?,?,?,?,?)").bind("org_sustainability", "customer_sustainability", connectionId, targetId, first, 1).run();
    await assert.rejects(db.prepare("UPDATE finops_sustainability_target_versions SET reason='changed'").run(), /FINOPS_SUSTAINABILITY_TARGET_VERSION_IMMUTABLE/u);
    await insert(second, first, 2).run();
    await db.prepare("UPDATE finops_sustainability_target_heads SET active_version_id=?,advanced_at=2 WHERE target_id=?").bind(second, targetId).run();
    await insert(forged, null, 3).run();
    await assert.rejects(db.prepare("UPDATE finops_sustainability_target_heads SET active_version_id=?,advanced_at=3 WHERE target_id=?").bind(forged, targetId).run(), /FINOPS_SUSTAINABILITY_TARGET_HEAD_REJECTED/u);
  } finally { await miniflare.dispose(); }
});
