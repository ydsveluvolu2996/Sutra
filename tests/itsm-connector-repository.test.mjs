import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { ItsmConnectorRepository, ItsmConnectorRepositoryError } = await import("../db/itsm-connector-repository.ts");

const ORG_A = "org_itsm_a";
const ORG_B = "org_itsm_b";
const CUSTOMER_A = "cust_itsm_a";
const CUSTOMER_B = "cust_itsm_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-itsm-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'itsm-a', 'ITSM A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'itsm-b', 'ITSM B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'itsm-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'itsm-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new ItsmConnectorRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

test("0030 migration stores connectors without ever listing the shared secret", async () => {
  await withDatabase(async (repository) => {
    const secret = "correct-horse-battery-staple";
    const saved = await repository.save(SCOPE_A, {
      name: "acme-jira", connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues", projectKey: "SEC", sharedSecret: secret,
    }, "user_a", Date.parse("2026-07-19T12:00:00Z"));
    assert.match(saved.id, /^itc_[a-f0-9]{32}$/u);
    assert.equal(saved.secretPreview, "local");
    assert.equal(saved.secretStorage, "local");
    const listed = await repository.list(SCOPE_A);
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes(secret), false);
    assert.deepEqual(await repository.list({ orgId: ORG_B, customerId: CUSTOMER_B }), []);
    assert.equal((await repository.getForInbound(saved.id))?.sharedSecret, secret);
    assert.equal(await repository.getForDispatch({ orgId: ORG_B, customerId: CUSTOMER_B }, saved.id), null);
    assert.equal(await repository.delete({ orgId: ORG_B, customerId: CUSTOMER_B }, saved.id), false);
    assert.equal(await repository.delete(SCOPE_A, saved.id), true);
  });
});

test("bidirectional readiness evidence is connector-scoped, durable, and invalidated by a later update", async () => {
  await withDatabase(async (repository) => {
    const savedAt = Date.parse("2026-07-30T10:00:00.000Z");
    const saved = await repository.save(SCOPE_A, {
      name: "evidence-jira",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: "SEC",
      sharedSecret: "first-evidence-secret-value",
    }, "user_a", savedAt);
    assert.equal(saved.lastOutboundSuccessAt, null);
    assert.equal(saved.lastAuthenticatedInboundAt, null);

    assert.equal(
      await repository.recordOutboundSuccess(
        { orgId: ORG_B, customerId: CUSTOMER_B },
        saved.id,
        saved.updatedAt,
        savedAt + 1,
      ),
      false,
    );
    assert.equal(await repository.recordOutboundSuccess(SCOPE_A, saved.id, saved.updatedAt, savedAt), true);
    assert.equal(
      await repository.recordAuthenticatedInboundSuccess(
        SCOPE_A,
        saved.id,
        saved.updatedAt,
        savedAt + 2,
      ),
      true,
    );
    const verified = (await repository.list(SCOPE_A))[0];
    assert.ok(Date.parse(verified.lastOutboundSuccessAt) > Date.parse(verified.updatedAt));
    assert.ok(Date.parse(verified.lastAuthenticatedInboundAt) > Date.parse(verified.updatedAt));

    const updatedAt = savedAt + 10_000;
    const updated = await repository.save(SCOPE_A, {
      name: "evidence-jira",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/v2/issues",
      projectKey: "SEC",
      sharedSecret: "rotated-evidence-secret-value",
    }, "user_a", updatedAt);
    assert.ok(Date.parse(updated.lastOutboundSuccessAt) < Date.parse(updated.updatedAt));
    assert.ok(Date.parse(updated.lastAuthenticatedInboundAt) < Date.parse(updated.updatedAt));

    assert.equal(
      await repository.recordOutboundSuccess(SCOPE_A, saved.id, updated.updatedAt, updatedAt + 1),
      true,
    );
    const oneDirection = (await repository.list(SCOPE_A))[0];
    assert.ok(Date.parse(oneDirection.lastOutboundSuccessAt) > Date.parse(oneDirection.updatedAt));
    assert.ok(Date.parse(oneDirection.lastAuthenticatedInboundAt) < Date.parse(oneDirection.updatedAt));
    assert.equal(
      await repository.recordAuthenticatedInboundSuccess(
        SCOPE_A,
        saved.id,
        updated.updatedAt,
        updatedAt + 2,
      ),
      true,
    );
    const reverified = (await repository.list(SCOPE_A))[0];
    assert.ok(Date.parse(reverified.lastOutboundSuccessAt) > Date.parse(reverified.updatedAt));
    assert.ok(Date.parse(reverified.lastAuthenticatedInboundAt) > Date.parse(reverified.updatedAt));
  });
});

