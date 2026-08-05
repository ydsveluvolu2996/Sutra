import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createServer } from "vite";

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true },
});
const runtime = await vite.ssrLoadModule("/lib/finops-kubecost-runtime-binding.ts");
const transport = await vite.ssrLoadModule("/lib/finops-kubecost-signed-export-broker.ts");
const allocation = await vite.ssrLoadModule("/lib/finops-kubecost-allocation.ts");
test.after(async () => vite.close());

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const WINDOW = "2026-07-31T12:00:00.000Z";
const ACCOUNT = "111111111111";
const CLUSTER = "eks-prod-us-east-1";
const SCOPE = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  partition: "aws",
  billingPeriod: "2026-07",
  activeCur2GenerationId: `fbg_${"b".repeat(64)}`,
  awsAccountIds: [ACCOUNT],
  clusterIds: [CLUSTER],
};
const DESTINATION = {
  bucket: "sutra-kubecost-evidence-111111111111",
  prefix: "tenants/org_alpha/exports/kubecost/",
  expectedBucketOwner: ACCOUNT,
  requireObjectVersionIds: true,
  kmsKeyArn: null,
};
const ACTIVE_CUR2 = {
  source: "AWS_CUR2_ACTIVE_GENERATION",
  generationState: "ACTIVE",
  generationId: SCOPE.activeCur2GenerationId,
  manifestSha256: "8".repeat(64),
  billingPeriod: SCOPE.billingPeriod,
  dataThroughAtIso: "2026-07-31T11:00:00.000Z",
  payerAccountIds: [ACCOUNT],
  usageAccountIds: [ACCOUNT],
  clusterIds: [CLUSTER],
  scopeBasis: "KUBERNETES_CLUSTER_TAGGED_COST",
  rowsExhausted: true,
  totals: [],
};
const CONTEXT = { scope: SCOPE, destination: DESTINATION, activeCur2: ACTIVE_CUR2 };
const JOB = {
  id: `job_${"c".repeat(32)}`,
  orgId: SCOPE.orgId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  kind: runtime.KUBECOST_DURABLE_JOB_KIND,
  payload: { scheduledWindow: WINDOW },
  attempt: 1,
  maxAttempts: 5,
};

function emptyCapture(overrides = {}) {
  return {
    schemaVersion: "sutra.kubecost-allocation.capture.v1",
    scope: { ...SCOPE, awsAccountIds: [...SCOPE.awsAccountIds], clusterIds: [...SCOPE.clusterIds] },
    captureId: `kubecost_${"d".repeat(64)}`,
    startedAtIso: "2026-07-31T11:45:00.000Z",
    completedAtIso: "2026-07-31T11:55:00.000Z",
    generatedAtIso: "2026-07-31T11:44:00.000Z",
    dataThroughAtIso: ACTIVE_CUR2.dataThroughAtIso,
    destination: { bucket: DESTINATION.bucket, prefix: DESTINATION.prefix },
    export: {
      provider: "KUBECOST",
      exporterName: "sutra-kubecost-exporter",
      exporterVersion: "1.0.0",
      schemaName: "sutra.kubecost-opencost-allocation",
      schemaVersion: "2.0.0",
      schemaSha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      querySha256: "3".repeat(64),
      costModelSha256: "4".repeat(64),
      format: "NDJSON",
      costBasis: "CLOUD_BILL_RECONCILED",
      query: {
        windowStartIso: "2026-07-01T00:00:00.000Z",
        windowEndIso: "2026-08-01T00:00:00.000Z",
        step: "1d",
        accumulate: false,
        rawAllocationLineage: true,
        shareIdle: false,
        splitIdle: true,
        includeSharedCostBreakdown: true,
        external: true,
        cloudBillReconciliationEnabled: true,
      },
    },
    coverage: {
      configured: true,
      deliveryObserved: true,
      runtimeS3PermissionsValidated: true,
      status: "SUCCEEDED",
      expectedObjectCount: 1,
      processedObjectCount: 1,
      failedObjectCount: 0,
      expectedClusterIds: [CLUSTER],
      capturedClusterIds: [CLUSTER],
      rowsExhausted: true,
      errorCode: null,
    },
    objects: [{
      objectId: "object_001",
      bucket: DESTINATION.bucket,
      key: `${DESTINATION.prefix}window-2026-07.ndjson`,
      eTag: "etag-001",
      versionId: "version-001",
      sha256: "5".repeat(64),
      sizeBytes: 2,
    }],
    rows: [],
    cur2Evidence: { ...ACTIVE_CUR2, payerAccountIds: [...ACTIVE_CUR2.payerAccountIds],
      usageAccountIds: [...ACTIVE_CUR2.usageAccountIds], clusterIds: [...ACTIVE_CUR2.clusterIds], totals: [] },
    reconciliationToleranceMicros: "0",
    ...overrides,
  };
}

