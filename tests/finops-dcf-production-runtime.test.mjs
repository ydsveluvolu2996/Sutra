import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const migrations = await import("../db/runtime-migrations.ts");
const { DcfRuntimeRepository } = await import("../db/finops-dcf-runtime-repository.ts");
const { DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND } = await import("../lib/finops-dcf-durable-runtime-binding.ts");
const { DCF_PRODUCTION_COMPOSITION_STATUS, createDcfProductionComposition } = await import("../lib/finops-dcf-production-composition.ts");
const { DCF_STEP_FUNCTIONS_BROKER_PATH, createDcfStepFunctionsSignedBroker } = await import("../lib/finops-dcf-signed-broker.ts");

const ORG = "org_dcf_runtime";
const CUSTOMER = "customer_dcf_runtime";
const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "111122223333";
const MACHINE = `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:CID-DataCollection`;
const EXECUTION = `arn:aws:states:us-east-1:${ACCOUNT}:execution:CID-DataCollection:run-1`;
const WINDOW = "2026-08-02T12:00:00.000Z";
const NOW = Date.parse("2026-08-02T12:05:00.000Z");
const SCOPE = { organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION };

async function fixture(permissionPack = "standard-2026-08.10") {
  const miniflare = new Miniflare({ modules: true, script: "export default{fetch(){return new Response('ok')}}", compatibilityDate: "2026-05-22", d1Databases: { DB: `dcf-runtime-${crypto.randomUUID()}` }, d1Persist: false });
  const database = await miniflare.getD1Database("DB");
  migrations.resetRuntimeSchemaCacheForTests(); await migrations.ensureRuntimeSchema(database);
  await database.batch([
    database.prepare("INSERT INTO organizations(id,slug,name,status)VALUES(?,'dcf-runtime','DCF Runtime','active')").bind(ORG),
    database.prepare("INSERT INTO customers(id,org_id,slug,name,status)VALUES(?,?,'dcf-customer','DCF Customer','active')").bind(CUSTOMER, ORG),
    database.prepare("INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)VALUES(?,?,?,'aws_trust_role','aws',? ,?,'ct','v1',?,'active','[\"us-east-1\"]')")
      .bind(CONNECTION, ORG, CUSTOMER, ACCOUNT, `arn:aws:iam::${ACCOUNT}:role/sutra/SutraCollectorRole`, permissionPack),
  ]);
  if (permissionPack === "standard-2026-08.10") await database.prepare("INSERT INTO finops_dcf_module_bindings(org_id,customer_id,connection_id,module_id,module_name,source_id,region,state_machine_arn,enabled,expected_cadence_minutes,verified_at)VALUES(?,?,?,'cur','CUR collector','aws_cur2_data_export','us-east-1',?,1,60,?)")
    .bind(ORG, CUSTOMER, CONNECTION, MACHINE, NOW).run();
  return { miniflare, database };
}
function capture(boundary) {
  const base = { schemaVersion: "sutra.dcf-execution-history.capture.v1", scope: boundary.scope,
    startedAt: "2026-08-02T12:03:00.000Z", completedAt: "2026-08-02T12:04:00.000Z",
    providerAccess: "ENABLED", schedulerRegistered: true, pagesExhausted: true, pageCount: 1,
    modules: [{ moduleId: "cur", moduleName: "CUR collector", sourceId: "aws_cur2_data_export", enabled: true, expectedCadenceMinutes: 60,
      executions: [{ executionArn: EXECUTION, stateMachineArn: MACHINE, status: "SUCCEEDED", startedAt: "2026-08-02T12:03:00.000Z", stoppedAt: "2026-08-02T12:04:00.000Z", attempt: 1, retryOfExecutionArn: null, inputSha256: null, acceptedRecords: null, rejectedRecords: null, expectedRecords: null, processedBytes: null, errorCode: null }] }] };
  return { ...base, captureId: `dcf_${createHash("sha256").update(JSON.stringify(base)).digest("hex")}` };
}
function runnable(row) { return { id: row.id, orgId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id, kind: row.kind, payload: JSON.parse(row.payload_json), attempt: 1, maxAttempts: row.max_attempts }; }

test("production composition schedules, seals one complete head, replays, and exposes ready state", async () => {
  const { miniflare, database } = await fixture();
  try {
    let calls = 0;
    const composition = createDcfProductionComposition({ database, now: () => NOW, adapter: { async collect(boundary) {
      calls += 1; return { schemaVersion: "sutra.dcf-step-functions-collection-result.v1", sourceState: "READY", failureCodes: [], requestCount: 3, retryCount: 0, capture: capture(boundary) };
    } } });
    assert.deepEqual(await composition.scheduleTick(NOW), { scheduledWindow: WINDOW, enqueued: 1 });
    const row = await database.prepare("SELECT * FROM background_jobs WHERE kind=?").bind(DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND).first();
    assert.deepEqual(JSON.parse(row.payload_json), { scheduledWindow: WINDOW });
    await composition.handler(runnable(row));
    await composition.handler(runnable(row));
    assert.equal(calls, 1);
    assert.equal((await composition.snapshotRepository.getActive(SCOPE)).snapshot.modules.length, 1);
    assert.deepEqual(await composition.runtimeRepository.getRuntimeStatus(SCOPE), {
      state: "ready", reason: "DCF_COLLECTION_READY", sourceState: "READY", lastAttemptAt: new Date(NOW).toISOString(),
    });
  } finally { await miniflare.dispose(); }
});