test("a rotation between connector load and evidence record rejects both stale directions", async () => {
  await withDatabase(async (repository) => {
    const first = await repository.save(SCOPE_A, {
      name: "rotation-race-jira",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: "SEC",
      sharedSecret: "first-rotation-race-secret",
    }, "user_a", Date.parse("2026-07-30T10:00:00.000Z"));

    const rotated = await repository.save(SCOPE_A, {
      name: "rotation-race-jira",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: "SEC",
      sharedSecret: "second-rotation-race-secret",
    }, "user_a", Date.parse("2026-07-30T10:01:00.000Z"));

    assert.equal(
      await repository.recordOutboundSuccess(
        SCOPE_A,
        first.id,
        first.updatedAt,
        Date.parse("2026-07-30T10:02:00.000Z"),
      ),
      false,
    );
    assert.equal(
      await repository.recordAuthenticatedInboundSuccess(
        SCOPE_A,
        first.id,
        first.updatedAt,
        Date.parse("2026-07-30T10:02:01.000Z"),
      ),
      false,
    );
    const current = (await repository.list(SCOPE_A))[0];
    assert.equal(current.updatedAt, rotated.updatedAt);
    assert.equal(current.lastOutboundSuccessAt, null);
    assert.equal(current.lastAuthenticatedInboundAt, null);
  });
});

