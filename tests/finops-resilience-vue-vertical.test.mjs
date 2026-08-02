import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Miniflare } from "miniflare";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { ResilienceVueRepository } = await import("../db/finops-resilience-vue-repository.ts");
const { ResilienceVueRuntimeRepository } = await import("../db/finops-resilience-vue-runtime-repository.ts");
const { RESILIENCE_VUE_READ_OPERATIONS } = await import("../lib/finops-resilience-vue.ts");
const { resilienceVueCollectionWindow, resilienceVueJobIdempotencyKey, runResilienceVueCollectionJob } = await import("../lib/finops-resilience-vue-job.ts");

const root = path.resolve(import.meta.dirname, "..");
const CONNECTION_A = `conn_${"a".repeat(32)}`; const CONNECTION_B = `conn_${"b".repeat(32)}`;
const SCOPE_A = { organizationId: "org_resilience_a", customerId: "customer_resilience_a", connectionId: CONNECTION_A };
const TARGET_A = { orgId: SCOPE_A.organizationId, customerId: SCOPE_A.customerId, connectionId: SCOPE_A.connectionId,
  accountId: "111122223333", partition: "aws", region: "us-east-1" };
function page(items, exhausted = true) { return { pages: [{ request: { maxResults: 100, nextToken: null }, response: { items, nextToken: exhausted ? null : "more" } }], exhausted }; }
function capture(character, completedAt, exhaustive = true) {
  return { schemaVersion: "sutra.resilience-vue.v1", scope: TARGET_A,
    captureId: `resilience_${character.repeat(64)}`, startedAtIso: new Date(Date.parse(completedAt) - 30_000).toISOString(), completedAtIso: completedAt,
    execution: { concurrencyLimit: 4, observedPeakConcurrency: 1 }, prerequisites: { serviceConfigured: true, readPermissionsValidated: true, collectorRegionEnabled: true },
    applications: page([], exhaustive), applicationDetails: [], policies: page([]), policyDetails: [], assessmentHistories: [], assessmentEvidence: [], resourceInventories: [] };
}
function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(`INSERT INTO aws_connections (id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
    external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)
    VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.9','active','[]')`)
    .bind(id, orgId, customerId, accountId, `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`);
}
async function withRepository(run) {
  const miniflare = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", compatibilityDate: "2026-05-22", d1Databases: { DB: `resilience-${crypto.randomUUID()}` }, d1Persist: false });
  try {
    const database = await miniflare.getD1Database("DB"); runtimeMigrations.resetRuntimeSchemaCacheForTests(); await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'res-a','Res A','active')").bind(SCOPE_A.organizationId),
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES ('org_resilience_b','res-b','Res B','active')"),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'resc-a','Res CA','active')").bind(SCOPE_A.customerId, SCOPE_A.organizationId),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES ('customer_resilience_b','org_resilience_b','resc-b','Res CB','active')"),
      connection(database, CONNECTION_A, SCOPE_A.organizationId, SCOPE_A.customerId, TARGET_A.accountId),
      connection(database, CONNECTION_B, "org_resilience_b", "customer_resilience_b", "999900001111"),
    ]);
    await run({ database, repository: new ResilienceVueRepository(database) });
  } finally { await miniflare.dispose(); }
}

test("immutable complete heads are tenant/target scoped and newer incomplete evidence cannot displace them", async () => {
  await withRepository(async ({ database, repository }) => {
    const first = capture("a", "2026-07-31T12:00:00.000Z");
    const stored = await repository.recordCapture(SCOPE_A, TARGET_A, first, Date.parse(first.completedAtIso));
    assert.equal(stored.becameActive, true); assert.equal((await repository.listActiveSnapshots(SCOPE_A)).length, 1);
    const replay = await repository.recordCapture(SCOPE_A, TARGET_A, first, Date.parse(first.completedAtIso)); assert.equal(replay.becameActive, false);
    const partial = capture("b", "2026-07-31T18:00:00.000Z", false);
    assert.equal((await repository.recordCapture(SCOPE_A, TARGET_A, partial, Date.parse(partial.completedAtIso))).becameActive, false);
    assert.equal((await repository.listActiveSnapshots(SCOPE_A))[0].snapshot.captureId, first.captureId);
    assert.deepEqual((await repository.listHistory(SCOPE_A)).map((item) => item.state), ["partial", "no_apps"]);
    await assert.rejects(database.prepare("UPDATE finops_resilience_vue_snapshots SET source_state='stale' WHERE capture_id=?").bind(first.captureId).run(), /FINOPS_RESILIENCE_VUE_SNAPSHOT_IMMUTABLE/u);
    assert.equal((await repository.listActiveSnapshots({ organizationId: "org_resilience_b", customerId: "customer_resilience_b", connectionId: CONNECTION_B })).length, 0);
  });
});