function attemptStore() {
  const values = new Map();
  return {
    getAttempt: async (_scope, requestId, jobAttempt) => values.get(`${requestId}:${jobAttempt}`) ?? null,
    recordAttempt: async (input) => {
      const value = {
        requestId: input.requestId,
        jobAttempt: input.jobAttempt,
        state: input.state,
        generationId: input.generationId,
        captureId: input.captureId,
        failureCode: input.failureCode,
      };
      values.set(`${input.requestId}:${input.jobAttempt}`, value);
      return value;
    },
  };
}

test("scheduler queues only a server-owned window and runtime replays immutable empty evidence", async () => {
  const queued = [];
  assert.equal(await runtime.scheduleKubecostCollections({
    scheduledWindow: WINDOW,
    loadEligibleContexts: async () => [CONTEXT],
    enqueue: async (value) => { queued.push(value); },
  }), 1);
  assert.deepEqual(queued[0].payload, { scheduledWindow: WINDOW });
  assert.equal("scope" in queued[0].payload, false);
  assert.equal(queued[0].idempotencyKey,
    `kubecost:${[SCOPE.orgId, SCOPE.customerId, SCOPE.connectionId, WINDOW].map(encodeURIComponent).join(":")}`);

  const attempts = attemptStore();
  let brokerCalls = 0;
  let brokerRequest;
  const capture = emptyCapture();
  const deps = {
    now: () => NOW,
    loadRuntimeContext: async () => CONTEXT,
    broker: { collect: async (request) => {
      brokerCalls += 1;
      brokerRequest = request;
      return { capture, verification: {
        requestBodySha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        responseBodySha256: "6".repeat(64),
        brokerKeyId: "kubecost-broker-key",
      } };
    } },
    recordCapture: async (_scope, value) => {
      const snapshot = allocation.buildKubecostAllocationSnapshot(value, SCOPE, NOW);
      return { generation: { generationId: `kcg_${"7".repeat(64)}`, snapshot } };
    },
    attempts,
  };
  const first = await runtime.runKubecostRuntimeJob(JOB, deps);
  const replay = await runtime.runKubecostRuntimeJob(JOB, deps);
  assert.equal(first.state, "EMPTY");
  assert.equal(replay.replayed, true);
  assert.equal(first.requestId, replay.requestId);
  assert.equal(brokerCalls, 1);
  assert.equal(brokerRequest.destination.expectedBucketOwner, ACCOUNT);
  assert.equal(brokerRequest.destination.requireObjectVersionIds, true);
  assert.deepEqual(brokerRequest.exporterWriteActions, []);
  assert.deepEqual(brokerRequest.versionedReadActions, ["s3:GetObjectVersion"]);
  assert.equal(brokerRequest.activeCur2Sha256,
    createHash("sha256").update(JSON.stringify(ACTIVE_CUR2)).digest("hex"));
});

