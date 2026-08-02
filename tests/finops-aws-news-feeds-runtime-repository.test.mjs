import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  AwsNewsFeedsRuntimeRepository,
  AwsNewsFeedsRuntimeRepositoryError,
} = await import("../db/finops-aws-news-feeds-runtime-repository.ts");
const {
  AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_STATUS,
} = await import("../lib/finops-aws-news-feeds-production-composition.ts");

const ORG_A = "org_news_runtime_a";
const ORG_B = "org_news_runtime_b";
const CUSTOMER_A = "customer_news_runtime_a";
const CUSTOMER_B = "customer_news_runtime_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const WINDOW_A = "2026-07-31T12:00:00.000Z";
const WINDOW_B = "2026-07-31T18:00:00.000Z";
const JOB_A = `job_${"1".repeat(32)}`;
const JOB_B = `job_${"2".repeat(32)}`;
const KEY_A = `aws-news-feeds:${ORG_A}:${CUSTOMER_A}:${CONNECTION_A}:${WINDOW_A}`;
const KEY_B = `aws-news-feeds:${ORG_B}:${CUSTOMER_B}:${CONNECTION_B}:${WINDOW_B}`;

function connection(database, id, orgId, customerId, accountId, status = "active") {
  return database.prepare(`INSERT INTO aws_connections (
    id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
    external_id_ciphertext,external_id_key_version,permission_pack_version,status,enabled_regions_json
  ) VALUES (?,?,?,'aws_trust_role','aws',?,?,'ct','v1','standard-2026-08.1',?,'[]')`)
    .bind(id, orgId, customerId, accountId,
      `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`, status);
}