test("runtime requires exact .8.10 scope and rejects cross-tenant module ARNs before scheduling", async () => {
  const old = await fixture("standard-2026-08.9");
  try { assert.deepEqual(await new DcfRuntimeRepository(old.database, { skipRuntimeSchema: true }).listEligibleScopes(), []); }
  finally { await old.miniflare.dispose(); }
  const { miniflare, database } = await fixture();
  try {
    const repository = new DcfRuntimeRepository(database, { now: () => NOW, skipRuntimeSchema: true });
    assert.deepEqual(await repository.listEligibleScopes(), [SCOPE]);
    const boundary = await repository.loadBoundary(SCOPE);
    assert.equal(boundary.binding, "SERVER_RESOLVED_DCF_STACK");
    assert.equal(boundary.modules[0].stateMachineArn, MACHINE);
    await assert.rejects(database.prepare("UPDATE finops_dcf_module_bindings SET state_machine_arn=? WHERE connection_id=?")
      .bind(MACHINE.replace(ACCOUNT, "999988887777"), CONNECTION).run(), /FINOPS_DCF_MODULE_BINDING_REJECTED/u);
    await assert.rejects(repository.loadBoundary({ ...SCOPE, customerId: "attacker" }), (error) => error.code === "SCOPE_NOT_FOUND");
  } finally { await miniflare.dispose(); }
});

test("runtime migrations preserve scope/lease parity and PostgreSQL PUBLIC revokes", async () => {
  const [sqlite, postgres] = await Promise.all([
    readFile(new URL("../drizzle/0121_finops_dcf_runtime.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0117_finops_dcf_runtime.sql", import.meta.url), "utf8"),
  ]);
  for (const source of [sqlite, postgres]) for (const token of ["finops_dcf_module_bindings", "finops_dcf_runtime_attempts", "standard-2026-08.10", "lease_expires_at", "DCF_STEP_FUNCTIONS_COLLECTION_FAILED"]) assert.match(source, new RegExp(token, "u"));
  assert.match(postgres, /REVOKE ALL ON finops_dcf_runtime_attempts FROM PUBLIC/u);
  assert.equal(DCF_PRODUCTION_COMPOSITION_STATUS.requiredSdk, "@aws-sdk/client-sfn@3.1087.0");
  assert.equal(DCF_PRODUCTION_COMPOSITION_STATUS.activationState, "REGISTERED_LOCAL_RUNTIME");
});

function signingKeys() {
  const client = generateKeyPairSync("ed25519"), broker = generateKeyPairSync("ed25519");
  return { brokerPrivateKey: broker.privateKey, config: {
    clientKeyId: "sutra-app-dcf-2026-08", clientPrivateKey: client.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    brokerKeyId: "sutra-broker-dcf-2026-08", brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  } };
}
test("signed broker verifies exact bytes and rejects response substitution", async () => {
  const db = await fixture();
  try {
    const boundary = await new DcfRuntimeRepository(db.database, { skipRuntimeSchema: true }).loadBoundary(SCOPE);
    const keys = signingKeys();
    const fetcher = async (_url, init) => {
      const requestBody = String(init.body); const request = JSON.parse(requestBody); const headers = init.headers;
      assert.equal(request.boundary.boundaryId, boundary.boundaryId);
      const result = { schemaVersion: "sutra.dcf-step-functions-collection-result.v1", sourceState: "READY", failureCodes: [], requestCount: 3, retryCount: 0, capture: capture(boundary) };
      const responseBody = JSON.stringify({ schemaVersion: "sutra.dcf-step-functions-broker-response.v1", boundaryId: boundary.boundaryId,
        requestBodySha256: createHash("sha256").update(requestBody).digest("hex"), result });
      const bodySha = createHash("sha256").update(responseBody).digest("hex");
      const canonical = Buffer.from(["SUTRA-BROKER-APP-V1", "200", DCF_STEP_FUNCTIONS_BROKER_PATH, headers["x-sutra-nonce"], keys.config.brokerKeyId, bodySha].join("\n"));
      return new Response(responseBody, { status: 200, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(responseBody)), "x-sutra-key-id": keys.config.brokerKeyId, "x-sutra-signature": sign(null, canonical, keys.brokerPrivateKey).toString("base64url") } });
    };
    const broker = createDcfStepFunctionsSignedBroker({ configuration: { brokerOrigin: "https://dcf.internal", signing: keys.config }, fetcher, now: () => NOW, nonce: () => "n".repeat(32) });
    assert.equal((await broker.collect(boundary, new AbortController().signal)).sourceState, "READY");
    const substituted = createDcfStepFunctionsSignedBroker({ configuration: { brokerOrigin: "https://dcf.internal", signing: keys.config }, fetcher: async (url, init) => {
      const response = await fetcher(url, init); const value = await response.json(); value.boundaryId = `dcfb_${"0".repeat(64)}`;
      return new Response(JSON.stringify(value), { status: 200, headers: response.headers });
    }, now: () => NOW, nonce: () => "n".repeat(32) });
    await assert.rejects(substituted.collect(boundary, new AbortController().signal), (error) => error.code === "BROKER_AUTHENTICATION_FAILED");
  } finally { await db.miniflare.dispose(); }
});