test("runtime accepts only the scheduler's five-attempt durable-job envelope", async () => {
  const deps = {
    loadRuntimeContext: async () => { throw new Error("must not load"); },
    broker: { collect: async () => { throw new Error("must not collect"); } },
    recordCapture: async () => { throw new Error("must not persist"); },
    attempts: attemptStore(),
  };
  for (const invalid of [{ ...JOB, attempt: 6 }, { ...JOB, maxAttempts: 4 }]) {
    await assert.rejects(runtime.runKubecostRuntimeJob(invalid, deps),
      (error) => error.code === "INVALID_JOB" && !error.message.includes("must not"));
  }
});

test("runtime deep-clones and freezes every trusted context branch before broker execution", async () => {
  const loaded = {
    scope: { ...SCOPE, awsAccountIds: [...SCOPE.awsAccountIds], clusterIds: [...SCOPE.clusterIds] },
    destination: { ...DESTINATION },
    activeCur2: {
      ...ACTIVE_CUR2,
      payerAccountIds: [...ACTIVE_CUR2.payerAccountIds],
      usageAccountIds: [...ACTIVE_CUR2.usageAccountIds],
      clusterIds: [...ACTIVE_CUR2.clusterIds],
      totals: [{ currency: "USD", amountMicros: "0" }],
    },
  };
  let trustedRequest;
  await assert.rejects(runtime.runKubecostRuntimeJob(JOB, {
    now: () => NOW,
    loadRuntimeContext: async () => loaded,
    broker: { collect: async (request) => {
      trustedRequest = request;
      assert.equal(Object.isFrozen(request.scope), true);
      assert.equal(Object.isFrozen(request.scope.awsAccountIds), true);
      assert.equal(Object.isFrozen(request.scope.clusterIds), true);
      assert.equal(Object.isFrozen(request.destination), true);
      assert.equal(Object.isFrozen(request.activeCur2), true);
      assert.equal(Object.isFrozen(request.activeCur2.payerAccountIds), true);
      assert.equal(Object.isFrozen(request.activeCur2.usageAccountIds), true);
      assert.equal(Object.isFrozen(request.activeCur2.clusterIds), true);
      assert.equal(Object.isFrozen(request.activeCur2.totals), true);
      assert.equal(Object.isFrozen(request.activeCur2.totals[0]), true);
      assert.throws(() => request.scope.awsAccountIds.push("222222222222"), TypeError);
      assert.throws(() => { request.activeCur2.totals[0].amountMicros = "1"; }, TypeError);
      throw new runtime.KubecostRuntimeError("BROKER_UNAVAILABLE");
    } },
    recordCapture: async () => { throw new Error("must not persist"); },
    attempts: attemptStore(),
  }), (error) => error.code === "BROKER_UNAVAILABLE");
  assert.equal(Object.isFrozen(loaded.scope.awsAccountIds), false);
  assert.equal(Object.isFrozen(loaded.activeCur2.totals[0]), false);
  loaded.scope.awsAccountIds.push("222222222222");
  loaded.activeCur2.totals[0].amountMicros = "2";
  assert.deepEqual(trustedRequest.scope.awsAccountIds, [ACCOUNT]);
  assert.equal(trustedRequest.activeCur2.totals[0].amountMicros, "0");
});

test("complete publication rejects mutable current-key evidence before persistence", async () => {
  let persisted = false;
  const mutableCapture = emptyCapture({ objects: [{ ...emptyCapture().objects[0], versionId: null }] });
  await assert.rejects(runtime.runKubecostRuntimeJob(JOB, {
    now: () => NOW,
    loadRuntimeContext: async () => CONTEXT,
    broker: { collect: async (request) => ({ capture: mutableCapture, verification: {
      requestBodySha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      responseBodySha256: "6".repeat(64),
      brokerKeyId: "kubecost-broker-key",
    } }) },
    recordCapture: async () => { persisted = true; },
    attempts: attemptStore(),
  }), (error) => error.code === "VERSION_PIN_REJECTED");
  assert.equal(persisted, false);
});