test("managed mode never persists or returns connector plaintext", async () => {
  await withDatabase(async (_localRepository, database) => {
    const storedSecrets = new Map();
    const calls = [];
    const managedSecretStore = {
      storageKind: "managed",
      async write(scope, connectorId, sharedSecret) {
        calls.push({ operation: "write", scope, connectorId });
        storedSecrets.set(connectorId, { scope, sharedSecret });
        return `secret://itsm/${connectorId}`;
      },
      async read(scope, connectorId, reference) {
        calls.push({ operation: "read", scope, connectorId, reference });
        const stored = storedSecrets.get(connectorId);
        return stored?.scope.orgId === scope.orgId &&
          stored?.scope.customerId === scope.customerId
          ? stored.sharedSecret
          : null;
      },
      async delete(scope, connectorId, reference) {
        calls.push({ operation: "delete", scope, connectorId, reference });
        const stored = storedSecrets.get(connectorId);
        if (
          stored?.scope.orgId !== scope.orgId ||
          stored?.scope.customerId !== scope.customerId
        ) throw new Error("scope-mismatch");
        storedSecrets.delete(connectorId);
      },
    };
    const repository = new ItsmConnectorRepository(database, { managedSecretStore });
    const sharedSecret = "managed-correct-horse-battery-staple";
    const saved = await repository.save(SCOPE_A, {
      name: "managed-jira",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: "SEC",
      sharedSecret,
    }, "user_a");
    assert.equal(saved.secretPreview, "managed");
    assert.equal(saved.secretStorage, "managed");

    const raw = await database.prepare(
      `SELECT shared_secret, secret_storage, secret_reference, secret_preview
         FROM itsm_connectors WHERE id = ?`,
    ).bind(saved.id).first();
    assert.deepEqual(raw, {
      shared_secret: "",
      secret_storage: "managed",
      secret_reference: `secret://itsm/${saved.id}`,
      secret_preview: "managed",
    });
    assert.equal(JSON.stringify(await repository.list(SCOPE_A)).includes(sharedSecret), false);
    assert.equal((await repository.getForDispatch(SCOPE_A, saved.id))?.sharedSecret, sharedSecret);
    assert.equal((await repository.getForInbound(saved.id))?.sharedSecret, sharedSecret);
    assert.equal(await repository.getForDispatch({ orgId: ORG_B, customerId: CUSTOMER_B }, saved.id), null);
    await assert.rejects(
      repository.cleanupDeletedManagedSecret(
        SCOPE_A,
        saved.id,
        `secret://itsm/${saved.id}`,
      ),
      (error) =>
        error instanceof ItsmConnectorRepositoryError &&
        error.code === "PERSISTENCE_FAILED",
    );
    assert.equal(storedSecrets.has(saved.id), true, "cleanup cannot delete a live reference");
    assert.equal(await repository.delete({ orgId: ORG_B, customerId: CUSTOMER_B }, saved.id), false);
    assert.equal(await repository.delete(SCOPE_A, saved.id), true);
    assert.deepEqual(calls.map((call) => call.operation), ["write", "read", "read"]);
    assert.equal(await repository.getForDispatch(SCOPE_A, saved.id), null);
    const cleanupJobs = await database.prepare(
      `SELECT customer_id, payload_json, max_attempts
         FROM background_jobs WHERE kind = 'itsm-secret-cleanup'`,
    ).all();
    assert.equal(cleanupJobs.results.length, 1);
    assert.equal(cleanupJobs.results[0].customer_id, CUSTOMER_A);
    assert.equal(cleanupJobs.results[0].max_attempts, 10);
    assert.deepEqual(JSON.parse(cleanupJobs.results[0].payload_json), {
      connectorId: saved.id,
      secretReference: `secret://itsm/${saved.id}`,
    });
    assert.equal(storedSecrets.has(saved.id), true, "remote cleanup runs only after DB deletion commits");
    await repository.cleanupDeletedManagedSecret(
      SCOPE_A,
      saved.id,
      `secret://itsm/${saved.id}`,
    );
    assert.equal(storedSecrets.has(saved.id), false);
    assert.equal(calls.at(-1)?.operation, "delete");
  });
});

test("a failed managed connector delete leaves its row and exact secret usable", async () => {
  await withDatabase(async (_localRepository, database) => {
    const secrets = new Map();
    const deleted = [];
    const managedSecretStore = {
      storageKind: "managed",
      async write(scope, connectorId, sharedSecret) {
        const reference = `secret://itsm/${connectorId}/versions/00000000-0000-4000-8000-000000000001`;
        secrets.set(reference, { scope, connectorId, sharedSecret });
        return reference;
      },
      async read(scope, connectorId, reference) {
        const stored = secrets.get(reference);
        return stored?.scope.orgId === scope.orgId &&
          stored?.scope.customerId === scope.customerId &&
          stored?.connectorId === connectorId
          ? stored.sharedSecret
          : null;
      },
      async delete(_scope, _connectorId, reference) {
        deleted.push(reference);
        secrets.delete(reference);
      },
    };
    const repository = new ItsmConnectorRepository(database, { managedSecretStore });
    const sharedSecret = "managed-delete-must-remain-usable";
    const saved = await repository.save(SCOPE_A, {
      name: "managed-delete-failure",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: null,
      sharedSecret,
    }, "user_a");
    await database.prepare(
      `CREATE TRIGGER itsm_test_delete_failure
         BEFORE DELETE ON itsm_connectors
         BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END`,
    ).run();

    await assert.rejects(
      repository.delete(SCOPE_A, saved.id),
      /forced delete failure/u,
    );

    assert.equal(
      (await repository.getForDispatch(SCOPE_A, saved.id))?.sharedSecret,
      sharedSecret,
    );
    assert.equal(secrets.size, 1);
    assert.deepEqual(deleted, []);
    const cleanupDebt = await database.prepare(
      `SELECT COUNT(*) AS count FROM background_jobs
        WHERE kind = 'itsm-secret-cleanup'`,
    ).first();
    assert.equal(Number(cleanupDebt?.count), 0, "failed DB transaction cannot expose cleanup debt");
  });
});

