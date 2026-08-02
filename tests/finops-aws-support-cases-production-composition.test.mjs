import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  awsSupportCasesScheduledWindow,
  createAwsSupportCasesProductionComposition,
} = await import("../lib/finops-aws-support-cases-production-composition.ts");

const ORG = "org_support_composition";
const CUSTOMER = "customer_support_composition";
const CONNECTION = `conn_${"8".repeat(32)}`;
const ACCOUNT = "111122223333";
const CONNECTION_B = `conn_${"7".repeat(32)}`;
const ACCOUNT_B = "222233334444";
const NOW = Date.parse("2026-08-02T00:05:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-support-composition-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'support-org','Support Org','active')").bind(ORG),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'support-customer','Support Customer','active')").bind(CUSTOMER, ORG),
      database.prepare(`INSERT INTO aws_connections (
        id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
        external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json
      ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.7','active','[]')`)
        .bind(CONNECTION, ORG, CUSTOMER, ACCOUNT, `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`),
      database.prepare(`INSERT INTO aws_connections (
        id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
        external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json
      ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.7','active','[]')`)
        .bind(CONNECTION_B, ORG, CUSTOMER, ACCOUNT_B, `arn:aws:iam::${ACCOUNT_B}:role/sutra/SutraCollectorRole`),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

function runnable(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    attempt: 1,
    maxAttempts: row.max_attempts,
  };
}

function capture(request) {
  const startedAt = "2026-08-02T00:01:00.000Z";
  const completedAt = "2026-08-02T00:02:00.000Z";
  return {
    schemaVersion: "sutra.aws-support-cases.capture.v1",
    scope: {
      orgId: request.tenantId,
      customerId: request.customerId,
      connectionId: request.parentConnectionId,
      partition: request.partition,
      endpointRegion: request.endpointRegion,
    },
    captureId: `support_${"c".repeat(64)}`,
    startedAt,
    completedAt,
    window: request.window,
    intendedAccounts: request.intendedAccounts,
    accounts: request.intendedAccounts.map((account) => ({
      ...account,
      supportPlan: "qualifying_plan_unclassified",
      entitlementState: "QUALIFYING",
      readPermissionsValidated: true,
      startedAt,
      completedAt,
      observedPeakConcurrency: 1,
      observedPeakRequestsPerSecond: 1,
      status: "SUCCEEDED",
      failureCode: null,
      casePages: [{
        request: {
          pageIndex: 0, cursorEvidenceHash: null,
          afterTime: request.window.afterTime, beforeTime: request.window.beforeTime,
          caseIdList: null, displayId: null, includeCommunications: false,
          includeResolvedCases: true, language: null, maxResults: 100,
        },
        response: { cases: [], nextCursorEvidenceHash: null },
      }],
      casesExhausted: true,
      communications: [],
    })),
  };
}

test("composition resolves trusted targets, schedules daily, persists complete head and advances watermark", async () => {
  await withDatabase(async (database) => {
    let requests = 0;
    const composition = createAwsSupportCasesProductionComposition({
      database,
      now: () => NOW,
      transport: { collect: async (request) => { requests += 1; return capture(request); } },
    });
    assert.equal(awsSupportCasesScheduledWindow(NOW), WINDOW);
    assert.deepEqual(await composition.scheduleTick(NOW), { scheduledWindow: WINDOW, enqueued: 1 });
    assert.equal((await database.prepare(
      "SELECT count(*) AS count FROM background_jobs WHERE kind=?",
    ).bind("finops.aws-support-cases.collect").first()).count, 1,
    "two account connections must produce one cohort fan-out job");
    const row = await database.prepare(
      "SELECT * FROM background_jobs WHERE connection_id=? AND kind=? LIMIT 1",
    ).bind(CONNECTION, "finops.aws-support-cases.collect").first();
    assert.ok(row);
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.window.mode, "INITIAL");
    assert.equal(Date.parse(payload.window.beforeTime) - Date.parse(payload.window.afterTime), 730 * 24 * 60 * 60 * 1_000);
    await composition.handler(runnable(row));
    assert.equal(requests, 1);
    const active = await composition.snapshotRepository.getActiveSnapshot({
      organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION,
    });
    assert.equal(active?.snapshot.configurationState, "ready");
    assert.equal(active?.snapshot.collectionState, "complete");
    assert.equal(active?.snapshot.accountCoverage[0]?.supportPlan, "qualifying_plan_unclassified");
    assert.equal(active?.snapshot.intendedAccounts.length, 2);
    assert.equal((await composition.runtimeRepository.listEligibleScopes(WINDOW)).length, 0);

    const next = "2026-08-03T00:00:00.000Z";
    const scope = await composition.runtimeRepository.loadScope({
      organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION,
    });
    assert.deepEqual(await composition.runtimeRepository.resolveWindow(scope, next), {
      mode: "INCREMENTAL",
      afterTime: "2026-07-31T00:00:00.000Z",
      beforeTime: next,
      priorWatermark: WINDOW,
      nextWatermark: next,
    });
  });
});

test("composition rejects ambiguous transports and cross-tenant scope resolution", async () => {
  assert.throws(() => createAwsSupportCasesProductionComposition({}), /EXACTLY_ONE_TRANSPORT/u);
  assert.throws(() => createAwsSupportCasesProductionComposition({
    transport: { collect: async () => ({}) },
    brokerConfiguration: {},
  }), /EXACTLY_ONE_TRANSPORT/u);
  await withDatabase(async (database) => {
    const composition = createAwsSupportCasesProductionComposition({
      database,
      transport: { collect: async () => ({}) },
    });
    await assert.rejects(composition.runtimeRepository.loadScope({
      organizationId: "other_org", customerId: CUSTOMER, connectionId: CONNECTION,
    }), (error) => error.code === "SCOPE_NOT_FOUND");

    const legacyConnection = `conn_${"9".repeat(32)}`;
    const legacyAccount = "444455556666";
    await database.prepare(`INSERT INTO aws_connections (
      id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
      external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json
    ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.6','active','[]')`)
      .bind(legacyConnection, ORG, CUSTOMER, legacyAccount,
        `arn:aws:iam::${legacyAccount}:role/sutra/SutraCollectorRole`).run();
    await assert.rejects(composition.runtimeRepository.loadScope({
      organizationId: ORG, customerId: CUSTOMER, connectionId: legacyConnection,
    }), (error) => error.code === "SCOPE_NOT_FOUND");
    const upgradedScope = await composition.runtimeRepository.loadScope({
      organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION,
    });
    await assert.rejects(composition.runtimeRepository.resolve(upgradedScope),
      (error) => error.code === "PERMISSION_PACK_UPGRADE_REQUIRED");
  });
});
