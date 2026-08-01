import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createServer } from "vite";

const vite = await createServer({ root: new URL("..", import.meta.url).pathname, configFile: false, logLevel: "silent", server: { middlewareMode: true } });
const runtime = await vite.ssrLoadModule("/lib/finops-end-user-computing-runtime-binding.ts");
const transport = await vite.ssrLoadModule("/lib/finops-end-user-computing-signed-broker.ts");
test.after(async () => vite.close());

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const WINDOW = "2026-08-02T12:00:00.000Z";
const BOUNDARY = { scope: { orgId: "org_euc", customerId: "customer_euc", connectionId: `conn_${"a".repeat(32)}` }, partition: "aws", accountIds: ["111122223333"], regions: ["us-east-1"] };
const JOB = { id: `job_${"b".repeat(32)}`, orgId: BOUNDARY.scope.orgId, customerId: BOUNDARY.scope.customerId,
  connectionId: BOUNDARY.scope.connectionId, kind: runtime.END_USER_COMPUTING_DURABLE_JOB_KIND,
  payload: { scheduledWindow: WINDOW }, attempt: 1, maxAttempts: 5 };
const NO_CUR2 = { availability: "UNAVAILABLE", generationId: null, billingPeriod: null,
  sourceEvidenceId: null, manifestSha256: null, sourceUpdatedAt: null, committedAt: null,
  activeGenerationRowCount: null, matchedLineItemCount: null, projectedCostLinesSha256: null };

function unavailableCapture(boundary = BOUNDARY) {
  return { schemaVersion: "sutra.end-user-computing.v1", scope: { ...boundary.scope },
    partition: boundary.partition, accountIds: [...boundary.accountIds], regions: [...boundary.regions],
    captureId: `euc_${"c".repeat(64)}`, startedAt: "2026-08-02T11:59:00.000Z",
    completedAt: "2026-08-02T12:00:00.000Z", execution: { concurrencyLimit: 4, observedPeakConcurrency: 1, pageCount: 0 },
    coverage: ["APPSTREAM", "WORKSPACES"].map((service) => ({ service, accountId: boundary.accountIds[0],
      region: boundary.regions[0], inventoryStatus: "UNAVAILABLE", activityStatus: "UNAVAILABLE",
      metricStatus: "UNAVAILABLE", costStatus: "UNAVAILABLE", inventoryObservedAt: null,
      activityObservedAt: null, metricDataThroughAt: null, costDataThroughAt: null,
      inventoryRecordCount: 0, activityRecordCount: 0, metricRecordCount: 0, costRecordCount: 0,
      inventoryPermissionValidated: false, activityPermissionValidated: false,
      metricPermissionValidated: false, costGenerationActivated: false, failureCode: "PROVIDER_UNAVAILABLE" })),
    pagination: [], workspaces: [], workspaceBundles: [], appStreamFleets: [], appStreamStacks: [],
    appStreamSessions: [], metrics: [], billingEvidence: null, costs: [] };
}

function request() {
  return { schemaVersion: "sutra.end-user-computing-runtime-request.v1", requestId: `eur_${"d".repeat(64)}`,
    jobId: JOB.id, scheduledWindow: WINDOW, boundary: BOUNDARY,
    operations: ["appstream:DescribeFleets", "appstream:DescribeSessions", "appstream:DescribeStacks",
      "appstream:ListAssociatedFleets", "cloudwatch:GetMetricData", "workspaces:DescribeWorkspaceBundles",
      "workspaces:DescribeWorkspaces", "workspaces:DescribeWorkspacesConnectionStatus"],
    bounds: { workspacePageSize: 25, appStreamSessionPageSize: 50, generalPageSize: 25,
      cloudWatchResultPageSize: 500, maximumConcurrency: 4, maximumDurationMs: 900000,
      maximumPages: 20000, maximumAccounts: 200, maximumRegions: 50, maximumCoverageRows: 20000,
      maximumWorkspaces: 50000, maximumBundles: 10000, maximumFleets: 10000, maximumStacks: 10000,
      maximumSessionAggregates: 50000, maximumSessions: 1000000, maximumMetricObservations: 100000,
      maximumCostRows: 250000, maximumHistoryDays: 93, maximumCaptureBytes: 67108864,
      maximumDashboardBytes: 8388608, maximumResourcesInResponse: 5000, maximumTextCharacters: 256,
      inventoryFreshnessHours: 24, activityFreshnessHours: 6, metricFreshnessHours: 6, costFreshnessHours: 48 },
    maximumDurationMs: 300000, cur2: NO_CUR2,
    privacy: { includeUserIdentifiers: false, includeSessionIdentifiers: false,
      includeInstanceIdentifiers: false, includeNetworkAddresses: false, includeRawProviderMessages: false } };
}