async function withRuntime(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-news-runtime-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'news-ra','News RA','active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'news-rb','News RB','active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'news-rca','News RCA','active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'news-rcb','News RCB','active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, "111122223333"),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, "444455556666"),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function sha(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

test("durable claims are tenant-bound, lease-safe, and replay exact hashed results", async () => {
  await withRuntime(async (database) => {
    let now = Date.parse(WINDOW_A);
    let tokenIndex = 0;
    const repository = new AwsNewsFeedsRuntimeRepository(database, {
      now: () => now,
      leaseToken: () => `lease_${String(++tokenIndex).padStart(32, "0")}`,
      skipRuntimeSchema: true,
    });
    const first = await repository.claim({ key: KEY_A, jobId: JOB_A, leaseDurationMs: 60_000 });
    assert.deepEqual(first, { state: "ACQUIRED", leaseToken: `lease_${"0".repeat(31)}1` });
    assert.deepEqual(
      await repository.claim({ key: KEY_A, jobId: JOB_B, leaseDurationMs: 60_000 }),
      { state: "IN_PROGRESS" },
    );
    now += 60_001;
    const reclaimed = await repository.claim({ key: KEY_A, jobId: JOB_B, leaseDurationMs: 60_000 });
    assert.equal(reclaimed.state, "ACQUIRED");
    await assert.rejects(
      repository.complete({
        key: KEY_A, jobId: JOB_A, leaseToken: first.leaseToken,
        result: { generationId: `newsg_${"a".repeat(64)}`, captureId: `news_${"b".repeat(64)}`, state: "READY", becameActive: true },
        resultSha256: "0".repeat(64),
      }),
      (error) => error instanceof AwsNewsFeedsRuntimeRepositoryError,
    );
    const result = {
      generationId: `newsg_${"c".repeat(64)}`,
      captureId: `news_${"d".repeat(64)}`,
      state: "READY",
      becameActive: true,
    };
    const resultSha256 = await sha(JSON.stringify(result));
    await repository.complete({
      key: KEY_A, jobId: JOB_B, leaseToken: reclaimed.leaseToken, result, resultSha256,
    });
    assert.deepEqual(
      await repository.claim({ key: KEY_A, jobId: JOB_A, leaseDurationMs: 60_000 }),
      { state: "COMPLETED", result, resultSha256 },
    );
  });
});

test("cross-tenant substitutions fail before receipt mutation and corrupt stored receipts fail closed", async () => {
  await withRuntime(async (database) => {
    const repository = new AwsNewsFeedsRuntimeRepository(database, {
      now: () => Date.parse(WINDOW_A),
      leaseToken: () => `lease_${"a".repeat(32)}`,
      skipRuntimeSchema: true,
    });
    const substituted = `aws-news-feeds:${ORG_A}:${CUSTOMER_B}:${CONNECTION_A}:${WINDOW_A}`;
    await assert.rejects(
      repository.claim({ key: substituted, jobId: JOB_A, leaseDurationMs: 60_000 }),
      (error) => error instanceof AwsNewsFeedsRuntimeRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
    assert.equal((await database.prepare("SELECT count(*) AS count FROM finops_aws_news_feed_replay_receipts").first()).count, 0);

    const corruptJson = JSON.stringify({ bad: true });
    await database.prepare(`INSERT INTO finops_aws_news_feed_replay_receipts (
      idempotency_key,org_id,customer_id,connection_id,scheduled_window,state,job_id,
      result_json,result_sha256,completed_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,'COMPLETED',?,?,?,?,?,?)`).bind(
      KEY_B, ORG_B, CUSTOMER_B, CONNECTION_B, WINDOW_B, JOB_B,
      corruptJson, await sha(corruptJson), Date.parse(WINDOW_B), Date.parse(WINDOW_B), Date.parse(WINDOW_B),
    ).run();
    await assert.rejects(
      repository.claim({ key: KEY_B, jobId: JOB_B, leaseDurationMs: 60_000 }),
      (error) => error instanceof AwsNewsFeedsRuntimeRepositoryError && error.code === "STORED_STATE_INVALID",
    );
  });
});

test("failures retain only an immutable fixed category and can be safely retried", async () => {
  await withRuntime(async (database) => {
    let now = Date.parse(WINDOW_A);
    let tokenIndex = 8;
    const repository = new AwsNewsFeedsRuntimeRepository(database, {
      now: () => now,
      leaseToken: () => `lease_${String(++tokenIndex).padStart(32, "0")}`,
      skipRuntimeSchema: true,
    });
    const claim = await repository.claim({ key: KEY_A, jobId: JOB_A, leaseDurationMs: 60_000 });
    await repository.fail({
      key: KEY_A, jobId: JOB_A, leaseToken: claim.leaseToken,
      failureCode: "AWS_NEWS_FEEDS_COLLECTION_FAILED",
    });
    const failure = await database.prepare("SELECT * FROM finops_aws_news_feed_replay_failures").first();
    assert.equal(failure.failure_code, "AWS_NEWS_FEEDS_COLLECTION_FAILED");
    assert.equal(JSON.stringify(failure).includes("secret"), false);
    await assert.rejects(
      database.prepare("UPDATE finops_aws_news_feed_replay_failures SET failure_code='secret'").run(),
      /FINOPS_AWS_NEWS_FEED_REPLAY_FAILURE_IMMUTABLE/u,
    );
    now += 1;
    assert.equal((await repository.claim({ key: KEY_A, jobId: JOB_B, leaseDurationMs: 60_000 })).state, "ACQUIRED");
    assert.equal((await database.prepare("SELECT count(*) AS count FROM finops_aws_news_feed_replay_failures").first()).count, 1);
  });
});

test("active discovery is bounded and both migration registries install the immutable replay ledger", async () => {
  await withRuntime(async (database) => {
    const repository = new AwsNewsFeedsRuntimeRepository(database, { skipRuntimeSchema: true });
    assert.deepEqual((await repository.listActiveConnections()).map((item) => item.connectionId), [CONNECTION_A, CONNECTION_B]);
    assert.equal(AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_STATUS.activationState,
      "REGISTERED_LOCAL_RUNTIME");
    assert.equal(AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_STATUS.sqliteMigrationRegistered, true);
    assert.equal(AWS_NEWS_FEEDS_PRODUCTION_COMPOSITION_STATUS.postgresMigrationRegistered, true);
    for (const url of [
      new URL("../drizzle/0117_finops_aws_news_feeds_replay.sql", import.meta.url),
      new URL("../postgres/migrations/0113_finops_aws_news_feeds_replay.sql", import.meta.url),
    ]) {
      const sql = await readFile(url, "utf8");
      assert.match(sql, /AWS_NEWS_FEEDS_COLLECTION_FAILED/u);
      assert.match(sql, /REPLAY_(?:RECEIPT|FAILURE)_IMMUTABLE/u);
      assert.match(sql, /connection_id/u);
    }
    const sqliteRegistry = await readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8");
    const postgresRegistry = await readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8");
    assert.match(sqliteRegistry, /0117_finops_aws_news_feeds_replay/u);
    assert.match(postgresRegistry, /0113_finops_aws_news_feeds_replay/u);
  });
});
