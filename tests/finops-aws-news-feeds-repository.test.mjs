import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { AwsNewsFeedsRepository } = await import("../db/finops-aws-news-feeds-repository.ts");
const { AWS_NEWS_FEED_SOURCES } = await import("../lib/finops-aws-news-feeds.ts");

const ORG_A = "org_news_a";
const ORG_B = "org_news_b";
const CUSTOMER_A = "customer_news_a";
const CUSTOMER_B = "customer_news_b";
const CONNECTION_A = `conn_${"a".repeat(32)}`;
const CONNECTION_B = `conn_${"b".repeat(32)}`;
const SCOPE_A = { organizationId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A };
const SCOPE_B = { organizationId: ORG_B, customerId: CUSTOMER_B, connectionId: CONNECTION_B };

function connection(database, id, orgId, customerId, accountId) {
  return database.prepare(`INSERT INTO aws_connections (
    id, org_id, customer_id, source_kind, partition, aws_account_id, role_arn,
    external_id_ciphertext, external_id_key_version, permission_pack_version,
    status, enabled_regions_json
  ) VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, 'ct', 'v1',
    'standard-2026-08.1', 'active', '[]')`).bind(id, orgId, customerId, accountId, `arn:aws:iam::${accountId}:role/sutra/SutraCollectorRole`);
}

async function withRepository(run) {
  const miniflare = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", compatibilityDate: "2026-05-22", d1Databases: { DB: `sutra-news-${crypto.randomUUID()}` }, d1Persist: false });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'news-a', 'News A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'news-b', 'News B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'news-ca', 'News CA', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'news-cb', 'News CB', 'active')").bind(CUSTOMER_B, ORG_B),
      connection(database, CONNECTION_A, ORG_A, CUSTOMER_A, "111122223333"),
      connection(database, CONNECTION_B, ORG_B, CUSTOMER_B, "999900001111"),
    ]);
    await run({ database, repository: new AwsNewsFeedsRepository(database) });
  } finally { await miniflare.dispose(); }
}

function input(character, completedAt, partial = false) {
  const startMs = Date.parse(completedAt) - 20_000;
  const fetchedAt = new Date(Date.parse(completedAt) - 10_000).toISOString();
  const feeds = AWS_NEWS_FEED_SOURCES.map((source, index) => partial && index === 0 ? {
    sourceId: source.id, status: "FAILED", requestUrl: source.feedUrl, finalUrl: null,
    redirectChain: [source.feedUrl], contentType: null, responseBytes: 0, durationMs: 100,
    fetchedAt, parser: null, truncated: false, failureCode: "PROVIDER_UNAVAILABLE", items: [],
  } : {
    sourceId: source.id, status: "SUCCEEDED", requestUrl: source.feedUrl, finalUrl: source.feedUrl,
    redirectChain: [source.feedUrl], contentType: source.parser === "ATOM_1" ? "application/atom+xml" : "application/rss+xml",
    responseBytes: 100, durationMs: 100, fetchedAt, parser: source.parser, truncated: false, failureCode: null,
    items: [],
  });
  return {
    capture: { schemaVersion: "sutra.aws-news-feeds.v1", scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A }, captureId: `news_${character.repeat(64)}`, startedAt: new Date(startMs).toISOString(), completedAt, feeds },
    boundary: { scope: { orgId: ORG_A, customerId: CUSTOMER_A, connectionId: CONNECTION_A }, binding: "SERVER_RESOLVED_CONNECTION", catalogId: `catalog_${character.repeat(64)}`, catalogCapturedAt: new Date(startMs - 1_000).toISOString(), services: [] },
  };
}

test("ready captures are replay-safe, tenant-bound, immutable, and advance only monotonically", async () => {
  await withRepository(async ({ database, repository }) => {
    const first = input("a", "2026-07-31T12:00:00.000Z");
    const stored = await repository.recordCapture(SCOPE_A, first.capture, first.boundary, Date.parse(first.capture.completedAt));
    assert.equal(stored.becameActive, true);
    assert.equal((await repository.recordCapture(SCOPE_A, first.capture, first.boundary, Date.parse(first.capture.completedAt))).becameActive, false);
    assert.equal((await repository.getActiveSnapshot(SCOPE_A))?.snapshot.captureId, first.capture.captureId);
    assert.equal(await repository.getActiveSnapshot(SCOPE_B), null);

    const newer = input("b", "2026-07-31T18:00:00.000Z");
    await repository.recordCapture(SCOPE_A, newer.capture, newer.boundary, Date.parse(newer.capture.completedAt));
    assert.equal((await repository.getActiveSnapshot(SCOPE_A))?.snapshot.captureId, newer.capture.captureId);
    await assert.rejects(database.prepare("UPDATE finops_aws_news_feed_snapshots SET source_state = 'FAILED' WHERE capture_id = ?").bind(newer.capture.captureId).run(), /FINOPS_AWS_NEWS_FEED_SNAPSHOT_IMMUTABLE/u);
  });
});

test("a newer partial capture remains history-only and cannot displace the accepted head", async () => {
  await withRepository(async ({ repository }) => {
    const ready = input("c", "2026-07-31T12:00:00.000Z");
    const partial = input("d", "2026-07-31T18:00:00.000Z", true);
    await repository.recordCapture(SCOPE_A, ready.capture, ready.boundary, Date.parse(ready.capture.completedAt));
    const recorded = await repository.recordCapture(SCOPE_A, partial.capture, partial.boundary, Date.parse(partial.capture.completedAt));
    assert.equal(recorded.becameActive, false);
    assert.equal((await repository.getLatestSnapshot(SCOPE_A))?.snapshot.state, "PARTIAL");
    assert.equal((await repository.getActiveSnapshot(SCOPE_A))?.snapshot.captureId, ready.capture.captureId);
    assert.deepEqual((await repository.listHistory(SCOPE_A)).map((value) => value.state), ["PARTIAL", "READY"]);
  });
});
