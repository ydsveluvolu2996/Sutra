import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  createAwsNewsFeedsControlledEgressFetcher,
  createAwsNewsFeedsProductionComposition,
} = await import("../lib/finops-aws-news-feeds-production-composition.ts");
const {
  AwsNewsFeedsRuntimeBindingError,
} = await import("../lib/finops-aws-news-feeds-runtime-binding.ts");

const ORG_A = "org_news_composition_a";
const ORG_B = "org_news_composition_b";
const CUSTOMER_A = "customer_news_composition_a";
const CUSTOMER_B = "customer_news_composition_b";
const CONNECTION_A = `conn_${"c".repeat(32)}`;
const CONNECTION_B = `conn_${"d".repeat(32)}`;
const WINDOW = "2026-07-31T12:00:00.000Z";
const SCHEDULED_AT = Date.parse("2026-07-31T12:10:00.000Z");

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
    d1Databases: { DB: `sutra-news-composition-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'news-ca','News CA','active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id,slug,name,status) VALUES (?,'news-cb','News CB','active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'news-cca','News CCA','active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id,org_id,slug,name,status) VALUES (?,?,'news-ccb','News CCB','active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, "111122223333"),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, "444455556666"),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

function boundary(scope) {
  return {
    scope: { orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId },
    binding: "SERVER_RESOLVED_CONNECTION",
    catalogId: `catalog_${scope.connectionId.slice(5).repeat(2)}`,
    catalogCapturedAt: "2026-07-31T11:59:00.000Z",
    services: [],
  };
}

function clock() {
  let value = Date.parse(WINDOW);
  return () => {
    const current = value;
    value += 100;
    return current;
  };
}

function xmlResponse(url, partialUrl = null) {
  if (url === partialUrl) return new Response("", { status: 503 });
  if (new URL(url).hostname === "www.youtube.com") {
    return new Response("<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>", {
      status: 200,
      headers: { "content-type": "application/atom+xml" },
    });
  }
  return new Response("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>AWS</title></channel></rss>", {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
  });
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

test("controlled egress rejects SSRF, credential/header injection, writes, and automatic redirects", async () => {
  let calls = 0;
  const controlled = createAwsNewsFeedsControlledEgressFetcher(async () => {
    calls += 1;
    return xmlResponse("https://aws.amazon.com/about-aws/whats-new/recent/feed/");
  });
  const signal = new AbortController().signal;
  const valid = {
    method: "GET",
    redirect: "manual",
    signal,
    credentials: "omit",
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9",
      "User-Agent": "Sutra-AWS-News-Feeds/1.0",
    },
  };
  await controlled("https://aws.amazon.com/about-aws/whats-new/recent/feed/", valid);
  for (const [url, init] of [
    ["https://169.254.169.254/latest/meta-data", valid],
    ["https://evil.example/feed", valid],
    ["https://aws.amazon.com/about-aws/whats-new/recent/feed/", { ...valid, method: "POST" }],
    ["https://aws.amazon.com/about-aws/whats-new/recent/feed/", { ...valid, redirect: "follow" }],
    ["https://aws.amazon.com/about-aws/whats-new/recent/feed/", { ...valid, headers: { ...valid.headers, Authorization: "secret" } }],
    ["https://aws.amazon.com/about-aws/whats-new/recent/feed/", { ...valid, body: "secret" }],
  ]) {
    await assert.rejects(controlled(url, init), /AWS_NEWS_FEEDS_EGRESS_POLICY_REJECTED/u);
  }
  assert.equal(calls, 1);
});

test("production composition schedules, collects all pinned families, persists one READY generation, and replays", async () => {
  await withDatabase(async (database) => {
    let fetchCount = 0;
    await database.prepare(`INSERT INTO resources (
      id,org_id,customer_id,connection_id,provider_key,aws_account_id,region_key,
      resource_type,native_id,lifecycle_state,configuration_json,content_sha256,
      first_seen_at,last_seen_at
    ) VALUES (?,?,?,?,?,?,?,?,?,'active','{}',?,?,?)`).bind(
      "resource-news-ec2", ORG_A, CUSTOMER_A, CONNECTION_A, "aws", "111122223333",
      "us-east-1", "aws_ec2_instance", "i-0123456789abcdef0", "a".repeat(64),
      Date.parse(WINDOW) - 2_000, Date.parse(WINDOW) - 1_000,
    ).run();
    const composition = createAwsNewsFeedsProductionComposition({
      database,
      now: clock(),
      replay: {
        skipRuntimeSchema: true,
        leaseToken: () => `lease_${"1".repeat(32)}`,
      },
      fetcher: async (url, init) => {
        fetchCount += 1;
        assert.equal(init.redirect, "manual");
        assert.equal(init.credentials, "omit");
        assert.equal(init.signal.aborted, false);
        return xmlResponse(url);
      },
    });
    const catalog = await composition.replayRepository.loadTenantBoundary({
      organizationId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A,
    }, new AbortController().signal);
    assert.equal(catalog.services[0].displayName, "Amazon EC2");
    assert.equal(catalog.services[0].observation.basis, "RESOURCE_INVENTORY");
    assert.deepEqual(await composition.scheduleTick(SCHEDULED_AT), {
      schemaVersion: "sutra.aws-news-feeds-runtime-binding.v1",
      scheduledWindow: WINDOW,
      connectionCount: 2,
      submittedCount: 2,
      rejectedCount: 0,
    });
    const row = await database.prepare(
      "SELECT * FROM background_jobs WHERE connection_id=? LIMIT 1",
    ).bind(CONNECTION_A).first();
    await composition.handler(runnable(row));
    assert.equal(fetchCount, 5);
    assert.equal((await composition.snapshotRepository.getActiveSnapshot({
      organizationId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A,
    }))?.snapshot.state, "READY");
    assert.equal((await database.prepare(
      "SELECT count(*) AS count FROM finops_aws_news_feed_snapshots WHERE org_id=? AND customer_id=? AND connection_id=?",
    ).bind(ORG_A, CUSTOMER_A, CONNECTION_A).first()).count, 1);
    await composition.handler(runnable(row));
    assert.equal(fetchCount, 5, "same-window replay must not perform network I/O");
    assert.equal((await database.prepare(
      "SELECT count(*) AS count FROM finops_aws_news_feed_snapshots WHERE org_id=? AND customer_id=? AND connection_id=?",
    ).bind(ORG_A, CUSTOMER_A, CONNECTION_A).first()).count, 1);
  });
});

test("partial feeds never fabricate READY, and a cross-tenant catalog cannot persist", async () => {
  await withDatabase(async (database) => {
    const partialUrl = "https://aws.amazon.com/blogs/security/feed/";
    const partial = createAwsNewsFeedsProductionComposition({
      database,
      now: clock(),
      replay: { skipRuntimeSchema: true, leaseToken: () => `lease_${"2".repeat(32)}` },
      fetcher: async (url) => xmlResponse(url, partialUrl),
      loadTenantBoundary: async (scope) => boundary(scope),
    });
    await partial.scheduleTick(SCHEDULED_AT);
    const rowB = await database.prepare(
      "SELECT * FROM background_jobs WHERE connection_id=? LIMIT 1",
    ).bind(CONNECTION_B).first();
    await partial.handler(runnable(rowB));
    assert.equal((await partial.snapshotRepository.getLatestSnapshot({
      organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B,
    }))?.snapshot.state, "PARTIAL");
    assert.equal(await partial.snapshotRepository.getActiveSnapshot({
      organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B,
    }), null);

    const hostile = createAwsNewsFeedsProductionComposition({
      database,
      now: clock(),
      replay: { skipRuntimeSchema: true, leaseToken: () => `lease_${"3".repeat(32)}` },
      fetcher: async (url) => xmlResponse(url),
      loadTenantBoundary: async () => boundary({
        organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B,
      }),
    });
    const nextWindow = "2026-07-31T18:00:00.000Z";
    const hostileJob = {
      id: `job_${"9".repeat(32)}`,
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      kind: "finops-aws-news-feeds-collect",
      payload: { scheduledWindow: nextWindow },
      attempt: 1,
      maxAttempts: 5,
    };
    await assert.rejects(
      hostile.handler(hostileJob),
      (error) => !(error instanceof AwsNewsFeedsRuntimeBindingError)
        && error.name === "AwsNewsFeedsDurableHandlerError"
        && error.code === "COLLECTION_FAILED"
        && !error.message.includes(ORG_B),
    );
    assert.equal((await database.prepare(
      "SELECT count(*) AS count FROM finops_aws_news_feed_snapshots WHERE org_id=? AND customer_id=? AND connection_id=?",
    ).bind(ORG_A, CUSTOMER_A, CONNECTION_A).first()).count, 0);
    const failure = await database.prepare(
      "SELECT failure_code FROM finops_aws_news_feed_replay_failures WHERE org_id=? AND customer_id=? AND connection_id=?",
    ).bind(ORG_A, CUSTOMER_A, CONNECTION_A).first();
    assert.equal(failure.failure_code, "AWS_NEWS_FEEDS_COLLECTION_FAILED");
  });
});
