import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const vite = await createServer({ root, configFile: false, logLevel: "silent", server: { middlewareMode: true } });
const binding = await vite.ssrLoadModule("/lib/finops-aws-budgets-durable-binding.ts");
const transport = await vite.ssrLoadModule("/lib/finops-aws-budgets-signed-broker.ts");
test.after(async () => vite.close());

const NOW = Date.parse("2026-08-02T06:00:00.000Z");
const WINDOW = "2026-08-02T06:00:00.000Z";
const SCOPE = {
  orgId: "org_adv08", customerId: "customer_adv08",
  connectionId: `conn_${"a".repeat(32)}`, accountId: "111122223333", partition: "aws",
};
const JOB = {
  id: `job_${"b".repeat(32)}`, orgId: SCOPE.orgId, customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId, kind: binding.AWS_BUDGETS_DURABLE_JOB_KIND,
  payload: { scheduledWindow: WINDOW }, attempt: 1, maxAttempts: 5,
};

function unavailableCapture(scope = SCOPE) {
  return {
    schemaVersion: "sutra.aws-budgets-organization.v1",
    scope: { ...scope }, captureId: `awsbudgets_${"c".repeat(64)}`,
    startedAtIso: "2026-08-02T05:59:00.000Z", completedAtIso: "2026-08-02T06:00:00.000Z",
    operationCoverage: [
      "DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget",
      "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource",
    ].map((operation) => ({ operation, state: "UNAVAILABLE", recordCount: 0, failureCode: "PROVIDER_UNAVAILABLE" })),
    budgetPages: [], historySequences: [], notificationSequences: [], subscriberSequences: [],
    actionSequences: [], tagSequences: [],
  };
}

function keyConfiguration() {
  const client = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  return {
    brokerPrivateKey: broker.privateKey,
    config: {
      clientKeyId: "sutra-app-2026-08",
      clientPrivateKey: client.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      brokerKeyId: "sutra-broker-2026-08",
      brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
  };
}

function signedBrokerFetcher(keys, mutateSignature = false) {
  return async (_url, init) => {
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-sutra-tenant-id"], SCOPE.orgId);
    assert.equal(init.headers["x-sutra-customer-id"], SCOPE.customerId);
    assert.equal(init.headers["x-sutra-connection-id"], SCOPE.connectionId);
    assert.equal(init.signal.aborted, false);
    const request = JSON.parse(init.body);
    const requestBodySha256 = createHash("sha256").update(init.body).digest("hex");
    const body = JSON.stringify({
      schemaVersion: "sutra.aws-budgets-durable-response.v1",
      requestId: request.requestId,
      requestBodySha256,
      capture: unavailableCapture(request.scope),
      hierarchy: null,
    });
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const nonce = init.headers["x-sutra-nonce"];
    const canonical = Buffer.from([
      "SUTRA-BROKER-APP-V1", "200", transport.AWS_BUDGETS_BROKER_PATH,
      nonce, keys.config.brokerKeyId, bodySha256,
    ].join("\n"));
    const signature = mutateSignature
      ? "A".repeat(86)
      : sign(null, canonical, keys.brokerPrivateKey).toString("base64url");
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(body)),
        "x-sutra-key-id": keys.config.brokerKeyId,
        "x-sutra-signature": signature,
      },
    });
  };
}

