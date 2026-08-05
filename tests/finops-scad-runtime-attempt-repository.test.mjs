import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";
register(new URL("./cloudflare-loader.mjs", import.meta.url));
const runtime = await import("../db/runtime-migrations.ts");
const { ScadCur2RuntimeAttemptRepository, SCAD_CUR2_RUNTIME_LEASE_MS } =
  await import("../db/finops-scad-runtime-attempt-repository.ts");
const CONNECTION = `conn_${"a".repeat(32)}`; const WINDOW = "2026-08-02T00:00:00.000Z";
const KEY = `scad-cur2:org_scad:customer_scad:${CONNECTION}:${encodeURIComponent(WINDOW)}`;
const JOB_A = `job_${"b".repeat(32)}`; const JOB_B = `job_${"c".repeat(32)}`;
const CONTENT = "d".repeat(64); const GENERATION = `scg_${CONTENT}`; const ACTIVE = `fbg_${"f".repeat(64)}`;
function key(window) { return `scad-cur2:org_scad:customer_scad:${CONNECTION}:${encodeURIComponent(window)}`; }
async function digest(value) { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join(""); }

// Miniflare D1 plus the runtime schema and the org/customer/connection the foreign keys
// require. Each call gets its own database, so tests never share attempt rows.
async function harness() {
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `scad-replay-${crypto.randomUUID()}` }, d1Persist: false });
  const database = await mf.getD1Database("DB"); runtime.resetRuntimeSchemaCacheForTests();
  await runtime.ensureRuntimeSchema(database);
  await database.batch([
    database.prepare("INSERT INTO organizations(id,slug,name,status) VALUES ('org_scad','org-scad','SCAD','active')"),
    database.prepare("INSERT INTO customers(id,org_id,slug,name,status) VALUES ('customer_scad','org_scad','customer-scad','SCAD','active')"),
    database.prepare(`INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,
      role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)
      VALUES (?,'org_scad','customer_scad','aws_trust_role','aws','111111111111',
      'arn:aws:iam::111111111111:role/sutra/SutraCollectorRole','ct','v1','standard-2026-08.1','active','[]')`).bind(CONNECTION),
  ]);
  return { mf, database };
}
// complete() writes generation_id under an ON DELETE RESTRICT foreign key, so the snapshot must exist first.
async function insertSnapshot(database, now) {
  await database.prepare(`INSERT INTO finops_scad_allocation_snapshots(generation_id,org_id,customer_id,
    connection_id,capture_id,active_billing_generation_id,manifest_sha256,source_state,complete,content_sha256,
    snapshot_json,billing_period_start_at,billing_period_end_at,generated_at,data_through_at,row_count,group_count,
    object_expected,object_processed,created_at) VALUES (?,'org_scad','customer_scad',?,? ,?,?,'READY',1,?,
    '{}','2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-08-02T00:00:00.000Z',
    '2026-08-02T00:00:00.000Z',0,0,0,0,?)`).bind(GENERATION, CONNECTION, `scad_${"e".repeat(64)}`,
    ACTIVE, "f".repeat(64), CONTENT, now).run();
}
function runtimeResult() {
  return { schemaVersion: "sutra.scad-cur2-runtime-result.v1", sourceState: "READY", generationId: GENERATION,
    contentSha256: CONTENT, activeGenerationId: ACTIVE, becameActive: true, failureCodes: [] };
}

