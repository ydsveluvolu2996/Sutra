import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const root = path.resolve(import.meta.dirname, "..");
const CONNECTION = `conn_${"a".repeat(32)}`;
const OTHER_CONNECTION = `conn_${"b".repeat(32)}`;
const WINDOW = "2026-08-02T00:00:00.000Z";
const JOB = `job_${"c".repeat(32)}`;
const RESULT = Object.freeze({
  generationId: `espg_${"d".repeat(64)}`,
  collectionId: `esp_${"e".repeat(64)}`,
  state: "READY",
  becameActive: true,
});

async function digest(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function key(org = "org:extended", customer = "customer_extended", connection = CONNECTION) {
  return `extended-support:${[org, customer, connection, WINDOW]
    .map(encodeURIComponent).join(":")}`;
}

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `extended-runtime-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  const db = await mf.getD1Database("DB");
  for (const statement of [
    "CREATE TABLE organizations(id text PRIMARY KEY,status text NOT NULL)",
    "CREATE TABLE customers(id text PRIMARY KEY,org_id text NOT NULL,status text NOT NULL)",
    `CREATE TABLE aws_connections(
      id text PRIMARY KEY,org_id text NOT NULL,customer_id text NOT NULL,
      source_kind text NOT NULL,status text NOT NULL,aws_account_id text NOT NULL,
      partition text NOT NULL,enabled_regions_json text NOT NULL,
      permission_pack_version text NOT NULL)`,
  ]) await db.prepare(statement).run();
  const migration = await readFile(
    path.join(root, "drizzle/0118_finops_extended_support_runtime.sql"), "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")
    .map((part) => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.batch([
    db.prepare("INSERT INTO organizations VALUES(?,?)").bind("org:extended", "active"),
    db.prepare("INSERT INTO organizations VALUES(?,?)").bind("org_other", "active"),
    db.prepare("INSERT INTO customers VALUES(?,?,?)")
      .bind("customer_extended", "org:extended", "active"),
    db.prepare("INSERT INTO customers VALUES(?,?,?)")
      .bind("customer_other", "org_other", "active"),
    db.prepare("INSERT INTO aws_connections VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(CONNECTION, "org:extended", "customer_extended", "aws_trust_role", "active",
        "111122223333", "aws", '["us-east-1","us-west-2"]', "standard-2026-08.6"),
    db.prepare("INSERT INTO aws_connections VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(OTHER_CONNECTION, "org_other", "customer_other", "aws_trust_role", "active",
        "999988887777", "aws", '["us-east-1"]', "standard-2026-08.6"),
  ]);
  return { mf, db };
}

test("ADV-04 runtime repository loads only the persisted tenant AWS boundary", async () => {
  const { mf, db } = await fixture();
  try {
    const { ExtendedSupportRuntimeRepository } = await import(
      "../db/finops-extended-support-runtime-repository.ts"
    );
    const repository = new ExtendedSupportRuntimeRepository(db, {
      now: () => Date.parse(WINDOW),
      skipRuntimeSchema: true,
    });
    assert.deepEqual(await repository.loadBoundary({
      organizationId: "org:extended",
      customerId: "customer_extended",
      connectionId: CONNECTION,
    }), {
      scope: {
        orgId: "org:extended",
        customerId: "customer_extended",
        connectionId: CONNECTION,
      },
      managementAccountId: "111122223333",
      partition: "aws",
      accountIds: ["111122223333"],
      regions: ["us-east-1", "us-west-2"],
    });
    await assert.rejects(repository.loadBoundary({
      organizationId: "org:extended",
      customerId: "customer_extended",
      connectionId: OTHER_CONNECTION,
    }), (error) => error.code === "SCOPE_NOT_FOUND");
    const scopes = await repository.listEligibleScopes();
    assert.equal(scopes.length, 2);
    assert.ok(scopes.every((scope) => Object.keys(scope).length === 3));
  } finally { await mf.dispose(); }
});

test("ADV-04 receipts replay sealed results without another lease", async () => {
  const { mf, db } = await fixture();
  try {
    let now = Date.parse(WINDOW);
    let token = 0;
    const { ExtendedSupportRuntimeRepository } = await import(
      "../db/finops-extended-support-runtime-repository.ts"
    );
    const repository = new ExtendedSupportRuntimeRepository(db, {
      now: () => now,
      leaseToken: () => `lease_${String(++token).padStart(32, "0")}`,
      skipRuntimeSchema: true,
    });
    const claimed = await repository.claim({ key: key(), jobId: JOB, leaseDurationMs: 60_000 });
    assert.equal(claimed.state, "ACQUIRED");
    assert.deepEqual(await repository.claim({
      key: key(), jobId: `job_${"f".repeat(32)}`, leaseDurationMs: 60_000,
    }), { state: "IN_PROGRESS" });
    await repository.complete({
      key: key(), jobId: JOB, leaseToken: claimed.leaseToken,
      result: RESULT, resultSha256: await digest(RESULT),
    });
    assert.deepEqual(await repository.claim({
      key: key(), jobId: `job_${"f".repeat(32)}`, leaseDurationMs: 60_000,
    }), { state: "COMPLETED", result: RESULT, resultSha256: await digest(RESULT) });
    const receipt = await db.prepare(
      "SELECT state,result_sha256 FROM finops_extended_support_runtime_receipts WHERE idempotency_key=?",
    ).bind(key()).first();
    assert.deepEqual(receipt, { state: "COMPLETED", result_sha256: await digest(RESULT) });
    now += 120_000;
    await assert.rejects(repository.complete({
      key: key(), jobId: JOB, leaseToken: claimed.leaseToken,
      result: RESULT, resultSha256: await digest(RESULT),
    }), (error) => error.code === "LEASE_CONFLICT");
  } finally { await mf.dispose(); }
});

test("ADV-04 receipts recover expired and failed work with immutable failure evidence", async () => {
  const { mf, db } = await fixture();
  try {
    let now = Date.parse(WINDOW);
    let token = 0;
    const { ExtendedSupportRuntimeRepository } = await import(
      "../db/finops-extended-support-runtime-repository.ts"
    );
    const repository = new ExtendedSupportRuntimeRepository(db, {
      now: () => now,
      leaseToken: () => `lease_${String(++token).padStart(32, "0")}`,
      skipRuntimeSchema: true,
    });
    const first = await repository.claim({ key: key(), jobId: JOB, leaseDurationMs: 1_000 });
    now += 1_001;
    const secondJob = `job_${"f".repeat(32)}`;
    const second = await repository.claim({ key: key(), jobId: secondJob, leaseDurationMs: 60_000 });
    assert.equal(second.state, "ACQUIRED");
    assert.notEqual(second.leaseToken, first.leaseToken);
    await repository.fail({
      key: key(), jobId: secondJob, leaseToken: second.leaseToken,
      failureCode: "EXTENDED_SUPPORT_COLLECTION_FAILED",
    });
    assert.equal((await db.prepare(
      "SELECT COUNT(*) AS count FROM finops_extended_support_runtime_failures",
    ).first()).count, 1);
    now += 1;
    assert.equal((await repository.claim({
      key: key(), jobId: `job_${"9".repeat(32)}`, leaseDurationMs: 60_000,
    })).state, "ACQUIRED");
    await assert.rejects(repository.claim({
      key: key("org:extended", "customer_extended", OTHER_CONNECTION),
      jobId: JOB,
      leaseDurationMs: 60_000,
    }), (error) => error.code === "SCOPE_NOT_FOUND");
  } finally { await mf.dispose(); }
});