test("managed mode fails closed for legacy local rows and missing secret material", async () => {
  await withDatabase(async (localRepository, database) => {
    const saved = await localRepository.save(SCOPE_A, {
      name: "legacy-jira",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: null,
      sharedSecret: "legacy-local-secret-value",
    }, "user_a");
    const managedSecretStore = {
      storageKind: "managed",
      async write(_scope, connectorId) { return `secret://itsm/${connectorId}`; },
      async read() { return null; },
      async delete() {},
    };
    const managedRepository = new ItsmConnectorRepository(database, { managedSecretStore });
    await assert.rejects(
      managedRepository.getForDispatch(SCOPE_A, saved.id),
      (error) => error instanceof ItsmConnectorRepositoryError && error.code === "SECRET_UNAVAILABLE",
    );
    const scrubbed = await database.prepare(
      `SELECT shared_secret, enabled FROM itsm_connectors WHERE id = ?`,
    ).bind(saved.id).first();
    assert.deepEqual(scrubbed, { shared_secret: "", enabled: 0 });
  });
});

test("managed rows fail closed when the resolver is unavailable", async () => {
  await withDatabase(async (_localRepository, database) => {
    const managedSecretStore = {
      storageKind: "managed",
      async write(_scope, connectorId) { return `secret://itsm/${connectorId}`; },
      async read() { return "managed-secret-value"; },
      async delete() {},
    };
    const managedRepository = new ItsmConnectorRepository(database, { managedSecretStore });
    const saved = await managedRepository.save(SCOPE_A, {
      name: "managed-no-resolver",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: null,
      sharedSecret: "managed-secret-value",
    }, "user_a");
    const unavailableRepository = new ItsmConnectorRepository(database, {
      managedSecretStore: null,
    });
    await assert.rejects(
      unavailableRepository.getForDispatch(SCOPE_A, saved.id),
      (error) => error instanceof ItsmConnectorRepositoryError && error.code === "SECRET_UNAVAILABLE",
    );
  });
});

test("database failures clean up a new managed secret and never persist plaintext", async () => {
  await withDatabase(async (_localRepository, database) => {
    const secrets = new Map();
    const deleted = [];
    const managedSecretStore = {
      storageKind: "managed",
      async write(scope, connectorId, sharedSecret) {
        secrets.set(connectorId, { scope, sharedSecret });
        return `secret://itsm/${connectorId}`;
      },
      async read(scope, connectorId) {
        const stored = secrets.get(connectorId);
        return stored?.scope.orgId === scope.orgId &&
          stored?.scope.customerId === scope.customerId
          ? stored.sharedSecret
          : null;
      },
      async delete(_scope, connectorId) {
        deleted.push(connectorId);
        secrets.delete(connectorId);
      },
    };
    await database.prepare(
      `CREATE TRIGGER itsm_test_insert_failure
         BEFORE INSERT ON itsm_connectors
         BEGIN SELECT RAISE(ABORT, 'forced database failure'); END`,
    ).run();
    const repository = new ItsmConnectorRepository(database, { managedSecretStore });
    const plaintext = "must-never-reach-the-database";
    await assert.rejects(
      repository.save(SCOPE_A, {
        name: "db-failure",
        connectorType: "jira",
        baseUrl: "https://jira.example.test/api/issues",
        projectKey: null,
        sharedSecret: plaintext,
      }, "user_a"),
      /forced database failure/u,
    );
    assert.equal(deleted.length, 1);
    assert.equal(secrets.size, 0);
    const persisted = await database.prepare(
      `SELECT COUNT(*) AS count FROM itsm_connectors WHERE org_id = ? AND name = ?`,
    ).bind(ORG_A, "db-failure").first();
    assert.equal(Number(persisted?.count), 0);
  });
});

