import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Six permission-pack tests parse YAML by importing js-yaml through its pnpm
 * store path, which embeds the exact version:
 *
 *   ../node_modules/.pnpm/js-yaml@<version>/node_modules/js-yaml/index.js
 *
 * They do that because js-yaml is not a declared dependency -- it arrives
 * transitively through the eslint toolchain, so a bare `import "js-yaml"` does
 * not resolve. The cost is that the literal version is load-bearing: bumping
 * js-yaml deletes the directory those imports name, and every one of those files
 * dies at import with ERR_MODULE_NOT_FOUND before a single assertion runs.
 *
 * That is not hypothetical. Forcing the GHSA-5p4m-2wfm-xmqj floor from 4.3.0 to
 * 4.3.1 did exactly this, and it passed local verification only because the
 * developer's store still held the old directory alongside the new one. CI
 * installs clean, so four of six shards failed with whole-file errors that named
 * the permission packs rather than the dependency bump that caused them.
 *
 * This test makes the coupling explicit: the pinned literal must match the
 * version actually installed. A future bump then fails here, once, with a
 * message that says what to edit -- instead of failing opaquely in whichever
 * shards happen to hold those six files.
 */

const STORE = path.join(root, "node_modules/.pnpm");
const PINNED = /node_modules\/\.pnpm\/js-yaml@([0-9]+\.[0-9]+\.[0-9]+)\//gu;

async function installedJsYamlVersions() {
  const entries = await readdir(STORE, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("js-yaml@"))
    .map((entry) => entry.name.slice("js-yaml@".length))
    // Peer-suffixed directories (`pkg@1.0.0_peer@2.0.0`) never occur for
    // js-yaml today, but trimming keeps this from misreading one as a version.
    .map((name) => name.split("_")[0]);
}

async function filesPinningTheStorePath() {
  const names = await readdir(path.join(root, "tests"));
  const found = [];
  for (const name of names) {
    if (!name.endsWith(".mjs") && !name.endsWith(".ts")) continue;
    const file = path.join(root, "tests", name);
    const source = await readFile(file, "utf8");
    const versions = [...source.matchAll(PINNED)].map(([, version]) => version);
    if (versions.length > 0) found.push({ name, versions });
  }
  return found;
}

test("every hard-coded js-yaml store path names a version that is installed", async () => {
  const installed = await installedJsYamlVersions();
  assert.ok(installed.length > 0, "js-yaml must be resolvable in the pnpm store");

  for (const { name, versions } of await filesPinningTheStorePath()) {
    for (const version of versions) {
      assert.ok(
        installed.includes(version),
        `tests/${name} imports js-yaml@${version} from the pnpm store, but the installed `
        + `version${installed.length > 1 ? "s are" : " is"} ${installed.join(", ")}. `
        + "A js-yaml bump must update these literals in the same commit, or the file "
        + "fails at import before any assertion runs.",
      );
    }
  }
});

test("the hard-coded js-yaml store paths do not drift apart from each other", async () => {
  // One file left behind on an old version is the same outage as all of them,
  // and is easier to miss in review than a single consistent bump.
  const pinned = await filesPinningTheStorePath();
  assert.ok(pinned.length > 0, "the store-path import pattern must still be findable");

  const distinct = new Set(pinned.flatMap((entry) => entry.versions));
  assert.equal(
    distinct.size,
    1,
    `all js-yaml store-path imports must name one version; found ${[...distinct].join(", ")} across `
    + pinned.map((entry) => entry.name).join(", "),
  );
});
