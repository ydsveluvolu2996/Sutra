/**
 * Pure derivation of miniflare options from the built wrangler config.
 *
 * Separated from serve-worker.mjs so it can be tested without starting a runtime.
 * Everything here is derived from the SAME `dist/server/wrangler.json` that
 * wrangler read, never hardcoded, so a build-config change cannot silently
 * diverge from what production serves.
 */

/** Parses `--name value` / `--flag` pairs. */
export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = "true";
      continue;
    }
    args[name] = next;
    index += 1;
  }
  return args;
}

/**
 * Parses a wrangler-style env file. Values are literal apart from one pair of
 * surrounding quotes — a secret containing `#` or `=` must survive intact, so
 * nothing is treated as an inline comment and only the FIRST `=` splits.
 */
export function parseEnvFile(contents) {
  const bindings = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    bindings[key] = value;
  }
  return bindings;
}

/**
 * Orders the worker's modules. The entry MUST come first — miniflare treats the
 * leading module as the worker entry — and every other .js has to be present
 * because the entry reaches its graph through a DYNAMIC `import("./ssr/index.js")`
 * that static analysis would miss. This mirrors wrangler's `no_bundle: true` with
 * ESModule rules over `**\/*.js`.
 */
export function orderModuleFiles(entryPath, moduleFiles) {
  if (!moduleFiles.includes(entryPath)) {
    throw new Error(`worker-serve-config: the entry ${entryPath} is not among the collected modules`);
  }
  return [entryPath, ...moduleFiles.filter((file) => file !== entryPath)];
}

/** D1 bindings, keyed by binding name. */
export function d1BindingsFrom(config) {
  const databases = {};
  for (const database of config.d1_databases ?? []) {
    if (typeof database.binding === "string") databases[database.binding] = database.database_id;
  }
  return databases;
}

/**
 * The assets option, or undefined when no directory is configured.
 *
 * `has_user_worker` is the whole subtlety. The asset router runs first and falls
 * through to the Worker on a miss — but only if it knows a Worker exists. Without
 * it every route 404s at the router and the Worker is never invoked, while static
 * files still serve, so the app looks half-alive rather than broken. Asking the
 * router to invoke the Worker AHEAD of assets instead fails outright with "Fetch
 * for user worker without having a user worker binding". Wrangler derives exactly
 * this from `main` being present, so this mirrors it rather than inventing it.
 *
 * No `binding` is set, matching the build config: static files are therefore
 * served by the router ahead of the Worker and do not receive the entry's security
 * headers. That is pre-existing behaviour, deliberately not changed here.
 */
export function assetsOptionFrom(config, resolveDirectory) {
  if (config.assets?.directory === undefined) return undefined;
  return {
    directory: resolveDirectory(config.assets.directory),
    routerConfig: { has_user_worker: config.main !== undefined },
  };
}

/** The port, rejected loudly rather than defaulted, since a wrong one serves nothing. */
export function resolvePort(raw, fallback = 3000) {
  const port = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`worker-serve-config: invalid port ${raw}`);
  }
  return port;
}