function brokerRequest() {
  return {
    schemaVersion: "sutra.aws-budgets-durable-request.v1",
    requestId: `abr_${"d".repeat(64)}`, jobId: JOB.id,
    scheduledWindow: WINDOW, scope: SCOPE,
    budgetOperations: [
      "DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget",
      "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource",
    ],
    organizationOperations: [
      "organizations:DescribeOrganization", "organizations:ListAccounts", "organizations:ListRoots",
      "organizations:ListOrganizationalUnitsForParent", "organizations:ListParents",
    ],
    hierarchyTagKey: "cid:budget-level",
    bounds: {
      apiPageSize: 100, maximumPages: 5_000, maximumBudgets: 1_000,
      maximumHistoryRecords: 20_000, maximumDailyHistoryPerBudget: 60,
      maximumMonthlyHistoryPerBudget: 13, maximumQuarterlyHistoryPerBudget: 4,
      maximumNotifications: 5_000, maximumSubscribers: 50_000, maximumActions: 10_000,
      maximumBudgetLevelTags: 1_000, maximumCostFilterKeys: 50,
      maximumCostFilterValuesPerKey: 100, maximumTextCharacters: 256,
      maximumCaptureBytes: 12 * 1_024 * 1_024, maximumDashboardBytes: 4 * 1_024 * 1_024,
      maximumQueryPageSize: 100, maximumQueryAccountFilters: 100,
      maximumHierarchyAccounts: 10_000, maximumTaxonomyAssignments: 10_000,
      sourceFreshnessSlaHours: 24,
    },
    maximumDurationMs: binding.AWS_BUDGETS_DURABLE_TIMEOUT_MS,
  };
}

test("scheduler enumerates trusted scopes and queues one replay-safe scoped job per connection", async () => {
  const calls = [];
  const result = await binding.scheduleAwsBudgetsCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [{ ...SCOPE }],
    queue: { enqueue: async (input) => { calls.push(input); } },
  });
  assert.equal(result.enqueued, 1);
  assert.deepEqual(calls[0].payload, { scheduledWindow: WINDOW });
  assert.equal(calls[0].orgId, SCOPE.orgId);
  assert.equal(calls[0].customerId, SCOPE.customerId);
  assert.equal(calls[0].connectionId, SCOPE.connectionId);
  assert.equal(calls[0].maxAttempts, 5);
  assert.equal(calls[0].idempotencyKey, `aws-budgets:${SCOPE.connectionId}:${WINDOW}`);
  assert.equal("accountId" in calls[0].payload, false);
});

test("durable handler pins server scope, publishes unavailable honestly, and replays without broker access", async () => {
  const attempts = new Map();
  let brokerCalls = 0;
  let recordedInput;
  const dependencies = {
    now: () => NOW,
    loadScope: async () => ({ ...SCOPE }),
    broker: { collect: async (request) => {
      brokerCalls += 1;
      assert.equal(request.scope.accountId, SCOPE.accountId);
      assert.equal(request.bounds.maximumPages, 5_000);
      assert.equal(request.maximumDurationMs, 300_000);
      const requestBodySha256 = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      return {
        capture: unavailableCapture(), hierarchy: null,
        verification: {
          requestBodySha256, responseBodySha256: "2".repeat(64),
          brokerKeyId: "broker-key-1",
        },
      };
    } },
    captureStore: { recordCapture: async () => ({
      generation: { generationId: `abg_${"3".repeat(64)}`, snapshot: {
        captureId: `awsbudgets_${"c".repeat(64)}`, collectionState: "unavailable",
      } }, becameActive: false,
    }) },
    attempts: {
      getAttempt: async (_scope, requestId, attempt) => attempts.get(`${requestId}:${attempt}`) ?? null,
      recordAttempt: async (input) => {
        recordedInput = input;
        const value = {
          requestId: input.requestId, jobAttempt: input.jobAttempt, state: input.state,
          generationId: input.generationId, captureId: input.captureId, failureCode: input.failureCode,
        };
        attempts.set(`${input.requestId}:${input.jobAttempt}`, value);
        return value;
      },
    },
  };
  const first = await binding.runAwsBudgetsDurableHandler(JOB, dependencies);
  const replay = await binding.runAwsBudgetsDurableHandler(JOB, dependencies);
  assert.equal(first.state, "unavailable");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(brokerCalls, 1);
  assert.equal(recordedInput.failureCode, null);
  assert.equal(recordedInput.hierarchyEvidenceId, null);
});

