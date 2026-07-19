import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
const entrypoint = await readFile(new URL("../docker/entrypoint.sh", import.meta.url), "utf8");
const rootDockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const notificationWorkerDockerfile = await readFile(
  new URL("../services/notification-worker/Dockerfile", import.meta.url),
  "utf8",
);
const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the long-running app never receives or invokes the PostgreSQL owner credential", () => {
  const migrateStart = compose.indexOf("  migrate:\n");
  const appStart = compose.indexOf("  app:\n");
  const volumesStart = compose.indexOf("\nvolumes:\n");
  assert.ok(migrateStart > 0 && appStart > migrateStart && volumesStart > appStart);

  const migrateService = compose.slice(migrateStart, appStart);
  const appService = compose.slice(appStart, volumesStart);
  assert.match(migrateService, /SUTRA_MIGRATOR_DATABASE_URL: postgresql:\/\/sutra_owner:/u);
  assert.match(migrateService, /entrypoint: \["node", "scripts\/postgres-migrate\.mjs"\]/u);
  assert.doesNotMatch(appService, /SUTRA_MIGRATOR_DATABASE_URL|sutra_owner/u);
  assert.match(appService, /condition: service_completed_successfully/u);
  assert.doesNotMatch(entrypoint, /MIGRATOR|postgres:migrate|sutra_owner/u);
  assert.doesNotMatch(entrypoint, /\bpnpm\b/u);
});

test("PostgreSQL verification cannot restart or reuse the live demo Compose project", () => {
  const source = readFile(new URL("../scripts/test-postgres.mjs", import.meta.url), "utf8");
  return source.then((contents) => {
    assert.match(contents, /const POSTGRES_TEST_PROJECT = "sutra-postgres-test";/u);
    assert.match(contents, /"--project-name",\s*POSTGRES_TEST_PROJECT/u);
    assert.match(contents, /"down",\s*"--volumes",\s*"--remove-orphans"/u);
  });
});

test("Docker builders use the repository package-manager version", () => {
  for (const dockerfile of [rootDockerfile, notificationWorkerDockerfile]) {
    const match = dockerfile.match(/corepack prepare (pnpm@\d+\.\d+\.\d+) --activate/u);
    assert.ok(match, "Dockerfile must pin pnpm through Corepack");
    assert.equal(match[1], packageManifest.packageManager);
  }
});
