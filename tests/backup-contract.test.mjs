import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("backup wrapper reuses the migrator environment and emits restore guidance", async () => {
  const source = await readFile(new URL("../scripts/backup.mjs", import.meta.url), "utf8");
  assert.match(source, /SUTRA_MIGRATOR_DATABASE_URL \?\? process\.env\.DATABASE_URL/u);
  assert.match(source, /spawn\("pg_dump"/u);
  assert.match(source, /--format=custom/u);
  assert.match(source, /pg_restore --clean --if-exists/u);
  assert.doesNotMatch(source, /postgres(?:ql)?:\/\/[^"'`]*:[^@"'`]*@/u, "credentials must not be embedded");
});
