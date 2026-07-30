import assert from "node:assert/strict";
import test from "node:test";

import {
  assetsOptionFrom,
  d1BindingsFrom,
  orderModuleFiles,
  parseArgs,
  parseEnvFile,
  resolvePort,
} from "../scripts/worker-serve-config.mjs";

/**
 * These pin the derivation behind the production runtime. Production no longer
 * serves through `wrangler dev` — that dev harness escalated request-scoped faults
 * to fatal process exits — so scripts/serve-worker.mjs starts miniflare directly.
 * Everything it passes is derived from the built wrangler.json, and the two
 * derivations that are easy to get silently wrong (module ordering and
 * has_user_worker) are the reason this file exists.
 */

/**
 * The asset router runs ahead of the Worker and only falls through on a miss if it
 * knows a Worker exists. With has_user_worker false, every route 404s at the router
 * while static files still serve — the app looks half-alive rather than broken,
 * which is the worst way for this to fail. Wrangler derives it from `main`.
 */
test("has_user_worker follows the presence of a worker entry", () => {
  const withEntry = assetsOptionFrom(
    { main: "index.js", assets: { directory: "../client" } },
    (directory: string) => `/abs/${directory}`,
  );
  assert.equal(withEntry?.routerConfig.has_user_worker, true);
  assert.equal(withEntry?.directory, "/abs/../client");

  const withoutEntry = assetsOptionFrom({ assets: { directory: "../client" } }, (d: string) => d);
  assert.equal(withoutEntry?.routerConfig.has_user_worker, false);
});

/** No binding is set, matching the build config — static files bypass the entry's headers. */
test("no ASSETS binding is invented", () => {
  const assets = assetsOptionFrom({ main: "index.js", assets: { directory: "x" } }, (d: string) => d);
  assert.equal((assets as { binding?: unknown }).binding, undefined);
});

test("no assets directory yields no assets option", () => {
  assert.equal(assetsOptionFrom({ main: "index.js" }, (d: string) => d), undefined);
});

/**
 * Miniflare treats the leading module as the entry, and the rest must still be
 * present because the entry reaches its graph through a dynamic
 * import("./ssr/index.js") that static analysis misses.
 */
test("the entry is ordered first and no module is dropped", () => {
  const files = ["/w/ssr/index.js", "/w/index.js", "/w/assets/chunk.js"];
  const ordered = orderModuleFiles("/w/index.js", files);
  assert.equal(ordered[0], "/w/index.js");
  assert.equal(ordered.length, files.length);
  assert.deepEqual([...ordered].sort(), [...files].sort());
});

test("an entry missing from the collected modules is refused, not silently served", () => {
  assert.throws(() => orderModuleFiles("/w/index.js", ["/w/ssr/index.js"]), /not among the collected modules/u);
});

/**
 * Secrets pass through this parser. A value containing `#` or `=` must survive
 * intact — treating `#` as an inline comment would silently truncate a secret and
 * produce authentication failures with no obvious cause.
 */
test("secret values survive # and = characters", () => {
  const bindings = parseEnvFile([
    "# a comment line",
    "",
    "SUTRA_BROKER_SHARED_SECRET=abc#def=ghi",
    'QUOTED="keep me"',
    "SINGLE='keep me too'",
    "  SPACED  =  trimmed  ",
    "MALFORMED",
    "=novalue",
  ].join("\n")) as Record<string, string | undefined>;

  assert.equal(bindings["SUTRA_BROKER_SHARED_SECRET"], "abc#def=ghi");
  assert.equal(bindings["QUOTED"], "keep me");
  assert.equal(bindings["SINGLE"], "keep me too");
  assert.equal(bindings["SPACED"], "trimmed");
  assert.equal("MALFORMED" in bindings, false);
  assert.equal("" in bindings, false, "a line starting with = must not create an empty binding");
});

test("a base64url secret is not mangled", () => {
  const value = "dGhpcy1pcy1hLXRlc3Qtc2VjcmV0LXZhbHVl_-";
  const parsed = parseEnvFile(`SUTRA_BROKER_SHARED_SECRET=${value}`) as Record<string, string | undefined>;
  assert.equal(parsed["SUTRA_BROKER_SHARED_SECRET"], value);
});

test("d1 bindings are keyed by binding name", () => {
  assert.deepEqual(
    d1BindingsFrom({ d1_databases: [{ binding: "DB", database_id: "id-1" }, { database_id: "no-binding" }] }),
    { DB: "id-1" },
  );
  assert.deepEqual(d1BindingsFrom({}), {});
});

test("args parse as pairs and bare flags", () => {
  const args = parseArgs([
    "--config", "a.json", "--ip", "127.0.0.1", "--verbose", "--port", "3000",
  ]) as Record<string, string | undefined>;
  assert.equal(args["config"], "a.json");
  assert.equal(args["ip"], "127.0.0.1");
  assert.equal(args["verbose"], "true", "a bare flag becomes \"true\" rather than swallowing the next arg");
  assert.equal(args["port"], "3000");
});

/** A wrong port serves nothing, so it fails loudly instead of falling back. */
test("an invalid port is refused rather than defaulted", () => {
  assert.equal(resolvePort("3000"), 3000);
  assert.equal(resolvePort(undefined, 3000), 3000);
  for (const bad of ["0", "-1", "70000", "abc"]) {
    assert.throws(() => resolvePort(bad), /invalid port/u, `${bad} must be refused`);
  }
});