test("cross-tenant scope and raw provider failures fail closed with sanitized ledger codes", async () => {
  let brokerCalls = 0;
  await assert.rejects(binding.runAwsBudgetsDurableHandler(JOB, {
    now: () => NOW,
    loadScope: async () => ({ ...SCOPE, customerId: "customer_attacker" }),
    broker: { collect: async () => { brokerCalls += 1; } },
    captureStore: { recordCapture: async () => { throw new Error("must not store"); } },
    attempts: { getAttempt: async () => null, recordAttempt: async () => { throw new Error("must not ledger"); } },
  }), (error) => error.code === "SCOPE_REJECTED" && !error.message.includes("customer_attacker"));
  assert.equal(brokerCalls, 0);

  let failedAttempt;
  await assert.rejects(binding.runAwsBudgetsDurableHandler(JOB, {
    now: () => NOW,
    loadScope: async () => ({ ...SCOPE }),
    broker: { collect: async () => { throw new Error("AccessDenied arn:aws:iam::111122223333:role/private"); } },
    captureStore: { recordCapture: async () => { throw new Error("must not store"); } },
    attempts: {
      getAttempt: async () => null,
      recordAttempt: async (input) => {
        failedAttempt = input;
        return { requestId: input.requestId, jobAttempt: input.jobAttempt, state: input.state,
          generationId: null, captureId: null, failureCode: input.failureCode };
      },
    },
  }), (error) => error.code === "INTERNAL_ERROR" && error.message === "AWS Budgets durable collection failed");
  assert.equal(failedAttempt.failureCode, "INTERNAL_ERROR");
  assert.equal(JSON.stringify(failedAttempt).includes("AccessDenied"), false);
});

test("broker transport verifies exact signed bytes and rejects a forged response", async () => {
  const keys = keyConfiguration();
  const valid = transport.createAwsBudgetsSignedBroker({
    configuration: { brokerOrigin: "https://budgets-broker.internal", signing: keys.config },
    fetcher: signedBrokerFetcher(keys), now: () => NOW,
    nonce: () => "n".repeat(32),
  });
  const result = await valid.collect(brokerRequest());
  assert.equal(result.capture.scope.connectionId, SCOPE.connectionId);
  assert.equal(result.capture.operationCoverage[0].state, "UNAVAILABLE");
  assert.match(result.verification.requestBodySha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.verification.brokerKeyId, keys.config.brokerKeyId);

  const forged = transport.createAwsBudgetsSignedBroker({
    configuration: { brokerOrigin: "https://budgets-broker.internal", signing: keys.config },
    fetcher: signedBrokerFetcher(keys, true), now: () => NOW,
    nonce: () => "n".repeat(32),
  });
  await assert.rejects(forged.collect(brokerRequest()),
    (error) => error.code === "BROKER_AUTHENTICATION_FAILED");
});