test("failed staged-secret cleanup is persisted as bounded durable retry debt", async () => {
  await withDatabase(async (_localRepository, database) => {
    const secrets = new Map();
    let deleteAttempts = 0;
    const managedSecretStore = {
      storageKind: "managed",
      async write(scope, connectorId, sharedSecret) {
        const reference = `secret://itsm/${connectorId}/versions/00000000-0000-4000-8000-000000000001`;
        secrets.set(reference, { scope, connectorId, sharedSecret });
        return reference;
      },
      async read(scope, connectorId, reference) {
        const stored = secrets.get(reference);
        return stored?.scope.orgId === scope.orgId &&
          stored?.scope.customerId === scope.customerId &&
          stored?.connectorId === connectorId
          ? stored.sharedSecret
          : null;
      },
      async delete(_scope, _connectorId, reference) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("secrets-manager-temporarily-unavailable");
        secrets.delete(reference);
      },
    };
    await database.prepare(
      `CREATE TRIGGER itsm_test_staged_insert_failure
         BEFORE INSERT ON itsm_connectors
         BEGIN SELECT RAISE(ABORT, 'forced metadata failure'); END`,
    ).run();
    const repository = new ItsmConnectorRepository(database, { managedSecretStore });
    await assert.rejects(
      repository.save(SCOPE_A, {
        name: "staged-cleanup-debt",
        connectorType: "jira",
        baseUrl: "https://jira.example.test/api/issues",
        projectKey: null,
        sharedSecret: "staged-secret-needing-retry",
      }, "user_a"),
      /forced metadata failure/u,
    );

    const jobs = await database.prepare(
      `SELECT payload_json, status, attempt, max_attempts
         FROM background_jobs WHERE kind = 'itsm-secret-cleanup'`,
    ).all();
    assert.equal(jobs.results.length, 1);
    assert.equal(jobs.results[0].status, "queued");
    assert.equal(jobs.results[0].attempt, 0);
    assert.equal(jobs.results[0].max_attempts, 10);
    const payload = JSON.parse(jobs.results[0].payload_json);
    assert.match(payload.connectorId, /^itc_[a-f0-9]{32}$/u);
    assert.equal(
      payload.secretReference,
      `secret://itsm/${payload.connectorId}/versions/00000000-0000-4000-8000-000000000001`,
    );
    assert.equal(secrets.has(payload.secretReference), true);
    await repository.cleanupDeletedManagedSecret(
      SCOPE_A,
      payload.connectorId,
      payload.secretReference,
    );
    assert.equal(deleteAttempts, 2);
    assert.equal(secrets.size, 0);
  });
});

