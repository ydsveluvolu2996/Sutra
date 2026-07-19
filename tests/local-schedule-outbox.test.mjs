import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { register } from "node:module";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const pilotRepository = await import("../db/pilot-repository.ts");
const outboxRepository = await import("../db/local-schedule-outbox-repository.ts");
const runtimeMigrations = await import("../db/runtime-migrations.ts");

const ORG_ID = pilotRepository.LOCAL_ORG_ID;
const FIXTURE_ID = "northstar-retail";
const ACTOR_ID = "usr_local_outbox_test";
const FIRST_RUN_AT = "2026-07-16T06:00:00.000Z";

let miniflare;
let database;

function mutation(character, overrides = {}) {
  return {
    operationId: `schedop_${character.repeat(48)}`,
    orgId: ORG_ID,
    actorId: ACTOR_ID,
    customerId: null,
    scheduleId: `sched_${character.repeat(48)}`,
    fixtureId: FIXTURE_ID,
    connectionId: `conn_${character.repeat(32)}`,
    operationKind: "upsert",
    command: {
      fixtureId: FIXTURE_ID,
      version: "2026.07.0",
      everyMs: 300_000,
      enabled: true,
      firstRunAt: FIRST_RUN_AT,
    },
    ...overrides,
  };
}

async function countAuditEvents(operationId) {
  const row = await database.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE org_id = ? AND request_id = ?",
  ).bind(ORG_ID, operationId).first();
  return Number(row?.count ?? 0);
}

