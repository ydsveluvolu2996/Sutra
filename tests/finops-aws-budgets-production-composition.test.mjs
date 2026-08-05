import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const migrations = await import("../db/runtime-migrations.ts");
const {
  AWS_BUDGETS_PRODUCTION_COMPOSITION_STATUS,
  awsBudgetsScheduledWindow,
  createAwsBudgetsProductionComposition,
} = await import("../lib/finops-aws-budgets-production-composition.ts");

const ORG_A = "org_budgets_composition_a";
const ORG_B = "org_budgets_composition_b";
const CUSTOMER_A = "customer_budgets_composition_a";
const CUSTOMER_B = "customer_budgets_composition_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "444455556666";
const WINDOW = "2026-08-02T06:00:00.000Z";

function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(`INSERT INTO aws_connections (
    id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
    external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json
  ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.1','active','[]')`)
    .bind(id, orgId, customerId, accountId,
      `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`);
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-budgets-composition-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    migrations.resetRuntimeSchemaCacheForTests();
    await migrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'bca','Budgets CA','active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'bcb','Budgets CB','active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'bcca','Budgets CCA','active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'bccb','Budgets CCB','active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, ACCOUNT_A),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, ACCOUNT_B),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

function capture(scope, requestId) {
  const completedAtIso = "2026-08-02T06:00:01.000Z";
  const operations = [
    "DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget",
    "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource",
  ];
  return {
    schemaVersion: "sutra.aws-budgets-organization.v1",
    scope,
    captureId: `awsbudgets_${createHash("sha256").update(requestId).digest("hex")}`,
    startedAtIso: "2026-08-02T06:00:00.000Z",
    completedAtIso,
    operationCoverage: operations.map((operation) => ({ operation, state: "SUCCEEDED", recordCount: 0, failureCode: null })),
    budgetPages: [{ request: { accountId: scope.accountId, maxResults: 100, nextToken: null }, response: { records: [], nextToken: null } }],
    historySequences: [], notificationSequences: [], subscriberSequences: [], actionSequences: [], tagSequences: [],
  };
}

function hierarchy(scope) {
  return {
    scope: { orgId: scope.orgId, customerId: scope.customerId, connectionId: scope.connectionId },
    sourceEvidenceId: `aws_org_${scope.connectionId.slice(5, 17)}`,
    observedAtIso: "2026-08-02T06:00:01.000Z",
    state: "complete",
    accounts: [{ accountId: scope.accountId, accountName: "Management", parentId: "r-root", ouPath: [] }],
  };
}

function runnable(row, overrides = {}) {
  return {
    id: row.id, orgId: row.org_id, customerId: row.customer_id,
    connectionId: row.connection_id, kind: row.kind,
    payload: JSON.parse(row.payload_json), attempt: 1, maxAttempts: row.max_attempts,
    ...overrides,
  };
}

test("production composition schedules all active scopes, persists a complete head, and replays exactly", async () => {
  await withDatabase(async (database) => {
    let brokerCalls = 0;
    let now = Date.parse(WINDOW) + 2_000;
    const composition = createAwsBudgetsProductionComposition({
      database,
      now: () => now++,
      broker: { collect: async (request) => {
        brokerCalls += 1;
        const requestBodySha256 = createHash("sha256").update(JSON.stringify(request)).digest("hex");
        return {
          capture: capture(request.scope, request.requestId),
          hierarchy: hierarchy(request.scope),
          verification: { requestBodySha256, responseBodySha256: "2".repeat(64), brokerKeyId: "broker-key-1" },
        };
      } },
    });
    assert.equal(awsBudgetsScheduledWindow(Date.parse("2026-08-02T11:59:59.999Z")), WINDOW);
    assert.deepEqual(await composition.scheduleTick(Date.parse("2026-08-02T11:59:59.999Z")), {
      scheduledWindow: WINDOW,
      enqueued: 2,
    });
    const rows = await database.prepare("SELECT * FROM background_jobs ORDER BY connection_id").all();
    assert.equal(rows.results.length, 2);
    assert.deepEqual(JSON.parse(rows.results[0].payload_json), { scheduledWindow: WINDOW });
    assert.equal("accountId" in JSON.parse(rows.results[0].payload_json), false);
    await composition.handler(runnable(rows.results[0]));
    assert.equal((await composition.snapshotRepository.getActiveGeneration({
      orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A,
      accountId: ACCOUNT_A, partition: "aws",
    }))?.snapshot.collectionState, "ready");
    await composition.handler(runnable(rows.results[0]));
    assert.equal(brokerCalls, 1, "same queue-attempt replay must not call the provider again");
    assert.equal((await database.prepare(
      "SELECT count(*) AS count FROM finops_aws_budget_job_attempts WHERE org_id=? AND customer_id=? AND connection_id=?",
    ).bind(ORG_A, CUSTOMER_A, CONNECTION_A).first()).count, 1);
  });
});

test("runtime scope catalog and durable handler reject cross-tenant connection substitution before broker access", async () => {
  await withDatabase(async (database) => {
    let brokerCalls = 0;
    const composition = createAwsBudgetsProductionComposition({
      database,
      now: () => Date.parse(WINDOW) + 2_000,
      broker: { collect: async () => { brokerCalls += 1; throw new Error("must not call"); } },
    });
    await composition.scheduleTick(Date.parse(WINDOW));
    const row = await database.prepare("SELECT * FROM background_jobs WHERE connection_id=?").bind(CONNECTION_A).first();
    await assert.rejects(
      composition.handler(runnable(row, { orgId: ORG_B, customerId: CUSTOMER_B })),
      (error) => error.name === "AwsBudgetsDurableBindingError"
        && error.code === "INTERNAL_ERROR"
        && !error.message.includes(ORG_A) && !error.message.includes(ORG_B),
    );
    assert.equal(brokerCalls, 0);
    assert.equal(await composition.runtimeRepository.loadScope({
      orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A,
    }).then((scope) => scope.accountId), ACCOUNT_A);
    await assert.rejects(composition.runtimeRepository.loadScope({
      orgId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_A,
    }), (error) => error.code === "SCOPE_NOT_FOUND");
  });
});

test("composition status reports the exact shared registry hook", () => {
  assert.equal(AWS_BUDGETS_PRODUCTION_COMPOSITION_STATUS.durableScopeCatalogImplemented, true);
  assert.equal(AWS_BUDGETS_PRODUCTION_COMPOSITION_STATUS.immutableAttemptRepositoryImplemented, true);
  assert.equal(AWS_BUDGETS_PRODUCTION_COMPOSITION_STATUS.sharedWorkerRegistered, true);
  assert.equal(AWS_BUDGETS_PRODUCTION_COMPOSITION_STATUS.activationState, "REGISTERED_LOCAL_RUNTIME");
});
