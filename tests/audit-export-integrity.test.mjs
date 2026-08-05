import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { listAuditEventsForOrg } = await import("../db/audit-export-repository.ts");
const {
  AuditIntegrityError,
  buildVerifiedAuditExport,
  computeAuditEventHash,
} = await import("../lib/audit-export.ts");

const ORG_A = "org_audit_export_alpha";
const ORG_B = "org_audit_export_beta";

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-audit-export-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status, created_at) VALUES (?, 'audit-a', 'Audit A', 'active', ?)",
      ).bind(ORG_A, Date.now()),
      database.prepare(
        "INSERT INTO organizations (id, slug, name, status, created_at) VALUES (?, 'audit-b', 'Audit B', 'active', ?)",
      ).bind(ORG_B, Date.now()),
    ]);
    await run(database);
  } finally {
    await miniflare.dispose();
  }
}

async function seedEvents() {
  await pilotRepository.appendAuditEvent({
    orgId: ORG_A,
    actorId: "usr_alpha",
    action: "audit.test.started",
    targetType: "organization",
    targetId: ORG_A,
    customerId: null,
    outcome: "allowed",
    requestId: "audit-export-alpha-1",
    metadata: { sequence: 1 },
  });
  await pilotRepository.appendAuditEvent({
    orgId: ORG_A,
    actorId: "usr_alpha",
    action: "audit.test.finished",
    targetType: "organization",
    targetId: ORG_A,
    customerId: null,
    outcome: "allowed",
    requestId: "audit-export-alpha-2",
    metadata: { sequence: 2 },
  });
  await pilotRepository.appendAuditEvent({
    orgId: ORG_B,
    actorId: "usr_beta",
    action: "audit.test.other",
    targetType: "organization",
    targetId: ORG_B,
    customerId: null,
    outcome: "allowed",
    requestId: "audit-export-beta-1",
    metadata: { tenant: "beta" },
  });
}

test("audit export is organization-scoped and verifies every hash-chain link", async () => {
  await withDatabase(async (database) => {
    await seedEvents();
    const events = await listAuditEventsForOrg(ORG_A, database);
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.hashVersion === 2));
    assert.ok(events.every((event) => event.orgId === ORG_A));
    assert.equal(JSON.stringify(events).includes(ORG_B), false);
    const exported = await buildVerifiedAuditExport({
      orgId: ORG_A,
      exportedAt: "2026-07-30T00:00:00.000Z",
      events,
    });
    assert.equal(exported.eventCount, 2);
    assert.equal(exported.chainHead, events[1].eventHash);
    assert.match(exported.exportSha256, /^[a-f0-9]{64}$/u);
  });
});

test("audit export detects changed evidence, changed hash, and a missing first event", async () => {
  await withDatabase(async (database) => {
    await seedEvents();
    const events = await listAuditEventsForOrg(ORG_A, database);
    for (const altered of [
      [{ ...events[0], metadataJson: '{"sequence":99}' }, events[1]],
      [{ ...events[0], actorType: "system" }, events[1]],
      [events[0], { ...events[1], eventHash: "a".repeat(64) }],
      [events[1]],
    ]) {
      await assert.rejects(
        buildVerifiedAuditExport({
          orgId: ORG_A,
          exportedAt: "2026-07-30T00:00:00.000Z",
          events: altered,
        }),
        AuditIntegrityError,
      );
    }
  });
});

test("legacy v1 audit rows remain exportable while new v2 actor type is integrity protected", async () => {
  const legacy = {
    eventId: "audit_legacy",
    orgId: ORG_A,
    customerId: null,
    occurredAt: 1,
    actorType: "user",
    actorId: "usr_legacy",
    action: "audit.legacy",
    targetType: "organization",
    targetId: ORG_A,
    outcome: "allowed",
    requestId: "legacy-request",
    metadataJson: '{"legacy":true}',
    previousEventHash: null,
    hashVersion: 1,
  };
  const event = { ...legacy, eventHash: await computeAuditEventHash(legacy) };
  assert.equal((await buildVerifiedAuditExport({
    orgId: ORG_A,
    exportedAt: "2026-07-30T00:00:00.000Z",
    events: [event],
  })).eventCount, 1);

  // v1 could not cover actorType. Migration preserves that historical fact
  // instead of pretending old rows have v2 assurance.
  assert.equal((await buildVerifiedAuditExport({
    orgId: ORG_A,
    exportedAt: "2026-07-30T00:00:00.000Z",
    events: [{ ...event, actorType: "system" }],
  })).eventCount, 1);

  const v2 = { ...legacy, hashVersion: 2, actorType: "user" };
  const v2Event = { ...v2, eventHash: await computeAuditEventHash(v2) };
  await assert.rejects(
    buildVerifiedAuditExport({
      orgId: ORG_A,
      exportedAt: "2026-07-30T00:00:00.000Z",
      events: [{ ...v2Event, actorType: "system" }],
    }),
    AuditIntegrityError,
  );
});

test("audit hash version migration is registered for D1, PostgreSQL runtime, and migrator", async () => {
  const files = await Promise.all([
    readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0072_audit_hash_version.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0067_audit_hash_version.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(files[0], /0072_audit_hash_version/u);
  assert.match(files[1], /0067_audit_hash_version/u);
  assert.match(files[2], /0067_audit_hash_version\.sql/u);
  for (const sql of files.slice(3, 5)) {
    assert.match(sql, /hash_version/u);
    assert.match(sql, /DEFAULT 1/iu);
  }
  const schema = files[5];
  const invitationEvents = schema.slice(
    schema.indexOf("export const identityInvitationEvents"),
    schema.indexOf("export const customers"),
  );
  const auditEvents = schema.slice(
    schema.indexOf("export const auditEvents"),
    schema.indexOf("export const localScheduleMutationOutbox"),
  );
  assert.doesNotMatch(invitationEvents, /hashVersion/u);
  assert.match(auditEvents, /hashVersion: integer\("hash_version"\)\.notNull\(\)\.default\(1\)/u);
});

test("audit export route is owner-only, writes its audit event before reading, and never caches", async () => {
  const source = await readFile(
    new URL("../app/api/v1/audit/export/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /isOrganizationOwner\(authenticated\.subject\)/u);
  assert.ok(source.indexOf("await appendAuditEvent(") < source.indexOf("events: await listAuditEventsForOrg("));
  assert.match(source, /safeCsvCell/u);
  assert.match(source, /"cache-control": "no-store"/u);
});
