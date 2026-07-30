/**
 * Serves the built Worker on miniflare directly, with no wrangler dev harness.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Production served traffic through `wrangler dev`, which is a DEVELOPMENT
 * orchestrator: on top of the workerd runtime it runs a ProxyController, an
 * InspectorProxyWorker, a dev registry, config watchers and hot reload. Every
 * runtime death observed in production came from that layer, not from workerd:
 *
 *   * An unread request body broke the proxy-worker connection ("Network
 *     connection lost"); ProxyController.emitErrorEvent treats that error event as
 *     FATAL and wrangler exits 1 with an empty `✘ [ERROR]`. Measured 2026-07-29:
 *     bodied POSTs to a route that rejects before reading killed it within ~10
 *     requests. Buffering at the entry closed that trigger; this removes the
 *     layer that made a request-scoped fault lethal at all.
 *   * A roughly hourly exit 1 with the same empty error, traced to the same
 *     ProxyController/inspector machinery.
 *
 * The supervisor absorbed both by restarting the runtime in place, which works but
 * drops in-flight requests and, at five deaths an hour, gives up. Miniflare's own
 * API starts the same workerd runtime with the same bindings and none of the dev
 * harness: no ProxyController to declare a request fault fatal, no inspector
 * socket whose loss takes the process down.
 *
 * ── WHY MINIFLARE AND NOT RAW WORKERD ───────────────────────────────────────
 * The Worker's bindings (D1, the static-asset router) are miniflare simulations,
 * not native workerd services. Dropping to raw workerd would mean reimplementing
 * them. Miniflare is the smallest step that removes the failing layer while
 * keeping behaviour identical.
 *
 * Verified locally against the real build before shipping: /login 200 with its CSP
 * header, hashed client bundles served with real bytes, /api/healthz reaching the
 * Worker, origin checks intact (correct 401 / foreign 400), and 60 consecutive
 * bodied POSTs to a rejecting route with the process still alive — the exact shape
 * that killed wrangler at request 10.
 */

import { readFileSync, readdirSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Miniflare } from "miniflare";

import {
  assetsOptionFrom,
  d1BindingsFrom,
  orderModuleFiles,
  parseArgs,
  parseEnvFile,
  resolvePort,
} from "./worker-serve-config.mjs";

/** Every .js/.mjs under root, mirroring wrangler's ESModule globs under `no_bundle`. */
function collectModuleFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith(".js") || full.endsWith(".mjs")) found.push(full);
    }
  };
  walk(root);
  return found;
}

function readBindings(envFilePath) {
  if (envFilePath === undefined) return {};
  try {
    return parseEnvFile(readFileSync(resolve(envFilePath), "utf8"));
  } catch (error) {
    // A missing env file means the Worker would run without its secrets and fail
    // every authenticated request in a confusing way. Refuse instead.
    throw new Error(
      `serve-worker: cannot read --env-file ${envFilePath}: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const configPath = resolve(args.config ?? "dist/server/wrangler.json");
const configRoot = dirname(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));

const entryPath = resolve(configRoot, config.main ?? "index.js");
const ordered = orderModuleFiles(entryPath, collectModuleFiles(configRoot));
const modules = ordered.map((file) => ({
  type: "ESModule",
  path: file,
  contents: readFileSync(file),
}));

const options = {
  name: config.name ?? "sutra",
  modules,
  modulesRoot: configRoot,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags ?? [],
  bindings: { ...(config.vars ?? {}), ...readBindings(args["env-file"]) },
  host: args.ip ?? "127.0.0.1",
  port: resolvePort(args.port),
  // Deliberately absent: inspectorPort and liveReload. The inspector socket is
  // part of the machinery whose failure took the process down, and nothing in
  // production attaches a debugger.
};

const d1Databases = d1BindingsFrom(config);
if (Object.keys(d1Databases).length > 0) options.d1Databases = d1Databases;

const assets = assetsOptionFrom(config, (directory) => resolve(configRoot, directory));
if (assets !== undefined) options.assets = assets;

/**
 * Signal handlers are installed BEFORE constructing Miniflare, and the order is
 * load-bearing. Miniflare installs its OWN SIGTERM/SIGINT handlers that dispose and
 * exit; Node runs handlers in registration order, so constructing first meant
 * miniflare's handler exited the process before this one could record anything —
 * measured as a shutdown that left no trace in the container log at all. Declared
 * `let` because the handler closes over a runtime that does not exist yet.
 */
let miniflare = null;

/**
 * Writes a line synchronously to stdout.
 *
 * console.log is asynchronous when stdout is a pipe — which it always is under the
 * supervisor and Docker — and a shutdown path that ends the process races that
 * write. Measured: the shutdown event never reached the container log, making a
 * deliberate stop indistinguishable from a crash. Shutdown logging must be
 * synchronous to be worth having.
 */
function logSync(payload) {
  try {
    writeSync(1, `${JSON.stringify(payload)}\n`);
  } catch {
    // Nothing useful to do if even stdout is gone.
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logSync({ event: "sutra.worker.shutdown", signal });
  try {
    if (miniflare !== null) await miniflare.dispose();
  } catch (error) {
    logSync({
      event: "sutra.worker.shutdown-failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  // Exit by draining rather than calling process.exit: when stdout is a pipe (it
  // always is under the supervisor and Docker) process.exit discards buffered
  // writes, which silently swallowed the shutdown event above and would have made
  // a deliberate stop indistinguishable from a crash in the container log.
  // dispose() releases the runtime, so the loop empties on its own; the unref'd
  // failsafe only matters if something unexpected holds it open, and must never be
  // what normally ends the process.
  process.exitCode = 0;
  const failsafe = setTimeout(() => {
    logSync({
      event: "sutra.worker.shutdown-forced",
      detail: "the event loop did not drain after dispose; exiting hard",
    });
    process.exit(0);
  }, 5_000);
  failsafe.unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

miniflare = new Miniflare(options);


/**
 * A request-scoped fault must never take the server down — that failure mode is
 * the entire reason this file exists, so it is logged and survived rather than
 * rethrown. A genuinely dead runtime is still caught: the startup path below
 * exits non-zero, and the supervisor watches for the process exiting at all.
 */
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({
    event: "sutra.worker.unhandled-rejection",
    detail: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  }));
});

try {
  const url = await miniflare.ready;
  // Kept byte-compatible with wrangler's line: the supervisor and the operational
  // runbooks grep for "Ready on".
  console.log(`[sutra:info] Ready on ${url.origin}`);
  console.log(JSON.stringify({
    event: "sutra.worker.ready",
    runtime: "miniflare",
    origin: url.origin,
    modules: modules.length,
    assets: assets !== undefined,
    d1: Object.keys(d1Databases),
    detail: "serving without a wrangler dev harness: no ProxyController, no inspector",
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: "sutra.worker.start-failed",
    detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
  }));
  process.exit(1);
}