test("SCAD CAS ledger excludes replicas and recovers a persisted orphan without recollection", async () => {
  const { mf, database } = await harness();
  try {
    let now = 1_000; const repository = new ScadCur2RuntimeAttemptRepository(database, () => now);
    const first = await repository.claim({ key: KEY, jobId: JOB_A, leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(first.state, "ACQUIRED");
    assert.deepEqual(await repository.claim({ key: KEY, jobId: JOB_B,
      leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS }), { state: "IN_PROGRESS" });
    now += SCAD_CUR2_RUNTIME_LEASE_MS + 1;
    const reclaimed = await repository.claim({ key: KEY, jobId: JOB_B, leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(reclaimed.state, "ACQUIRED"); if (reclaimed.state !== "ACQUIRED") return;
    await insertSnapshot(database, now);
    const result = runtimeResult();
    const resultSha256 = await digest(JSON.stringify(result));
    await repository.checkpoint({ key: KEY, jobId: JOB_B, leaseToken: reclaimed.leaseToken, result, resultSha256 });
    now += SCAD_CUR2_RUNTIME_LEASE_MS + 1;
    const recovered = await repository.claim({ key: KEY, jobId: JOB_A, leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(recovered.state, "ACQUIRED"); if (recovered.state !== "ACQUIRED") return;
    assert.deepEqual(recovered.recoveredResult, result);
    await repository.complete({ key: KEY, jobId: JOB_A, leaseToken: recovered.leaseToken, result, resultSha256 });
    const replayed = await repository.claim({ key: KEY, jobId: JOB_A, leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(replayed.state, "COMPLETED");
    const terminalWindow = "2026-08-03T00:00:00.000Z";
    const terminalKey = key(terminalWindow);
    const terminal = await repository.claim({ key: terminalKey, jobId: JOB_A,
      leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(terminal.state, "ACQUIRED"); if (terminal.state !== "ACQUIRED") return;
    await repository.fail({ key: terminalKey, jobId: JOB_A, leaseToken: terminal.leaseToken,
      failureCode: "SCAD_CUR2_RUNTIME_FAILED", terminal: true });
    assert.equal((await repository.latest({ organizationId: "org_scad", customerId: "customer_scad",
      connectionId: CONNECTION }))?.state, "FAILED");
    await assert.rejects(repository.claim({ key: terminalKey, jobId: JOB_B,
      leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS }), /SCAD CUR2 replay persistence rejected/u);
  } finally { await mf.dispose(); }
});

// Regression: latest() ordered by updated_at with a replay_key tiebreak, and replay_key is a SHA-256 digest. When an
// older window is completed *after* a newer window has already failed terminally — a late backfill — the stale
// SUCCEEDED row carries the higher updated_at and wins, so /api/v1/finops/scad-allocation reports READY while the
// newest billing window is FAILED. Ordering by scheduled_window keeps the newest window authoritative.
test("SCAD latest() reports the newest window's terminal failure, not a later-written older success", async () => {
  const { mf, database } = await harness();
  try {
    const olderWindow = "2026-08-04T00:00:00.000Z"; const newerWindow = "2026-08-05T00:00:00.000Z";
    let now = 1_000; const repository = new ScadCur2RuntimeAttemptRepository(database, () => now);
    const scope = { organizationId: "org_scad", customerId: "customer_scad", connectionId: CONNECTION };

    // The newer window fails terminally first.
    const failing = await repository.claim({ key: key(newerWindow), jobId: JOB_A,
      leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(failing.state, "ACQUIRED"); if (failing.state !== "ACQUIRED") return;
    await repository.fail({ key: key(newerWindow), jobId: JOB_A, leaseToken: failing.leaseToken,
      failureCode: "SCAD_CUR2_RUNTIME_FAILED", terminal: true });
    assert.equal((await repository.latest(scope))?.scheduledWindow, newerWindow);

    // The older window then succeeds, strictly later on the clock.
    now += 60_000;
    await insertSnapshot(database, now);
    const succeeding = await repository.claim({ key: key(olderWindow), jobId: JOB_B,
      leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(succeeding.state, "ACQUIRED"); if (succeeding.state !== "ACQUIRED") return;
    const result = runtimeResult();
    await repository.complete({ key: key(olderWindow), jobId: JOB_B, leaseToken: succeeding.leaseToken,
      result, resultSha256: await digest(JSON.stringify(result)) });

    // Both rows exist and the SUCCEEDED one has the later updated_at, so an updated_at ordering would mask it.
    const latest = await repository.latest(scope);
    assert.equal(latest?.scheduledWindow, newerWindow);
    assert.equal(latest?.state, "FAILED");
    assert.equal(latest?.failureCode, "SCAD_CUR2_RUNTIME_FAILED");
  } finally { await mf.dispose(); }
});
