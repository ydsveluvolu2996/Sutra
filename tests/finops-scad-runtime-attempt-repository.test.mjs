import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
async function digest(value) { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join(""); }

test("SCAD CAS ledger excludes replicas and recovers a persisted orphan without recollection", async () => {
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22", d1Databases: { DB: `scad-replay-${crypto.randomUUID()}` }, d1Persist: false });
  try {
    const database = await mf.getD1Database("DB"); runtime.resetRuntimeSchemaCacheForTests();
    await runtime.ensureRuntimeSchema(database);
    const migration = await readFile(new URL("../drizzle/0125_finops_scad_runtime_attempts.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
    await database.batch([
      database.prepare("INSERT INTO organizations(id,slug,name,status) VALUES ('org_scad','org-scad','SCAD','active')"),
      database.prepare("INSERT INTO customers(id,org_id,slug,name,status) VALUES ('customer_scad','org_scad','customer-scad','SCAD','active')"),
      database.prepare(`INSERT INTO aws_connections(id,org_id,customer_id,source_kind,partition,aws_account_id,
        role_arn,external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json)
        VALUES (?,'org_scad','customer_scad','aws_trust_role','aws','111111111111',
        'arn:aws:iam::111111111111:role/sutra/SutraCollectorRole','ct','v1','standard-2026-08.1','active','[]')`).bind(CONNECTION),
    ]);
    let now = 1_000; const repository = new ScadCur2RuntimeAttemptRepository(database, () => now);
    const first = await repository.claim({ key: KEY, jobId: JOB_A, leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(first.state, "ACQUIRED");
    assert.deepEqual(await repository.claim({ key: KEY, jobId: JOB_B,
      leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS }), { state: "IN_PROGRESS" });
    now += SCAD_CUR2_RUNTIME_LEASE_MS + 1;
    const reclaimed = await repository.claim({ key: KEY, jobId: JOB_B, leaseDurationMs: SCAD_CUR2_RUNTIME_LEASE_MS });
    assert.equal(reclaimed.state, "ACQUIRED"); if (reclaimed.state !== "ACQUIRED") return;
    const content = "d".repeat(64); const generation = `scg_${content}`;
    await database.prepare(`INSERT INTO finops_scad_allocation_snapshots(generation_id,org_id,customer_id,
      connection_id,capture_id,active_billing_generation_id,manifest_sha256,source_state,complete,content_sha256,
      snapshot_json,billing_period_start_at,billing_period_end_at,generated_at,data_through_at,row_count,group_count,
      object_expected,object_processed,created_at) VALUES (?,'org_scad','customer_scad',?,? ,?,?,'READY',1,?,
      '{}','2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-08-02T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',0,0,0,0,?)`).bind(generation, CONNECTION, `scad_${"e".repeat(64)}`,
      `fbg_${"f".repeat(64)}`, "f".repeat(64), content, now).run();
    const result = { schemaVersion: "sutra.scad-cur2-runtime-result.v1", sourceState: "READY",
      generationId: generation, contentSha256: content, activeGenerationId: `fbg_${"f".repeat(64)}`,
      becameActive: true, failureCodes: [] };
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
    const terminalKey = `scad-cur2:org_scad:customer_scad:${CONNECTION}:${encodeURIComponent(terminalWindow)}`;
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