test("runtime rejects tenant, destination and active CUR2 substitutions before publication", async () => {
  const cases = [
    { capture: emptyCapture({ scope: { ...SCOPE, orgId: "org_attacker" } }), code: "SCOPE_REJECTED" },
    { capture: emptyCapture({ destination: { ...emptyCapture().destination, bucket: "attacker-evidence" } }), code: "DESTINATION_REJECTED" },
    { capture: emptyCapture({ cur2Evidence: { ...ACTIVE_CUR2, manifestSha256: "9".repeat(64) } }), code: "CUR2_LINEAGE_REJECTED" },
  ];
  for (const item of cases) {
    let persisted = false;
    await assert.rejects(runtime.runKubecostRuntimeJob(JOB, {
      now: () => NOW,
      loadRuntimeContext: async () => CONTEXT,
      broker: { collect: async (request) => ({ capture: item.capture, verification: {
        requestBodySha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        responseBodySha256: "6".repeat(64),
        brokerKeyId: "kubecost-broker-key",
      } }) },
      recordCapture: async () => { persisted = true; },
      attempts: attemptStore(),
    }), (error) => error.code === item.code && !error.message.includes("attacker"));
    assert.equal(persisted, false);
  }
});

function keyPair() {
  const client = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  return {
    brokerPrivateKey: broker.privateKey,
    signing: {
      clientKeyId: "kubecost-app-2026",
      clientPrivateKey: client.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      brokerKeyId: "kubecost-broker-2026",
      brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
  };
}

function request() {
  const activeCur2Sha256 = createHash("sha256").update(JSON.stringify(ACTIVE_CUR2)).digest("hex");
  return {
    schemaVersion: "sutra.kubecost-versioned-runtime-request.v1",
    requestId: `kur_${"e".repeat(64)}`,
    jobId: JOB.id,
    scheduledWindow: WINDOW,
    scope: SCOPE,
    destination: DESTINATION,
    activeCur2: ACTIVE_CUR2,
    activeCur2Sha256,
    exportContract: allocation.KUBECOST_EXPORT_CONTRACT,
    runtimeReadActions: allocation.KUBECOST_RUNTIME_S3_READ_IAM_ACTIONS,
    versionedReadActions: allocation.KUBECOST_VERSIONED_OBJECT_READ_IAM_ACTIONS,
    conditionalKmsActions: allocation.KUBECOST_SSE_KMS_READ_IAM_ACTIONS,
    exporterWriteActions: [],
    bounds: allocation.KUBECOST_ALLOCATION_BOUNDS,
    maximumDurationMs: runtime.KUBECOST_RUNTIME_TIMEOUT_MS,
  };
}

function signedFetcher(keys, forged = false) {
  return async (_url, init) => {
    const parsed = JSON.parse(init.body);
    const requestBodySha256 = createHash("sha256").update(init.body).digest("hex");
    const body = JSON.stringify({
      schemaVersion: "sutra.kubecost-versioned-runtime-response.v1",
      requestId: parsed.requestId,
      requestBodySha256,
      capture: emptyCapture(),
    });
    const responseBodySha256 = createHash("sha256").update(body).digest("hex");
    const canonical = Buffer.from([
      "SUTRA-BROKER-APP-V1",
      "200",
      transport.KUBECOST_EXPORT_BROKER_PATH,
      init.headers["x-sutra-nonce"],
      keys.signing.brokerKeyId,
      responseBodySha256,
    ].join("\n"));
    const signature = forged
      ? "A".repeat(86)
      : sign(null, canonical, keys.brokerPrivateKey).toString("base64url");
    return new Response(body, { status: 200, headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-sutra-key-id": keys.signing.brokerKeyId,
      "x-sutra-signature": signature,
    } });
  };
}

test("signed transport accepts exact versioned-export bytes and rejects forged responses", async () => {
  const keys = keyPair();
  const valid = transport.createKubecostSignedExportBroker({
    brokerOrigin: "https://kubecost-broker.internal",
    signing: keys.signing,
    fetcher: signedFetcher(keys),
    now: () => NOW,
    nonce: () => "n".repeat(32),
  });
  const result = await valid.collect(request());
  assert.equal(result.capture.objects[0].versionId, "version-001");
  assert.equal(result.verification.brokerKeyId, keys.signing.brokerKeyId);

  const forged = transport.createKubecostSignedExportBroker({
    brokerOrigin: "https://kubecost-broker.internal",
    signing: keys.signing,
    fetcher: signedFetcher(keys, true),
    now: () => NOW,
    nonce: () => "n".repeat(32),
  });
  await assert.rejects(forged.collect(request()),
    (error) => error.code === "BROKER_AUTHENTICATION_FAILED");
});

