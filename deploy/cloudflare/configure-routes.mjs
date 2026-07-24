#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";

export const APPLY_CONFIRMATION = "APPLY_SUTRA_EDGE_ROUTES";
export const WORKER_SCRIPT = "sutra-edge-fallback";
export const EXPECTED_ROUTES = Object.freeze([
  Object.freeze({
    pattern: "www.sutracmdb.com/assets/*",
    script: null,
    requestLimitFailOpen: null,
  }),
  Object.freeze({
    pattern: "www.sutracmdb.com/*",
    script: WORKER_SCRIPT,
    requestLimitFailOpen: true,
  }),
  Object.freeze({
    pattern: "sutracmdb.com/*",
    script: WORKER_SCRIPT,
    requestLimitFailOpen: true,
  }),
]);

const EXPECTED_PATTERNS = new Set(EXPECTED_ROUTES.map((route) => route.pattern));
const ZONE_ID_PATTERN = /^[a-f0-9]{32}$/i;

export class RouteConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RouteConfigurationError";
  }
}

function validateCredentials(token, zoneId) {
  if (typeof token !== "string" || token.length === 0) {
    throw new RouteConfigurationError("CLOUDFLARE_API_TOKEN is required.");
  }
  if (/[\r\n\0]/u.test(token)) {
    throw new RouteConfigurationError("CLOUDFLARE_API_TOKEN contains invalid characters.");
  }
  if (typeof zoneId !== "string" || !ZONE_ID_PATTERN.test(zoneId)) {
    throw new RouteConfigurationError(
      "CLOUDFLARE_ZONE_ID must be a 32-character hexadecimal zone identifier.",
    );
  }
}

function normalizeRoute(route) {
  if (route === null || typeof route !== "object" || Array.isArray(route)) {
    throw new RouteConfigurationError("Cloudflare returned an invalid route object.");
  }
  if (typeof route.id !== "string" || route.id.length === 0) {
    throw new RouteConfigurationError("Cloudflare returned a route without an identifier.");
  }
  if (typeof route.pattern !== "string" || route.pattern.length === 0) {
    throw new RouteConfigurationError("Cloudflare returned a route without a pattern.");
  }
  if (route.script !== null && route.script !== undefined && typeof route.script !== "string") {
    throw new RouteConfigurationError("Cloudflare returned a route with an invalid script.");
  }

  return {
    id: route.id,
    pattern: route.pattern,
    script: route.script ?? null,
    requestLimitFailOpen: route.request_limit_fail_open === true,
  };
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes)) {
    throw new RouteConfigurationError("Cloudflare did not return a route list.");
  }
  return routes.map(normalizeRoute);
}

function routeMatches(route, expected) {
  if (route.pattern !== expected.pattern || route.script !== expected.script) {
    return false;
  }
  return expected.script === null || route.requestLimitFailOpen === true;
}

function mutationBody(expected) {
  if (expected.script === null) {
    // Omitting `script` creates an exclusion route. Sending an empty string is
    // not equivalent and risks assigning an invalid Worker name.
    return { pattern: expected.pattern };
  }
  return {
    pattern: expected.pattern,
    script: expected.script,
    request_limit_fail_open: true,
  };
}

function indexExpectedRoutes(routes) {
  const byPattern = new Map();
  for (const route of routes) {
    if (!EXPECTED_PATTERNS.has(route.pattern)) {
      continue;
    }
    const matches = byPattern.get(route.pattern) ?? [];
    matches.push(route);
    byPattern.set(route.pattern, matches);
  }

  for (const expected of EXPECTED_ROUTES) {
    const matches = byPattern.get(expected.pattern) ?? [];
    if (matches.length > 1) {
      throw new RouteConfigurationError(
        `Cloudflare returned duplicate routes for ${expected.pattern}; refusing to mutate.`,
      );
    }
  }
  return byPattern;
}

export function buildRoutePlan(rawRoutes) {
  const routes = normalizeRoutes(rawRoutes);
  const byPattern = indexExpectedRoutes(routes);
  const actions = [];

  for (const expected of EXPECTED_ROUTES) {
    const existing = (byPattern.get(expected.pattern) ?? [])[0];
    if (!existing) {
      actions.push({
        operation: "create",
        pattern: expected.pattern,
        routeId: null,
        body: mutationBody(expected),
      });
      continue;
    }
    if (!routeMatches(existing, expected)) {
      actions.push({
        operation: "update",
        pattern: expected.pattern,
        routeId: existing.id,
        body: mutationBody(expected),
      });
    }
  }

  return actions;
}

function expectedForPattern(pattern) {
  const expected = EXPECTED_ROUTES.find((route) => route.pattern === pattern);
  if (!expected) {
    throw new RouteConfigurationError(`No route invariant is defined for ${pattern}.`);
  }
  return expected;
}

function assertMutationResult(result, expected) {
  const route = normalizeRoute(result);
  const failOpenWasReturned = Object.hasOwn(result, "request_limit_fail_open");
  const failOpenIsWrong =
    expected.script !== null && failOpenWasReturned && route.requestLimitFailOpen !== true;
  if (
    route.pattern !== expected.pattern ||
    route.script !== expected.script ||
    failOpenIsWrong
  ) {
    throw new RouteConfigurationError(
      `Cloudflare did not apply the exact expected route state for ${expected.pattern}.`,
    );
  }
}

