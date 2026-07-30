import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const dispatch = await readFile(resolve(root, "app/api/v1/itsm/dispatch/route.ts"), "utf8");
const inbound = await readFile(
  resolve(root, "app/api/v1/itsm/inbound/[connectorId]/route.ts"),
  "utf8",
);
const handlers = await readFile(resolve(root, "db/background-job-handlers.ts"), "utf8");
const repository = await readFile(resolve(root, "db/itsm-connector-repository.ts"), "utf8");

test("outbound, inbound, and durable retry resolve through the managed-aware repository", () => {
  assert.match(dispatch, /getForDispatch\(scope, record\.connectorId\)/u);
  assert.match(inbound, /getForInbound\(connectorId\)/u);
  assert.match(
    handlers,
    /"itsm-dispatch": runItsmDispatch/u,
  );
  assert.match(
    handlers,
    /new ItsmConnectorRepository\(\)\.getForDispatch\([\s\S]*payload\.connectorId/u,
  );
  for (const runtimePath of [dispatch, inbound, handlers]) {
    assert.doesNotMatch(runtimePath, /SELECT[\s\S]{0,100}shared_secret/iu);
    assert.doesNotMatch(runtimePath, /process\.env\.[A-Z0-9_]*ITSM[^;\n]*SECRET/iu);
  }
});

test("managed rows cannot fall back to the legacy database credential", () => {
  assert.match(repository, /row\.secret_storage === "local"/u);
  assert.match(repository, /this\.managedSecretStore !== null \|\| row\.shared_secret\.length < 16/u);
  assert.match(repository, /managedSecretStore\.read\(/u);
  assert.match(repository, /throw new ItsmConnectorRepositoryError\("SECRET_UNAVAILABLE"\)/u);
});

test("managed replacement and delete commit metadata before bounded secret cleanup", () => {
  assert.match(repository, /ITSM_SECRET_CLEANUP_JOB_KIND = "itsm-secret-cleanup"/u);
  assert.match(repository, /ITSM_SECRET_CLEANUP_MAX_ATTEMPTS = 10/u);
  assert.match(
    repository,
    /const outcomes = await db\.batch\(\[\s*update,\s*this\.cleanupJobInsertAfterConnectorVersionRemoved/u,
  );
  assert.match(
    repository,
    /const outcomes = await db\.batch\(\[\s*db\.prepare\(\s*`DELETE FROM itsm_connectors[\s\S]*this\.cleanupJobInsertAfterConnectorVersionRemoved/u,
  );
  assert.match(
    handlers,
    /\[ITSM_SECRET_CLEANUP_JOB_KIND\]: runItsmSecretCleanupJob/u,
  );
  assert.match(
    repository,
    /SELECT id FROM itsm_connectors[\s\S]*secret_reference = \?[\s\S]*if \(stillLive !== null\)/u,
  );
  assert.doesNotMatch(repository, /\.delete\([^;]*\)\.catch\(\(\) => undefined\)/u);
});