test("durable-attempt migrations are registered and enforce immutable, tenant-pinned history", async () => {
  const [sqlite, postgres, runtime, postgresRuntime, postgresMigrator] = await Promise.all([
    readFile(path.join(root, "drizzle/0109_finops_aws_budgets_durable_attempts.sql"), "utf8"),
    readFile(path.join(root, "postgres/migrations/0104_finops_aws_budgets_durable_attempts.sql"), "utf8"),
    readFile(path.join(root, "db/runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "scripts/postgres-migrate.mjs"), "utf8"),
  ]);
  assert.match(runtime, /0109_finops_aws_budgets_durable_attempts/u);
  assert.match(postgresRuntime, /0104_finops_aws_budgets_durable_attempts/u);
  assert.match(postgresMigrator, /0103_finops_cora_export_objects\.sql/u);
  assert.match(postgresMigrator, /0104_finops_aws_budgets_durable_attempts\.sql/u);
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /FINOPS_AWS_BUDGET_JOB_ATTEMPT_IMMUTABLE/u);
    assert.match(sql, /FINOPS_AWS_BUDGET_JOB_ATTEMPT_SCOPE_REJECTED/u);
    assert.match(sql, /BROKER_AUTHENTICATION_FAILED/u);
    assert.match(sql, /state.*unavailable.*failed/su);
  }
  const mf = new Miniflare({
    modules: true, script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `adv08-${crypto.randomUUID()}` }, d1Persist: false,
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of [
      "CREATE TABLE organizations(id text PRIMARY KEY)",
      "CREATE TABLE customers(id text PRIMARY KEY)",
      "CREATE TABLE aws_connections(id text PRIMARY KEY)",
      "CREATE TABLE finops_aws_budget_snapshots(generation_id text PRIMARY KEY,org_id text,customer_id text,connection_id text,account_id text,partition text,source_capture_id text)",
    ]) await db.prepare(statement).run();
    for (const statement of sqlite.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
    await db.batch([
      db.prepare("INSERT INTO organizations VALUES(?)").bind(SCOPE.orgId),
      db.prepare("INSERT INTO customers VALUES(?)").bind(SCOPE.customerId),
      db.prepare("INSERT INTO aws_connections VALUES(?)").bind(SCOPE.connectionId),
    ]);
    await db.prepare(`INSERT INTO finops_aws_budget_job_attempts (
      execution_id,org_id,customer_id,connection_id,account_id,partition,request_id,
      job_id,job_attempt,scheduled_window,state,generation_id,capture_id,
      hierarchy_evidence_id,request_body_sha256,response_body_sha256,broker_key_id,
      failure_code,content_sha256,completed_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `abe_${"1".repeat(64)}`, SCOPE.orgId, SCOPE.customerId, SCOPE.connectionId,
      SCOPE.accountId, SCOPE.partition, `abr_${"2".repeat(64)}`, JOB.id, 1, WINDOW,
      "failed", null, null, null, null, null, null, "BROKER_TIMEOUT", "3".repeat(64), NOW, NOW,
    ).run();
    await assert.rejects(db.prepare(
      "UPDATE finops_aws_budget_job_attempts SET failure_code='INTERNAL_ERROR'",
    ).run(), /FINOPS_AWS_BUDGET_JOB_ATTEMPT_IMMUTABLE/u);
    await assert.rejects(db.prepare(
      "DELETE FROM finops_aws_budget_job_attempts",
    ).run(), /FINOPS_AWS_BUDGET_JOB_ATTEMPT_IMMUTABLE/u);
    await db.prepare("INSERT INTO finops_aws_budget_snapshots VALUES(?,?,?,?,?,?,?)").bind(
      `abg_${"4".repeat(64)}`, "org_other", "customer_other", SCOPE.connectionId,
      SCOPE.accountId, SCOPE.partition, `awsbudgets_${"5".repeat(64)}`,
    ).run();
    await assert.rejects(db.prepare(`INSERT INTO finops_aws_budget_job_attempts (
      execution_id,org_id,customer_id,connection_id,account_id,partition,request_id,
      job_id,job_attempt,scheduled_window,state,generation_id,capture_id,
      hierarchy_evidence_id,request_body_sha256,response_body_sha256,broker_key_id,
      failure_code,content_sha256,completed_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `abe_${"6".repeat(64)}`, SCOPE.orgId, SCOPE.customerId, SCOPE.connectionId,
      SCOPE.accountId, SCOPE.partition, `abr_${"7".repeat(64)}`, JOB.id, 2, WINDOW,
      "unavailable", `abg_${"4".repeat(64)}`, `awsbudgets_${"5".repeat(64)}`,
      null, "8".repeat(64), "9".repeat(64), "broker-key-1", null,
      "a".repeat(64), NOW, NOW,
    ).run(), /FINOPS_AWS_BUDGET_JOB_ATTEMPT_SCOPE_REJECTED/u);
  } finally { await mf.dispose(); }
});

test("activation remains honest until the isolated binding is registered and provider-accepted", () => {
  assert.equal(binding.AWS_BUDGETS_DURABLE_BINDING.registeredInSharedRuntime, false);
  assert.equal(binding.AWS_BUDGETS_DURABLE_BINDING.activationReason,
    "AWS_BUDGETS_SIGNED_BROKER_HANDLER_NOT_REGISTERED");
  assert.equal(binding.AWS_BUDGETS_DURABLE_BINDING.cadence, "rate(6 hours)");
});