test("a failed metadata update leaves the managed reference usable and database plaintext empty", async () => {
  await withDatabase(async (_localRepository, database) => {
    const secrets = new Map();
    let version = 0;
    const managedSecretStore = {
      storageKind: "managed",
      async write(scope, connectorId, sharedSecret) {
        version += 1;
        const reference = `secret://itsm/${connectorId}/versions/00000000-0000-4000-8000-${String(version).padStart(12, "0")}`;
        secrets.set(reference, { scope, connectorId, sharedSecret });
        return reference;
      },
      async read(scope, connectorId, reference) {
        const stored = secrets.get(reference);
        return stored?.scope.orgId === scope.orgId &&
          stored?.scope.customerId === scope.customerId &&
          stored?.connectorId === connectorId
          ? stored.sharedSecret
          : null;
      },
      async delete(_scope, _connectorId, reference) { secrets.delete(reference); },
    };
    const repository = new ItsmConnectorRepository(database, { managedSecretStore });
    const saved = await repository.save(SCOPE_A, {
      name: "managed-update",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: null,
      sharedSecret: "first-managed-secret-value",
    }, "user_a");
    await database.prepare(
      `CREATE TRIGGER itsm_test_update_failure
         BEFORE UPDATE ON itsm_connectors
         BEGIN SELECT RAISE(ABORT, 'forced update failure'); END`,
    ).run();
    await assert.rejects(
      repository.save(SCOPE_A, {
        name: "managed-update",
        connectorType: "jira",
        baseUrl: "https://jira.example.test/api/v2/issues",
        projectKey: null,
        sharedSecret: "rotated-managed-secret-value",
      }, "user_a"),
      /forced update failure/u,
    );
    const raw = await database.prepare(
      `SELECT shared_secret, secret_storage, secret_reference, base_url
         FROM itsm_connectors WHERE id = ?`,
    ).bind(saved.id).first();
    assert.equal(raw?.shared_secret, "");
    assert.equal(raw?.secret_storage, "managed");
    assert.equal(raw?.secret_reference, saved.secretStorage === "managed"
      ? `secret://itsm/${saved.id}/versions/00000000-0000-4000-8000-000000000001`
      : null);
    assert.equal(raw?.base_url, "https://jira.example.test/api/issues");
    assert.equal(
      (await repository.getForDispatch(SCOPE_A, saved.id))?.sharedSecret,
      "first-managed-secret-value",
    );
    assert.equal(secrets.size, 1, "the failed staged version is cleaned up");
  });
});