test("daily server-owned job enumerates trusted account/Region targets and exposes no caller AWS scope", async () => {
  const seen = []; const captured = capture("c", "2026-07-31T12:05:00.000Z");
  const result = await runResilienceVueCollectionJob({ id: "job_res", orgId: SCOPE_A.organizationId, customerId: SCOPE_A.customerId,
    connectionId: SCOPE_A.connectionId, payload: { scheduledWindow: "2026-07-31T00:00:00.000Z" } }, {
    listTargets: async () => [{ ...TARGET_A, lastAcceptedCompletedAtIso: "2026-07-30T12:00:00.000Z" }],
    adapter: { collect: async (request) => { seen.push(request); return captured; } },
    recordCapture: async () => ({ snapshot: { generationId: `rvg_${"d".repeat(64)}`, snapshot: { complete: true }, contentSha256: "d".repeat(64), scope: SCOPE_A, createdAtIso: captured.completedAtIso, committedAtIso: captured.completedAtIso }, becameActive: true }),
    now: () => Date.parse(captured.completedAtIso),
  });
  assert.equal(result.acceptedHeadCount, 1); assert.equal(seen[0].scope.accountId, TARGET_A.accountId);
  assert.equal(seen[0].incrementalAfterIso, "2026-07-30T12:00:00.000Z"); assert.deepEqual(seen[0].operations, RESILIENCE_VUE_READ_OPERATIONS);
  assert.equal(resilienceVueCollectionWindow(Date.parse("2026-07-31T18:00:00.000Z")), "2026-07-31T00:00:00.000Z");
  assert.match(resilienceVueJobIdempotencyKey(SCOPE_A, "2026-07-31T00:00:00.000Z"), /^resilience-vue:org_resilience_a/u);
  await assert.rejects(() => runResilienceVueCollectionJob({ id: "bad", orgId: SCOPE_A.organizationId, customerId: SCOPE_A.customerId,
    connectionId: SCOPE_A.connectionId, payload: { scheduledWindow: "2026-07-31T00:00:00.000Z", accountId: "000000000000" } }, {}), /job-invalid/u);
});

test("durable runtime exposes unavailable, collecting, failed, ready and replay states", async () => {
  await withRepository(async ({ database }) => {
    await database.prepare("UPDATE aws_connections SET enabled_regions_json='[\"us-east-1\"]' WHERE id=?")
      .bind(CONNECTION_A).run();
    const now = Date.parse("2026-08-02T00:05:00.000Z");
    const runtime = new ResilienceVueRuntimeRepository(database, { now: () => now, skipRuntimeSchema: true });
    assert.equal((await runtime.getRuntimeStatus(SCOPE_A)).state, "unavailable");
    const [target] = await runtime.listTargets(SCOPE_A); assert.deepEqual(target, { ...TARGET_A, lastAcceptedCompletedAtIso: null });
    const requestId = `rvr_${"a".repeat(64)}`; const window = "2026-08-02T00:00:00.000Z";
    await runtime.prepareAttempt(SCOPE_A, TARGET_A, requestId, window);
    assert.equal(await runtime.getAccepted(SCOPE_A, TARGET_A, requestId), null);
    assert.equal((await runtime.getRuntimeStatus(SCOPE_A)).state, "collecting");
    await runtime.recordFailure({ scope: SCOPE_A, target: TARGET_A, requestId, scheduledWindow: window,
      code: "ADAPTER_UNAVAILABLE", completedAtMs: now });
    assert.deepEqual(await runtime.getRuntimeStatus(SCOPE_A), { state: "failed",
      reason: "ADAPTER_UNAVAILABLE", lastAttemptAt: new Date(now).toISOString() });
    await runtime.prepareAttempt(SCOPE_A, TARGET_A, requestId, window);
    assert.equal(await runtime.getAccepted(SCOPE_A, TARGET_A, requestId), null);
    const evidenceObject = `eobj_${"b".repeat(32)}`;
    await database.prepare(`INSERT INTO evidence_objects
      (id,org_id,customer_id,connection_id,run_id,snapshot_id,artifact_kind,object_key,content_type,
       content_sha256,byte_size,status,retention_until,created_by,created_at,available_at)
      VALUES (?,?,?,?,?,?,'finops_source_snapshot',?,'application/json',?,1,'available',?,?,?,?)`)
      .bind(evidenceObject, SCOPE_A.organizationId, SCOPE_A.customerId, CONNECTION_A, requestId,
        `fss_${"c".repeat(64)}`, `finops/${requestId}`, "d".repeat(64), now + 86_400_000,
        "finops-resilience-vue-runtime", now, now).run();
    const inputCapture = capture("a", "2026-08-02T00:04:00.000Z");
    const normalized = (await import("../lib/finops-resilience-vue.ts"))
      .normalizeResilienceVueCapture(inputCapture, TARGET_A, now);
    const committed = await runtime.commit({ scope: SCOPE_A, target: TARGET_A, requestId,
      scheduledWindow: window, capture: inputCapture, normalizedSnapshot: normalized,
      evidence: { generationId: `fss_${"c".repeat(64)}`, objectId: evidenceObject,
        contentSha256: "d".repeat(64), reference: { ciphertext: `fsev1.${"A".repeat(32)}`,
          keyVersion: "resilience-v1" } }, nowMs: now });
    assert.equal(committed.accepted.requestId, requestId);
    assert.equal((await runtime.getRuntimeStatus(SCOPE_A)).state, "ready");
    assert.equal((await runtime.getAccepted(SCOPE_A, TARGET_A, requestId))?.snapshot.generationId,
      committed.accepted.snapshot.generationId);
    await assert.rejects(database.prepare("UPDATE finops_resilience_vue_runtime_attempts SET state='FAILED' WHERE request_id=?")
      .bind(requestId).run(), /FINOPS_RESILIENCE_VUE_RUNTIME_SUCCESS_IMMUTABLE/u);
  });
});

