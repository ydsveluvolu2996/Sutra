import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("morning start is fast, health-gated, and preserves local data", async () => {
  const [source, packageDocument] = await Promise.all([
    readFile(new URL("scripts/morning-start.mjs", root), "utf8"),
    readFile(new URL("package.json", root), "utf8").then(JSON.parse),
  ]);

  assert.equal(packageDocument.scripts["morning:start"], "node scripts/morning-start.mjs");
  assert.equal(
    packageDocument.scripts["morning:rebuild"],
    "node scripts/morning-start.mjs --rebuild",
  );
  assert.equal(packageDocument.scripts["morning:stop"], "node scripts/docker-local.mjs down");
  assert.match(source, /docker", \["info"/u);
  assert.match(source, /sutra-local-app:latest/u);
  assert.match(source, /"--no-build"/u);
  assert.match(source, /"--build"/u);
  assert.match(source, /\/api\/healthz/u);
  assert.match(source, /ensureDockerLocalEnvironment/u);
  assert.doesNotMatch(source, /\baws\b|volume", "rm"|--volumes|down", "--volumes"/u);
});