test("runtime activation remains honestly unavailable until shared registration", () => {
  assert.equal(runtime.KUBECOST_RUNTIME_BINDING.registeredInSharedRuntime, false);
  assert.equal(runtime.KUBECOST_RUNTIME_BINDING.activationReason,
    "KUBECOST_SIGNED_VERSIONED_EXPORT_RUNTIME_NOT_REGISTERED");
});

test("runtime-attempt migrations retain immutable same-tenant execution evidence", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [sqlite, postgres] = await Promise.all([
    readFile(path.join(root, "drizzle/0111_finops_kubecost_runtime_attempts.sql"), "utf8"),
    readFile(path.join(root, "postgres/migrations/0106_finops_kubecost_runtime_attempts.sql"), "utf8"),
  ]);
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /FINOPS_KUBECOST_RUNTIME_ATTEMPT_IMMUTABLE/u);
    assert.match(sql, /FINOPS_KUBECOST_RUNTIME_ATTEMPT_SCOPE_REJECTED/u);
    assert.match(sql, /VERSION_PIN_REJECTED/u);
  }
  const mf = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `kubecost-runtime-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await mf.getD1Database("DB");
    for (const statement of [
      "CREATE TABLE organizations(id text PRIMARY KEY)",
      "CREATE TABLE customers(id text PRIMARY KEY)",
      "CREATE TABLE aws_connections(id text PRIMARY KEY)",
      "CREATE TABLE finops_kubecost_snapshots(generation_id text PRIMARY KEY,org_id text,customer_id text,connection_id text,partition text,billing_period text,active_cur2_generation_id text,source_capture_id text,source_state text)",
    ]) await database.prepare(statement).run();
    for (const statement of sqlite.split("--> statement-breakpoint")
      .map((item) => item.trim()).filter(Boolean)) await database.prepare(statement).run();
    await database.batch([
      database.prepare("INSERT INTO organizations VALUES(?)").bind(SCOPE.orgId),
      database.prepare("INSERT INTO customers VALUES(?)").bind(SCOPE.customerId),
      database.prepare("INSERT INTO aws_connections VALUES(?)").bind(SCOPE.connectionId),
    ]);
    const columns = "execution_id,org_id,customer_id,connection_id,partition,billing_period,active_cur2_generation_id,scope_sha256,destination_sha256,active_cur2_sha256,account_count,cluster_count,request_id,job_id,job_attempt,scheduled_window,state,generation_id,capture_id,request_body_sha256,response_body_sha256,broker_key_id,failure_code,content_sha256,completed_at,created_at";
    await database.prepare(`INSERT INTO finops_kubecost_runtime_attempts(${columns}) VALUES(${Array(26).fill("?").join(",")})`).bind(
      `kue_${"1".repeat(64)}`, SCOPE.orgId, SCOPE.customerId, SCOPE.connectionId, "aws",
      SCOPE.billingPeriod, SCOPE.activeCur2GenerationId, "2".repeat(64), "3".repeat(64),
      "4".repeat(64), 1, 1, `kur_${"5".repeat(64)}`, JOB.id, 1, WINDOW, "FAILED",
      null, null, "6".repeat(64), null, null, "BROKER_TIMEOUT", "7".repeat(64), NOW, NOW,
    ).run();
    await assert.rejects(database.prepare(
      "UPDATE finops_kubecost_runtime_attempts SET failure_code='INTERNAL_ERROR'",
    ).run(), /FINOPS_KUBECOST_RUNTIME_ATTEMPT_IMMUTABLE/u);
  } finally {
    await mf.dispose();
  }
});