export function assertExpectedRouteState(rawRoutes) {
  const routes = normalizeRoutes(rawRoutes);
  const byPattern = indexExpectedRoutes(routes);

  for (const expected of EXPECTED_ROUTES) {
    const matches = byPattern.get(expected.pattern) ?? [];
    if (matches.length !== 1 || !routeMatches(matches[0], expected)) {
      throw new RouteConfigurationError(
        `Cloudflare route validation failed for ${expected.pattern}.`,
      );
    }
  }

  return routes;
}

function unrelatedRouteFingerprint(routes) {
  return normalizeRoutes(routes)
    .filter((route) => !EXPECTED_PATTERNS.has(route.pattern))
    .map((route) => JSON.stringify(route))
    .sort();
}

export function assertUnrelatedRoutesPreserved(before, after) {
  const previous = unrelatedRouteFingerprint(before);
  const current = unrelatedRouteFingerprint(after);
  if (
    previous.length !== current.length ||
    previous.some((fingerprint, index) => fingerprint !== current[index])
  ) {
    throw new RouteConfigurationError(
      "An unrelated Cloudflare Worker route changed; review the zone before continuing.",
    );
  }
}

function safeApiMessages(payload) {
  if (!payload || !Array.isArray(payload.errors)) {
    return "";
  }
  const codes = payload.errors
    .map((entry) => (entry && Number.isInteger(entry.code) ? String(entry.code) : null))
    .filter(Boolean);
  return codes.length > 0 ? ` Cloudflare error code(s): ${codes.join(", ")}.` : "";
}

function createApi({ token, zoneId, fetchImpl }) {
  const routeCollectionPath = `/zones/${zoneId}/workers/routes`;

  async function request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${API_ROOT}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new RouteConfigurationError(
        "Cloudflare API request failed before a response was received.",
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new RouteConfigurationError(
        `Cloudflare API returned a non-JSON response (HTTP ${response.status}).`,
      );
    }

    if (!response.ok || payload?.success !== true) {
      throw new RouteConfigurationError(
        `Cloudflare API rejected the route request (HTTP ${response.status}).${safeApiMessages(payload)}`,
      );
    }
    return payload.result;
  }

  return {
    list: () => request(routeCollectionPath),
    create: (body) => request(routeCollectionPath, { method: "POST", body }),
    update: (routeId, body) =>
      request(`${routeCollectionPath}/${encodeURIComponent(routeId)}`, {
        method: "PUT",
        body,
      }),
  };
}

export async function configureRoutes({
  token,
  zoneId,
  apply = false,
  confirmation,
  fetchImpl = globalThis.fetch,
}) {
  validateCredentials(token, zoneId);
  if (typeof fetchImpl !== "function") {
    throw new RouteConfigurationError("A Fetch-compatible API client is required.");
  }
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new RouteConfigurationError(
      `Refusing to apply without CLOUDFLARE_ROUTE_APPLY_CONFIRM=${APPLY_CONFIRMATION}.`,
    );
  }

  const api = createApi({ token, zoneId, fetchImpl });
  const before = await api.list();
  const actions = buildRoutePlan(before);

  if (!apply) {
    return {
      mode: "dry-run",
      actions,
      validated: actions.length === 0,
    };
  }

  for (const action of actions) {
    const result =
      action.operation === "create"
        ? await api.create(action.body)
        : await api.update(action.routeId, action.body);
    assertMutationResult(result, expectedForPattern(action.pattern));
  }

  const after = await api.list();
  assertExpectedRouteState(after);
  assertUnrelatedRoutesPreserved(before, after);
  return {
    mode: "apply",
    actions,
    validated: true,
  };
}

function printUsage() {
  process.stdout.write(`Usage: node configure-routes.mjs [--apply]

Environment:
  CLOUDFLARE_API_TOKEN          narrowly scoped Zone Workers Routes token
  CLOUDFLARE_ZONE_ID            32-character Cloudflare zone identifier
  CLOUDFLARE_ROUTE_APPLY_CONFIRM
                                must equal ${APPLY_CONFIRMATION} with --apply

Without --apply the utility performs a read-only dry run.
`);
}

function printResult(result) {
  const prefix = result.mode === "apply" ? "Applied" : "Dry run";
  process.stdout.write(`${prefix}: ${result.actions.length} route change(s) required.\n`);
  for (const action of result.actions) {
    const target = action.body.script ?? "no script (origin bypass)";
    const failOpen =
      action.body.request_limit_fail_open === true ? ", request-limit fail-open" : "";
    process.stdout.write(
      `- ${action.operation} ${action.pattern} -> ${target}${failOpen}\n`,
    );
  }
  if (result.validated) {
    process.stdout.write("Exact Sutra route invariants are satisfied.\n");
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--help")) {
    printUsage();
    return 0;
  }
  const unknown = argv.filter((argument) => argument !== "--apply");
  if (unknown.length > 0) {
    throw new RouteConfigurationError(`Unknown argument: ${unknown[0]}`);
  }

  const result = await configureRoutes({
    token: env.CLOUDFLARE_API_TOKEN,
    zoneId: env.CLOUDFLARE_ZONE_ID,
    apply: argv.includes("--apply"),
    confirmation: env.CLOUDFLARE_ROUTE_APPLY_CONFIRM,
  });
  printResult(result);
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message =
      error instanceof RouteConfigurationError
        ? error.message
        : "Unexpected route configuration failure.";
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
}