test("route is authenticated, same-tenant, immutable-head only, bounded, and activation-honest", async () => {
  const route = await readFile(new URL("../app/api/v1/finops/resilience-vue/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireApiSession\(request\)/u); assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /repository\.listActiveSnapshots\(scope\)/u);
  assert.match(route, /runtime\.getRuntimeStatus\(scope\)/u);
  assert.doesNotMatch(route, /RESILIENCE_VUE_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED/u);
  assert.match(route, /assessmentFrom/u); assert.match(route, /assessmentTo/u); assert.match(route, /recommendationEvidence/u);
  assert.match(route, /RESILIENCE_VUE_OFFICIAL_DEFINITION/u);
  assert.equal(
    (route.match(/officialDefinition: RESILIENCE_VUE_OFFICIAL_DEFINITION/gu) ?? []).length,
    (route.match(/return jsonResponse\(/gu) ?? []).length,
  );
  assert.match(route, /versioned capture-schema migration/u);
  assert.doesNotMatch(route, /searchParams\.get\("orgId"\)|searchParams\.get\("customerId"\)/u);
});

test("SQLite and PostgreSQL enforce immutable complete-only target heads and PUBLIC revokes", async () => {
  for (const url of [new URL("../drizzle/0093_finops_resilience_vue.sql", import.meta.url), new URL("../postgres/migrations/0088_finops_resilience_vue.sql", import.meta.url)]) {
    const sql = await readFile(url, "utf8"); assert.match(sql, /FINOPS_RESILIENCE_VUE_SNAPSHOT_IMMUTABLE/u);
    assert.match(sql, /candidate\.`?complete`?\s*=\s*1|NOT candidate\.complete/u); assert.match(sql, /candidate\.`?completed_at`? > active\.`?completed_at`?/u);
  }
  assert.match(await readFile(new URL("../postgres/migrations/0088_finops_resilience_vue.sql", import.meta.url), "utf8"), /REVOKE ALL ON finops_resilience_vue_snapshots FROM PUBLIC/u);
});

test("native visual renders filters, trends, RTO/RPO, breaches, backlog, drilldowns, provenance, and honest state", async () => {
  const vite = await createServer({ root, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
  try {
    const dashboardModule = await vite.ssrLoadModule("/app/costs/finops-resilience-vue-dashboard.tsx");
    const definitionModule = await vite.ssrLoadModule("/lib/finops-resilience-vue-official-definition.ts");
    const recommendation = { assessmentArn: "assessment", kind: "CONFIG", recommendationId: "rec-1", appComponentName: "database", name: "Enable Multi-AZ", description: "Add standby", status: "NotImplemented", risk: "AZ outage", resourceId: "db-1", targetAccountId: TARGET_A.accountId, targetRegion: TARGET_A.region, alreadyImplemented: false, excluded: false, expectedRpoInSecs: 1800, expectedRtoInSecs: 900, suggestedChanges: ["Enable Multi-AZ"] };
    const target = { accountId: TARGET_A.accountId, partition: "aws", region: TARGET_A.region, generationId: `rvg_${"d".repeat(64)}`, contentSha256: "d".repeat(64), captureId: `resilience_${"c".repeat(64)}`, completedAtIso: "2026-07-31T12:05:00.000Z", state: "current",
      applications: [{ appArn: "app-1", name: "payments", policyName: "tier-1", policyTier: "Critical", latestAssessmentArn: "assessment", latestAssessmentStatus: "Success", complianceStatus: "PolicyBreached", driftStatus: "Detected", resiliencyScore: 62, rpoInSecs: 3600, rtoInSecs: 1800, lastAssessmentTime: "2026-07-31T12:00:00.000Z", observedAssessmentCount: 3,
        policyObjectives: [{ disruptionType: "AZ", rpoInSecs: 1800, rtoInSecs: 900 }], latestObjectivePosture: [{ disruptionType: "AZ", complianceStatus: "PolicyBreached", currentRpoInSecs: 3600, currentRtoInSecs: 1800, achievableRpoInSecs: 1800, achievableRtoInSecs: 900, message: null }] }],
      assessmentHistory: [{ assessmentArn: "assessment", appArn: "app-1", appVersion: "1", name: "latest", assessmentStatus: "Success", complianceStatus: "PolicyBreached", driftStatus: "Detected", resiliencyScore: 62, startTime: "2026-07-31T12:00:00.000Z", endTime: "2026-07-31T12:05:00.000Z", message: null, objectivePosture: [], riskRecommendations: [] }],
      componentPosture: [], recommendationEvidence: [recommendation], recommendations: [recommendation], resources: [], drifts: [], inferredPrioritization: [{ label: "SUTRA_INFERRED_PRIORITY_NOT_AWS_FINDING", assessmentArn: "assessment", recommendationId: "rec-1", kind: "CONFIG", appComponentName: "database", priorityScore: 95, reasons: ["latest captured assessment breaches its policy"] }], limitations: [] };
    const report = { connectionId: CONNECTION_A, sourceState: "partial", officialDefinition: definitionModule.RESILIENCE_VUE_OFFICIAL_DEFINITION, freshness: { dataThroughAt: target.completedAtIso, ageHours: 2, staleAfterHours: 168 }, summary: { targetCount: 1, applicationCount: 1, assessedApplicationCount: 1, unassessedApplicationCount: 0, policyMetApplicationCount: 0, policyBreachedApplicationCount: 1, driftedApplicationCount: 1, openRecommendationCount: 1 }, targets: [target], history: [{ generationId: target.generationId, accountId: target.accountId, region: target.region, completedAtIso: target.completedAtIso, state: "current", complete: true, applicationCount: 1, assessmentCount: 3, recommendationCount: 1, contentSha256: target.contentSha256 }], filterOptions: { accounts: [target.accountId], regions: [target.region] }, evidence: { acceptedHeads: [target.generationId] }, collection: { state: "collecting", reason: "RESILIENCE_VUE_COLLECTION_IN_PROGRESS", lastAttemptAt: target.completedAtIso }, limitations: ["Provider validation pending"] };
    const html = renderToStaticMarkup(createElement(dashboardModule.ResilienceVueReportView, { report, filters: { accountId: null, region: null, application: null, compliance: null, recommendationKind: null, assessmentFrom: null, assessmentTo: null }, onFiltersChange: () => undefined }));
    for (const expected of ["Official ResilienceVue definition coverage", "4 sheets", "47 upstream visuals mapped", "Organizational Summary", "Application Resiliency", "Recommendations", "About", "pixel or layout parity", "Account / payer scope", "Region", "Application search", "Policy posture", "Recommendation type", "Last assessment from", "Daily assessment evidence trend", "Summary of 10 latest assessments", "Resiliency score trend", "Applications assessed", "Applications in policy", "PolicyBreached", "RPO target", "RTO target", "RPO/RTO dimensions", "Current RPO / RTO", "SOP Recommendations by status", "Alarm Recommendations by status", "Experiment Recommendations by status", "Unimplemented operational recommendations", "Export visible rows", "SUTRA_INFERRED_PRIORITY_NOT_AWS_FINDING", "estimated cost", "provenance", "newer collection is incomplete"]) assert.match(html, new RegExp(expected, "iu"));
    const css = await readFile(new URL("../app/costs/finops-resilience-vue-dashboard.module.css", import.meta.url), "utf8");
    assert.match(css, /\.official > nav button\[aria-current="page"\]/u);
    assert.match(css, /\.official button:focus-visible/u);
    assert.match(css, /@media \(max-width: 1000px\)[\s\S]*\.official > article/u);
  } finally { await vite.close(); }
});
