import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  sqlite: new URL("../drizzle/0017_notification_destinations_outbox.sql", import.meta.url),
  postgres: new URL("../postgres/migrations/0011_notification_destinations_outbox.sql", import.meta.url),
  repository: new URL("../db/security-notification-repository.ts", import.meta.url),
  route: new URL("../app/api/v1/notification-destinations/route.ts", import.meta.url),
  worker: new URL("../services/notification-worker/worker.ts", import.meta.url),
  migrator: new URL("../scripts/postgres-migrate.mjs", import.meta.url),
};

test("migrations persist tenant-scoped destinations and a unique durable outbox", async () => {
  const [sqlite, postgres] = await Promise.all([
    readFile(files.sqlite, "utf8"),
    readFile(files.postgres, "utf8"),
  ]);
  for (const source of [sqlite, postgres]) {
    assert.match(source, /security_notification_destinations/);
    assert.match(source, /security_notification_outbox/);
    assert.match(source, /org_id/);
    assert.match(source, /customer_id/);
    assert.match(source, /destination_id/);
    assert.match(source, /idempotency_key/);
    assert.match(source, /scope_idempotency_uq/);
    assert.match(source, /next_attempt_at/);
    assert.match(source, /lease_token/);
    assert.match(source, /lease_expires_at/);
    assert.doesNotMatch(source, /webhook_url|access_key|secret_access_key|session_token/iu);
  }
});

test("repository claims atomically, recovers expired leases, and scopes every read", async () => {
  const source = await readFile(files.repository, "utf8");
  assert.match(source, /UPDATE security_notification_outbox SET[\s\S]*status = 'processing'/u);
  assert.match(source, /status = 'processing' AND lease_expires_at < \?/u);
  assert.match(source, /WHERE o\.org_id = \? AND o\.customer_id = \?/u);
  assert.match(source, /INSERT OR IGNORE INTO security_notification_outbox/u);
  assert.match(source, /ON CONFLICT \(org_id, customer_id, channel\)/u);
  assert.doesNotMatch(source, /webhookUrl|hooks\.slack\.com|logic\.azure\.com/u);
});

test("authenticated web API only queues; provider delivery remains worker-owned", async () => {
  const [route, worker] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.worker, "utf8"),
  ]);
  assert.match(route, /requireApiSession/);
  assert.match(route, /assertSessionCapability/);
  assert.match(route, /assertSameOrigin/);
  assert.match(route, /\.enqueue\(/);
  assert.doesNotMatch(route, /deliverSecurityNotification|fetch\(\s*["'`]https:\/\/|resolveWebhook/u);
  assert.match(worker, /deliverSecurityNotification/);
  assert.match(worker, /DELIVERY_ADAPTER_NOT_CONFIGURED/);
  assert.match(worker, /retry_scheduled/);
  assert.match(worker, /dead_letter/);
});

test("runtime manifests include the reserved additive migration numbers", async () => {
  const [sqlite, postgres, migrator] = await Promise.all([
    readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(files.migrator, "utf8"),
  ]);
  assert.match(sqlite, /0017_notification_destinations_outbox/);
  assert.match(postgres, /0011_notification_destinations_outbox/);
  assert.match(migrator, /0011_notification_destinations_outbox\.sql/);
});
