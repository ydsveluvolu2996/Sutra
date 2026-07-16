import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  backupLocalState,
  resetLocalState,
  restoreLocalState,
} from "../scripts/local-data-utils.mjs";

const LOCAL_CONFIGURATION = [
  "SUTRA_CONNECTION_ENCRYPTION_KEY=connection-key-material-0000000000000000",
  "SUTRA_BROKER_SHARED_SECRET=broker-signing-material-000000000000000000",
  "SUTRA_REGISTRY_ENCRYPTION_KEY=registry-key-material-0000000000000000000",
  "SUTRA_AUTH_ENCRYPTION_KEY=auth-key-material-0000000000000000000000",
  "",
].join("\n");

test("local backup restores state only with the matching external key configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "sutra-backup-test-"));
  const stopped = async () => {};
  try {
    await mkdir(join(root, ".sutra"), { recursive: true });
    await mkdir(join(root, ".wrangler", "state", "v3", "d1", "object"), { recursive: true });
    await writeFile(join(root, ".dev.vars"), LOCAL_CONFIGURATION, "utf8");
    await writeFile(join(root, ".sutra", "collector-registry.enc"), "encrypted-registry", "utf8");
    await writeFile(join(root, ".sutra", "local-jobs.json"), '{"version":1,"jobs":{},"schedules":{}}', "utf8");
    await writeFile(join(root, ".wrangler", "state", "v3", "d1", "object", "state.sqlite"), "sqlite-state", "utf8");

    const backup = await backupLocalState({
      root,
      target: join(root, ".sutra", "backups", "test-backup"),
      now: new Date("2026-07-16T06:30:00.000Z"),
      assertStopped: stopped,
    });
    assert.equal(backup.manifest.schema, "sutra.local-backup.v1");
    assert.equal(backup.manifest.files.length, 3);
    await assert.rejects(readFile(join(backup.backupDirectory, "config", ".dev.vars"), "utf8"));

    await writeFile(join(root, ".sutra", "collector-registry.enc"), "corrupted", "utf8");
    await writeFile(join(root, ".sutra", "local-jobs.json"), "corrupted", "utf8");
    await writeFile(join(root, ".wrangler", "state", "v3", "d1", "object", "state.sqlite"), "changed", "utf8");

    await restoreLocalState({ root, backup: backup.backupDirectory, assertStopped: stopped });
    assert.equal(await readFile(join(root, ".dev.vars"), "utf8"), LOCAL_CONFIGURATION);
    assert.equal(await readFile(join(root, ".sutra", "collector-registry.enc"), "utf8"), "encrypted-registry");
    assert.equal(
      await readFile(join(root, ".sutra", "local-jobs.json"), "utf8"),
      '{"version":1,"jobs":{},"schedules":{}}',
    );
    assert.equal(
      await readFile(join(root, ".wrangler", "state", "v3", "d1", "object", "state.sqlite"), "utf8"),
      "sqlite-state",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local restore rejects a modified backup before replacing current state", async () => {
  const root = await mkdtemp(join(tmpdir(), "sutra-backup-test-"));
  const stopped = async () => {};
  try {
    await mkdir(join(root, ".wrangler", "state", "v3", "d1"), { recursive: true });
    await writeFile(join(root, ".dev.vars"), LOCAL_CONFIGURATION, "utf8");
    await writeFile(join(root, ".wrangler", "state", "v3", "d1", "state.sqlite"), "database", "utf8");
    const backup = await backupLocalState({
      root,
      target: join(root, ".sutra", "backups", "tamper-test"),
      assertStopped: stopped,
    });
    await writeFile(join(backup.backupDirectory, "d1", "state.sqlite"), "tampered", "utf8");

    await assert.rejects(
      restoreLocalState({ root, backup: backup.backupDirectory, assertStopped: stopped }),
      /integrity check failed/u,
    );
    assert.equal(await readFile(join(root, ".dev.vars"), "utf8"), LOCAL_CONFIGURATION);
    assert.equal(await readFile(join(root, ".wrangler", "state", "v3", "d1", "state.sqlite"), "utf8"), "database");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local reset clears D1, registry, schedules, and jobs while preserving keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "sutra-reset-test-"));
  let assertedAction = "";
  try {
    await mkdir(join(root, ".sutra"), { recursive: true });
    await mkdir(join(root, ".wrangler", "state", "v3", "d1"), { recursive: true });
    await writeFile(join(root, ".dev.vars"), LOCAL_CONFIGURATION, "utf8");
    await writeFile(join(root, ".sutra", "collector-registry.enc"), "registry", "utf8");
    await writeFile(join(root, ".sutra", "local-jobs.json"), "jobs", "utf8");
    await writeFile(join(root, ".sutra", "local-jobs.json.lock"), "lock", "utf8");
    await writeFile(join(root, ".wrangler", "state", "v3", "d1", "state.sqlite"), "db", "utf8");

    await resetLocalState({
      root,
      assertStopped: async (action) => { assertedAction = action; },
    });

    assert.equal(assertedAction, "resetting local state");
    assert.equal(await readFile(join(root, ".dev.vars"), "utf8"), LOCAL_CONFIGURATION);
    await assert.rejects(readFile(join(root, ".sutra", "collector-registry.enc"), "utf8"));
    await assert.rejects(readFile(join(root, ".sutra", "local-jobs.json"), "utf8"));
    await assert.rejects(readFile(join(root, ".sutra", "local-jobs.json.lock"), "utf8"));
    await assert.rejects(readFile(join(root, ".wrangler", "state", "v3", "d1", "state.sqlite"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