test("scheduler queues only a server-owned window and runtime replays immutable unavailable evidence", async () => {
  const queued = [];
  assert.equal(await runtime.scheduleEndUserComputingCollections({ scheduledWindow: WINDOW,
    loadEligibleBoundaries: async () => [BOUNDARY], enqueue: async (value) => { queued.push(value); } }), 1);
  assert.deepEqual(queued[0].payload, { scheduledWindow: WINDOW });
  assert.equal("accountIds" in queued[0].payload, false);
  const attempts = new Map();
  let brokerCalls = 0;
  let brokerRequest;
  const deps = { now: () => NOW, loadRuntimeContext: async () => ({ boundary: BOUNDARY, cur2: NO_CUR2 }),
    broker: { collect: async (value) => { brokerCalls += 1; brokerRequest = value;
      return { capture: unavailableCapture(), verification: {
        requestBodySha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        responseBodySha256: "1".repeat(64), brokerKeyId: "euc-broker-key" } }; } },
    recordCapture: async () => ({ generation: { generationId: `eucg_${"2".repeat(64)}`,
      snapshot: { captureId: `euc_${"c".repeat(64)}`, state: "UNAVAILABLE" } } }),
    attempts: { getAttempt: async (_boundary, id, attempt) => attempts.get(`${id}:${attempt}`) ?? null,
      recordAttempt: async (input) => { const value = { requestId: input.requestId, jobAttempt: input.jobAttempt,
        state: input.state, generationId: input.generationId, captureId: input.captureId,
        failureCode: input.failureCode }; attempts.set(`${input.requestId}:${input.jobAttempt}`, value); return value; } } };
  const first = await runtime.runEndUserComputingRuntimeJob(JOB, deps);
  const replay = await runtime.runEndUserComputingRuntimeJob(JOB, deps);
  assert.equal(first.state, "UNAVAILABLE");
  assert.equal(replay.replayed, true);
  assert.equal(brokerCalls, 1);
  assert.deepEqual(Object.values(brokerRequest.privacy), [false, false, false, false, false]);
  assert.equal(brokerRequest.cur2.availability, "UNAVAILABLE");
  assert.equal(brokerRequest.bounds.maximumPages, 20000);
});

