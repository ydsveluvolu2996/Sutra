import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
const entrypoint = await readFile(new URL("../docker/entrypoint.sh", import.meta.url), "utf8");

test("the long-running app never receives or invokes the PostgreSQL owner credential", () => {
  const migrateStart = compose.indexOf("  migrate:\n");
  const appStart = compose.indexOf("  app:\n");
  const volumesStart = compose.indexOf("\nvolumes:\n");
  assert.ok(migrateStart > 0 && appStart > migrateStart && volumesStart > appStart);

  const migrateService = compose.slice(migrateStart, appStart);
  const appService = compose.slice(appStart, volumesStart);
  assert.match(migrateService, /SUTRA_MIGRATOR_DATABASE_URL: postgresql:\/\/sutra_owner:/u);
  assert.match(migrateService, /entrypoint: \["pnpm", "db:postgres:migrate"\]/u);
  assert.doesNotMatch(appService, /SUTRA_MIGRATOR_DATABASE_URL|sutra_owner/u);
  assert.match(appService, /condition: service_completed_successfully/u);
  assert.doesNotMatch(entrypoint, /MIGRATOR|postgres:migrate|sutra_owner/u);
});