describe("local schedule mutation outbox", () => {
  before(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-05-22",
      d1Databases: { DB: "sutra-outbox-test" },
      d1Persist: false,
    });
    database = await miniflare.getD1Database("DB");
    cloudflare.env.DB = database;
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.prepare(
      "INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, ?, 'active')",
    ).bind(ORG_ID, "local-sutra", "Sutra local MSP").run();
  });

  beforeEach(async () => {
    await database.batch([
      database.prepare("DELETE FROM local_schedule_mutation_outbox"),
      database.prepare("DELETE FROM audit_events"),
    ]);
  });

  after(async () => {
    await miniflare?.dispose();
  });

  it("registers the checked-in table and unique audit request index", async () => {
    const rows = await database.prepare(
      `SELECT name, type FROM sqlite_master
        WHERE name IN (
          'local_schedule_mutation_outbox',
          'local_schedule_mutation_outbox_sequence_uq',
          'audit_events_org_request_id_uq'
        )
        ORDER BY name`,
    ).all();
    assert.deepEqual(
      rows.results?.map(({ name, type }) => ({ name, type })),
      [
        { name: "audit_events_org_request_id_uq", type: "index" },
        { name: "local_schedule_mutation_outbox", type: "table" },
        { name: "local_schedule_mutation_outbox_sequence_uq", type: "index" },
      ],
    );
    const columns = await database.prepare(
      "PRAGMA table_info('local_schedule_mutation_outbox')",
    ).all();
    const sequence = columns.results?.find(({ name }) => name === "mutation_sequence");
    assert.equal(sequence?.type, "INTEGER");
    assert.equal(sequence?.pk, 0);
  });

  it("begins idempotently, rejects conflicting reuse, and lists deterministically", async () => {
    const second = mutation("b");
    const first = mutation("a");
    const created = await outboxRepository.beginLocalScheduleMutation(second);
    const replay = await outboxRepository.beginLocalScheduleMutation(second);
    assert.equal(replay.operationId, created.operationId);
    assert.equal(replay.createdAt, created.createdAt);
    assert.equal(replay.mutationSequence, created.mutationSequence);

    await assert.rejects(
      outboxRepository.beginLocalScheduleMutation({
        ...second,
        command: { ...second.command, enabled: false },
      }),
      (error) => error?.code === "CONFLICT",
    );

    await outboxRepository.beginLocalScheduleMutation(first);
    await database.prepare(
      "UPDATE local_schedule_mutation_outbox SET created_at = 1000, updated_at = 1000",
    ).run();
    const pending = await outboxRepository.listPendingLocalScheduleMutations({ orgId: ORG_ID });
    assert.deepEqual(pending.map((item) => item.operationId), [second.operationId, first.operationId]);
    assert.ok(pending.every((item) => item.status === "pending"));
    assert.ok(pending[0].mutationSequence < pending[1].mutationSequence);
  });

  it("atomically converges concurrent upsert retries on the stored first-run timestamp", async () => {
    const input = mutation("9");
    const laterTimestamp = "2026-07-16T06:00:01.000Z";
    const [first, second] = await Promise.all([
      outboxRepository.beginLocalScheduleMutation(input),
      outboxRepository.beginLocalScheduleMutation({
        ...input,
        command: { ...input.command, firstRunAt: laterTimestamp },
      }),
    ]);

    assert.equal(first.operationId, second.operationId);
    assert.equal(first.mutationSequence, second.mutationSequence);
    assert.equal(first.command.firstRunAt, second.command.firstRunAt);
    assert.ok([FIRST_RUN_AT, laterTimestamp].includes(first.command.firstRunAt));
  });

  it("assigns unique durable order to concurrent distinct operations", async () => {
    const inputs = ["0", "1", "2", "3", "4", "5"].map((character) =>
      mutation(character));
    const created = await Promise.all(
      inputs.map((input) => outboxRepository.beginLocalScheduleMutation(input)),
    );
    const sequences = created.map((item) => item.mutationSequence);
    assert.equal(new Set(sequences).size, inputs.length);
    assert.ok(sequences.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0));
    const pending = await outboxRepository.listPendingLocalScheduleMutations({ orgId: ORG_ID });
    assert.deepEqual(
      pending.map((item) => item.mutationSequence),
      [...sequences].sort((left, right) => left - right),
    );
  });

  it("completes with one hash-chained event and remains idempotent", async () => {
    const input = mutation("c");
    await outboxRepository.beginLocalScheduleMutation(input);
    const completed = await outboxRepository.completeLocalScheduleMutation({
      orgId: ORG_ID,
      operationId: input.operationId,
    });
    assert.equal(completed.status, "completed");
    assert.notEqual(completed.completedAt, null);
    assert.equal(await countAuditEvents(input.operationId), 1);

    const replay = await outboxRepository.completeLocalScheduleMutation({
      orgId: ORG_ID,
      operationId: input.operationId,
    });
    assert.equal(replay.completedAt, completed.completedAt);
    assert.equal(await countAuditEvents(input.operationId), 1);

    const audit = await database.prepare(
      `SELECT previous_event_hash, event_hash FROM audit_events
        WHERE org_id = ? AND request_id = ? LIMIT 1`,
    ).bind(ORG_ID, input.operationId).first();
    assert.equal(audit?.previous_event_hash, null);
    assert.match(audit?.event_hash ?? "", /^[a-f0-9]{64}$/u);

    const next = mutation("f");
    await outboxRepository.beginLocalScheduleMutation(next);
    await outboxRepository.completeLocalScheduleMutation({
      orgId: ORG_ID,
      operationId: next.operationId,
    });
    const nextAudit = await database.prepare(
      `SELECT previous_event_hash FROM audit_events
        WHERE org_id = ? AND request_id = ? LIMIT 1`,
    ).bind(ORG_ID, next.operationId).first();
    assert.equal(nextAudit?.previous_event_hash, audit?.event_hash);
  });

  it("recovers a crash between audit append and outbox completion", async () => {
    const input = mutation("d", {
      operationKind: "toggle",
      command: { fixtureId: FIXTURE_ID, enabled: false },
    });
    const pending = await outboxRepository.beginLocalScheduleMutation(input);
    await pilotRepository.appendAuditEvent({
      requestId: pending.operationId,
      actorId: pending.actorId,
      action: "fixture.schedule.disabled",
      targetType: "local_fixture_schedule",
      targetId: pending.scheduleId,
      customerId: pending.customerId,
      outcome: "allowed",
      metadata: {
        fixtureId: pending.fixtureId,
        connectionId: pending.connectionId,
        mutationSequence: pending.mutationSequence,
        operationKind: pending.operationKind,
        command: pending.command,
      },
    });
    assert.equal(await countAuditEvents(input.operationId), 1);

    const completed = await outboxRepository.completeLocalScheduleMutation({
      orgId: ORG_ID,
      operationId: input.operationId,
    });
    assert.equal(completed.status, "completed");
    assert.equal(await countAuditEvents(input.operationId), 1);
  });

  it("leaves work pending when an audit request id was reused with conflicting evidence", async () => {
    const input = mutation("e");
    await outboxRepository.beginLocalScheduleMutation(input);
    await pilotRepository.appendAuditEvent({
      requestId: input.operationId,
      actorId: ACTOR_ID,
      action: "fixture.schedule.disabled",
      targetType: "local_fixture_schedule",
      targetId: input.scheduleId,
      customerId: null,
      outcome: "allowed",
      metadata: { conflict: true },
    });

    await assert.rejects(
      outboxRepository.completeLocalScheduleMutation({
        orgId: ORG_ID,
        operationId: input.operationId,
      }),
      (error) => error?.code === "INVALID_STATE",
    );
    const pending = await outboxRepository.getLocalScheduleMutation(ORG_ID, input.operationId);
    assert.equal(pending?.status, "pending");
    assert.equal(await countAuditEvents(input.operationId), 1);
  });

  it("dead-letters a permanent failure once without poisoning later commands", async () => {
    const failedInput = mutation("1");
    const laterInput = mutation("2");
    await outboxRepository.beginLocalScheduleMutation(failedInput);
    await outboxRepository.beginLocalScheduleMutation(laterInput);

    const failed = await outboxRepository.failLocalScheduleMutation({
      orgId: ORG_ID,
      operationId: failedInput.operationId,
      failureCode: "COLLECTOR_COMMAND_REJECTED",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.failureCode, "COLLECTOR_COMMAND_REJECTED");
    assert.notEqual(failed.failedAt, null);
    assert.equal(failed.completedAt, null);
    assert.equal(await countAuditEvents(failedInput.operationId), 1);

    const replay = await outboxRepository.failLocalScheduleMutation({
      orgId: ORG_ID,
      operationId: failedInput.operationId,
      failureCode: "COLLECTOR_COMMAND_REJECTED",
    });
    assert.equal(replay.failedAt, failed.failedAt);
    assert.equal(await countAuditEvents(failedInput.operationId), 1);

    const beginReplay = await outboxRepository.beginLocalScheduleMutation(failedInput);
    assert.equal(beginReplay.status, "failed");
    assert.equal(beginReplay.failureCode, "COLLECTOR_COMMAND_REJECTED");
    const pending = await outboxRepository.listPendingLocalScheduleMutations({ orgId: ORG_ID });
    assert.deepEqual(pending.map((item) => item.operationId), [laterInput.operationId]);

    const audit = await database.prepare(
      `SELECT action, outcome, metadata_json FROM audit_events
        WHERE org_id = ? AND request_id = ? LIMIT 1`,
    ).bind(ORG_ID, failedInput.operationId).first();
    assert.equal(audit?.action, "fixture.schedule.failed");
    assert.equal(audit?.outcome, "failed");
    assert.equal(JSON.parse(audit?.metadata_json ?? "{}").failureCode, "COLLECTOR_COMMAND_REJECTED");

    await assert.rejects(
      outboxRepository.failLocalScheduleMutation({
        orgId: ORG_ID,
        operationId: failedInput.operationId,
        failureCode: "DIFFERENT_PERMANENT_FAILURE",
      }),
      (error) => error?.code === "CONFLICT",
    );
    await assert.rejects(
      outboxRepository.completeLocalScheduleMutation({
        orgId: ORG_ID,
        operationId: failedInput.operationId,
      }),
      (error) => error?.code === "INVALID_STATE",
    );
  });

  it("recovers a crash between failed audit append and terminal marking", async () => {
    const input = mutation("3", {
      operationKind: "toggle",
      command: { fixtureId: FIXTURE_ID, enabled: false },
    });
    const pending = await outboxRepository.beginLocalScheduleMutation(input);
    await pilotRepository.appendAuditEvent({
      requestId: pending.operationId,
      actorId: pending.actorId,
      action: "fixture.schedule.failed",
      targetType: "local_fixture_schedule",
      targetId: pending.scheduleId,
      customerId: pending.customerId,
      outcome: "failed",
      metadata: {
        fixtureId: pending.fixtureId,
        connectionId: pending.connectionId,
        mutationSequence: pending.mutationSequence,
        operationKind: pending.operationKind,
        command: pending.command,
        failureCode: "PERMANENT_SCOPE_MISMATCH",
      },
    });
    assert.equal((await outboxRepository.getLocalScheduleMutation(ORG_ID, input.operationId))?.status, "pending");

    const recovered = await outboxRepository.failLocalScheduleMutation({
      orgId: ORG_ID,
      operationId: input.operationId,
      failureCode: "PERMANENT_SCOPE_MISMATCH",
    });
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.failureCode, "PERMANENT_SCOPE_MISMATCH");
    assert.equal(await countAuditEvents(input.operationId), 1);
  });
});