test("concurrent managed rotations compare-and-swap one winner and clean every unused version", async () => {
  await withDatabase(async (_localRepository, database) => {
    const secrets = new Map();
    let version = 0;
    let rotationWrites = 0;
    let releaseRotations;
    const rotationsReady = new Promise((resolve) => { releaseRotations = resolve; });
    const managedSecretStore = {
      storageKind: "managed",
      async write(scope, connectorId, sharedSecret) {
        version += 1;
        const reference = `secret://itsm/${connectorId}/versions/00000000-0000-4000-8000-${String(version).padStart(12, "0")}`;
        secrets.set(reference, { scope, connectorId, sharedSecret });
        if (version > 1) {
          rotationWrites += 1;
          if (rotationWrites === 2) releaseRotations();
          await rotationsReady;
        }
        return reference;
      },
      async read(scope, connectorId, reference) {
        const stored = secrets.get(reference);
        return stored?.scope.orgId === scope.orgId &&
          stored?.scope.customerId === scope.customerId &&
          stored?.connectorId === connectorId
          ? stored.sharedSecret
          : null;
      },
      async delete(_scope, _connectorId, reference) {
        secrets.delete(reference);
      },
    };
    const repository = new ItsmConnectorRepository(database, { managedSecretStore });
    const initial = await repository.save(SCOPE_A, {
      name: "managed-concurrent-rotation",
      connectorType: "jira",
      baseUrl: "https://jira.example.test/api/issues",
      projectKey: null,
      sharedSecret: "initial-concurrent-secret-value",
    }, "user_a", Date.parse("2026-07-30T11:00:00.000Z"));

    const rotations = await Promise.allSettled([
      repository.save(SCOPE_A, {
        name: "managed-concurrent-rotation",
        connectorType: "jira",
        baseUrl: "https://jira.example.test/api/issues-a",
        projectKey: null,
        sharedSecret: "concurrent-secret-value-a",
      }, "user_a", Date.parse("2026-07-30T11:01:00.000Z")),
      repository.save(SCOPE_A, {
        name: "managed-concurrent-rotation",
        connectorType: "jira",
        baseUrl: "https://jira.example.test/api/issues-b",
        projectKey: null,
        sharedSecret: "concurrent-secret-value-b",
      }, "user_a", Date.parse("2026-07-30T11:01:00.000Z")),
    ]);
    assert.equal(rotations.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = rotations.find((result) => result.status === "rejected");
    assert.ok(
      rejected?.status === "rejected" &&
      rejected.reason instanceof ItsmConnectorRepositoryError &&
      rejected.reason.code === "PERSISTENCE_FAILED",
    );
    const current = await repository.getForDispatch(SCOPE_A, initial.id);
    assert.ok(
      current?.sharedSecret === "concurrent-secret-value-a" ||
      current?.sharedSecret === "concurrent-secret-value-b",
    );
    assert.equal(secrets.size, 2, "the winner and old version remain until durable cleanup runs");
    const cleanupJobs = await database.prepare(
      `SELECT payload_json, max_attempts FROM background_jobs
        WHERE kind = 'itsm-secret-cleanup'`,
    ).all();
    assert.ok(cleanupJobs.results.length >= 1);
    for (const row of cleanupJobs.results) {
      assert.equal(row.max_attempts, 10);
      const payload = JSON.parse(row.payload_json);
      assert.equal(payload.connectorId, initial.id);
      assert.equal(
        payload.secretReference,
        `secret://itsm/${initial.id}/versions/00000000-0000-4000-8000-000000000001`,
      );
      await repository.cleanupDeletedManagedSecret(
        SCOPE_A,
        payload.connectorId,
        payload.secretReference,
      );
    }
    assert.equal(secrets.size, 1, "durable cleanup deletes only the replaced version");
    assert.equal(
      (await repository.getForDispatch(SCOPE_A, initial.id))?.sharedSecret,
      current?.sharedSecret,
    );
  });
});

test("connector writes reject invalid endpoints and cross-org customer theft", async () => {
  await withDatabase(async (repository) => {
    await assert.rejects(
      repository.save(SCOPE_A, {
        name: "bad-http", connectorType: "jira", baseUrl: "http://jira.example.test",
        projectKey: null, sharedSecret: "sixteen-characters-minimum",
      }, "user_a"),
      (error) => error instanceof ItsmConnectorRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      repository.save({ orgId: ORG_B, customerId: CUSTOMER_A }, {
        name: "stolen", connectorType: "servicenow", baseUrl: "https://snow.example.test/api",
        projectKey: null, sharedSecret: "sixteen-characters-minimum",
      }, "user_b"),
      (error) => error instanceof ItsmConnectorRepositoryError && error.code === "SCOPE_NOT_FOUND",
    );
  });
});

test("SSRF base URLs (metadata, loopback, private, internal) are rejected at store time", async () => {
  await withDatabase(async (repository) => {
    const blocked = [
      "https://169.254.169.254/latest/meta-data/", // cloud metadata
      "https://127.0.0.1/hook",                     // loopback
      "https://10.1.2.3/hook",                      // private
      "https://192.168.0.1/hook",                   // private
      "https://[::1]/hook",                         // IPv6 loopback
      "https://itsm.internal/hook",                 // internal hostname
      "https://localhost/hook",                     // localhost
    ];
    for (const baseUrl of blocked) {
      await assert.rejects(
        repository.save(SCOPE_A, {
          name: "ssrf-attempt", connectorType: "jira", baseUrl,
          projectKey: null, sharedSecret: "sixteen-characters-minimum",
        }, "user_a"),
        (error) => error instanceof ItsmConnectorRepositoryError && error.code === "INVALID_INPUT",
        `expected reject: ${baseUrl}`,
      );
    }
    // A legitimate public HTTPS endpoint still stores.
    const saved = await repository.save(SCOPE_A, {
      name: "public-hook", connectorType: "jira", baseUrl: "https://hooks.example.com/itsm",
      projectKey: null, sharedSecret: "sixteen-characters-minimum",
    }, "user_a");
    assert.match(saved.baseUrl, /^https:\/\/hooks\.example\.com\/itsm/u);
  });
});