test("scheduler validates the full inventory before enqueue and isolates per-connection queue rejection", async () => {
  const second = { ...BOUNDARY, scope: { orgId: "org_euc_2", customerId: "customer_euc_2", connectionId: `conn_${"9".repeat(32)}` } };
  const queued = [];
  const result = await runtime.scheduleEndUserComputingCollectionsDetailed({ scheduledWindow: WINDOW,
    loadEligibleBoundaries: async () => [second, BOUNDARY],
    enqueue: async (value) => { queued.push(value); if (value.connectionId === second.scope.connectionId) throw new Error("tenant queue secret"); } });
  assert.deepEqual(result, { schemaVersion: "sutra.end-user-computing-schedule-result.v1",
    scheduledWindow: WINDOW, connectionCount: 2, submittedCount: 1, rejectedCount: 1 });
  assert.deepEqual(queued.map((item) => item.connectionId), [second.scope.connectionId, BOUNDARY.scope.connectionId]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  let enqueueCalls = 0;
  await assert.rejects(runtime.scheduleEndUserComputingCollectionsDetailed({ scheduledWindow: WINDOW,
    loadEligibleBoundaries: async () => [BOUNDARY, { ...second, accountIds: ["attacker"] }],
    enqueue: async () => { enqueueCalls += 1; } }), (error) => error.code === "SCOPE_REJECTED");
  assert.equal(enqueueCalls, 0);
  await assert.rejects(runtime.scheduleEndUserComputingCollectionsDetailed({ scheduledWindow: WINDOW,
    loadEligibleBoundaries: async () => { throw new Error("database password"); },
    enqueue: async () => undefined }), (error) => error.code === "INTERNAL_ERROR" && !error.message.includes("password"));
});

test("runtime rejects scope substitution and CUR2 lineage substitution before publication", async () => {
  let persisted = false;
  await assert.rejects(runtime.runEndUserComputingRuntimeJob(JOB, {
    now: () => NOW, loadRuntimeContext: async () => ({ boundary: BOUNDARY, cur2: NO_CUR2 }),
    broker: { collect: async (value) => ({ capture: unavailableCapture({ ...BOUNDARY,
      scope: { ...BOUNDARY.scope, orgId: "org_attacker" } }), verification: {
        requestBodySha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        responseBodySha256: "3".repeat(64), brokerKeyId: "euc-broker-key" } }) },
    recordCapture: async () => { persisted = true; },
    attempts: { getAttempt: async () => null, recordAttempt: async (input) => ({ ...input }) },
  }), (error) => error.code === "SCOPE_REJECTED" && !error.message.includes("org_attacker"));
  assert.equal(persisted, false);

  const costsHash = createHash("sha256").update("[]").digest("hex");
  const active = { availability: "ACTIVE_RECONCILED", generationId: `fbg_${"4".repeat(64)}`,
    billingPeriod: "2026-08", sourceEvidenceId: "cur2_euc_projection", manifestSha256: "5".repeat(64),
    sourceUpdatedAt: "2026-08-02T11:00:00.000Z", committedAt: "2026-08-02T11:05:00.000Z",
    activeGenerationRowCount: 10, matchedLineItemCount: 0, projectedCostLinesSha256: costsHash };
  await assert.rejects(runtime.runEndUserComputingRuntimeJob(JOB, {
    now: () => NOW, loadRuntimeContext: async () => ({ boundary: BOUNDARY, cur2: active }),
    broker: { collect: async (value) => ({ capture: unavailableCapture(), verification: {
      requestBodySha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      responseBodySha256: "6".repeat(64), brokerKeyId: "euc-broker-key" } }) },
    recordCapture: async () => { persisted = true; },
    attempts: { getAttempt: async () => null, recordAttempt: async (input) => ({ ...input }) },
  }), (error) => error.code === "CUR2_LINEAGE_REJECTED");
});

test("runtime accepts only the scheduler's exact five-attempt job contract", async () => {
  const dependencies = {
    loadRuntimeContext: async () => { throw new Error("must not load"); },
    broker: { collect: async () => { throw new Error("must not collect"); } },
    recordCapture: async () => { throw new Error("must not persist"); },
    attempts: { getAttempt: async () => null, recordAttempt: async () => { throw new Error("must not record"); } },
  };
  await assert.rejects(runtime.runEndUserComputingRuntimeJob({ ...JOB, maxAttempts: 4 }, dependencies),
    (error) => error.code === "INVALID_JOB");
  await assert.rejects(runtime.runEndUserComputingRuntimeJob({ ...JOB, attempt: 6 }, dependencies),
    (error) => error.code === "INVALID_JOB");
});

function keys() {
  const client = generateKeyPairSync("ed25519"), broker = generateKeyPairSync("ed25519");
  return { brokerPrivate: broker.privateKey, signing: { clientKeyId: "euc-app-2026",
    clientPrivateKey: client.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    brokerKeyId: "euc-broker-2026",
    brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url") } };
}

function fetcher(keyPair, forged = false) {
  return async (_url, init) => {
    const parsed = JSON.parse(init.body), bodyHash = createHash("sha256").update(init.body).digest("hex");
    const body = JSON.stringify({ schemaVersion: "sutra.end-user-computing-runtime-response.v1",
      requestId: parsed.requestId, requestBodySha256: bodyHash, capture: unavailableCapture(parsed.boundary) });
    const responseHash = createHash("sha256").update(body).digest("hex");
    const canonical = Buffer.from(["SUTRA-BROKER-APP-V1", "200", transport.END_USER_COMPUTING_BROKER_PATH,
      init.headers["x-sutra-nonce"], keyPair.signing.brokerKeyId, responseHash].join("\n"));
    const signature = forged ? "A".repeat(86) : sign(null, canonical, keyPair.brokerPrivate).toString("base64url");
    return new Response(body, { status: 200, headers: { "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)), "x-sutra-key-id": keyPair.signing.brokerKeyId,
      "x-sutra-signature": signature } });
  };
}

test("signed transport accepts exact privacy-minimized bytes and rejects forged responses", async () => {
  const keyPair = keys();
  const valid = transport.createEndUserComputingSignedBroker({ brokerOrigin: "https://euc-broker.internal",
    signing: keyPair.signing, fetcher: fetcher(keyPair), now: () => NOW, nonce: () => "n".repeat(32) });
  const result = await valid.collect(request());
  assert.equal(result.capture.coverage.length, 2);
  assert.equal(result.capture.billingEvidence, null);
  const forged = transport.createEndUserComputingSignedBroker({ brokerOrigin: "https://euc-broker.internal",
    signing: keyPair.signing, fetcher: fetcher(keyPair, true), now: () => NOW, nonce: () => "n".repeat(32) });
  await assert.rejects(forged.collect(request()), (error) => error.code === "BROKER_AUTHENTICATION_FAILED");
});

test("privacy flags cannot be enabled and activation remains explicitly unavailable", async () => {
  const keyPair = keys();
  const broker = transport.createEndUserComputingSignedBroker({ brokerOrigin: "https://euc-broker.internal",
    signing: keyPair.signing, fetcher: fetcher(keyPair), now: () => NOW });
  await assert.rejects(broker.collect({ ...request(), privacy: { ...request().privacy,
    includeSessionIdentifiers: true } }), (error) => error.code === "PRIVACY_REJECTED");
  assert.equal(runtime.END_USER_COMPUTING_RUNTIME_BINDING.registeredInSharedRuntime, false);
  assert.equal(runtime.END_USER_COMPUTING_RUNTIME_BINDING.schedulerFailureIsolationImplemented, true);
  assert.equal(runtime.END_USER_COMPUTING_RUNTIME_BINDING.activationReason, "EUC_SIGNED_BROKER_RUNTIME_NOT_REGISTERED");
});

test("runtime-attempt migrations retain immutable same-tenant execution evidence", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [sqlite, postgres] = await Promise.all([
    readFile(path.join(root, "drizzle/0110_finops_euc_runtime_attempts.sql"), "utf8"),
    readFile(path.join(root, "postgres/migrations/0105_finops_euc_runtime_attempts.sql"), "utf8"),
  ]);
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /FINOPS_EUC_RUNTIME_ATTEMPT_IMMUTABLE/u);
    assert.match(sql, /FINOPS_EUC_RUNTIME_ATTEMPT_SCOPE_REJECTED/u);
    assert.match(sql, /CUR2_LINEAGE_REJECTED/u);
  }
  const mf = new Miniflare({ modules: true, script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `euc-runtime-${crypto.randomUUID()}` }, d1Persist: false });
  try {
    const db = await mf.getD1Database("DB");
    for (const statement of ["CREATE TABLE organizations(id text PRIMARY KEY)",
      "CREATE TABLE customers(id text PRIMARY KEY)", "CREATE TABLE aws_connections(id text PRIMARY KEY)",
      "CREATE TABLE finops_euc_snapshots(generation_id text PRIMARY KEY,org_id text,customer_id text,connection_id text,partition text,source_capture_id text)"]) await db.prepare(statement).run();
    for (const statement of sqlite.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) await db.prepare(statement).run();
    await db.batch([db.prepare("INSERT INTO organizations VALUES(?)").bind(BOUNDARY.scope.orgId),
      db.prepare("INSERT INTO customers VALUES(?)").bind(BOUNDARY.scope.customerId),
      db.prepare("INSERT INTO aws_connections VALUES(?)").bind(BOUNDARY.scope.connectionId)]);
    const columns = "execution_id,org_id,customer_id,connection_id,partition,boundary_sha256,account_count,region_count,request_id,job_id,job_attempt,scheduled_window,state,generation_id,capture_id,cur2_generation_id,cur2_projection_sha256,request_body_sha256,response_body_sha256,broker_key_id,failure_code,content_sha256,completed_at,created_at";
    await db.prepare(`INSERT INTO finops_euc_runtime_attempts(${columns}) VALUES(${Array(24).fill("?").join(",")})`).bind(
      `eue_${"1".repeat(64)}`, BOUNDARY.scope.orgId, BOUNDARY.scope.customerId, BOUNDARY.scope.connectionId,
      "aws", "2".repeat(64), 1, 1, `eur_${"3".repeat(64)}`, JOB.id, 1, WINDOW, "FAILED",
      null, null, null, null, "4".repeat(64), null, null, "BROKER_TIMEOUT", "5".repeat(64), NOW, NOW,
    ).run();
    await assert.rejects(db.prepare("UPDATE finops_euc_runtime_attempts SET failure_code='INTERNAL_ERROR'").run(),
      /FINOPS_EUC_RUNTIME_ATTEMPT_IMMUTABLE/u);
  } finally { await mf.dispose(); }
});
