import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APPLY_CONFIRMATION,
  EXPECTED_ROUTES,
  RouteConfigurationError,
  assertExpectedRouteState,
  assertUnrelatedRoutesPreserved,
  buildRoutePlan,
  configureRoutes,
} from "./configure-routes.mjs";

const TOKEN = "test-token-that-must-never-be-printed";
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const COLLECTION_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes`;

const exactRoutes = [
  {
    id: "assets-route",
    pattern: "www.sutracmdb.com/assets/*",
    script: null,
    request_limit_fail_open: false,
  },
  {
    id: "www-route",
    pattern: "www.sutracmdb.com/*",
    script: "sutra-edge-fallback",
    request_limit_fail_open: true,
  },
  {
    id: "apex-route",
    pattern: "sutracmdb.com/*",
    script: "sutra-edge-fallback",
    request_limit_fail_open: true,
  },
];

const unrelatedRoute = {
  id: "unrelated-route",
  pattern: "status.example.net/*",
  script: "another-worker",
  request_limit_fail_open: false,
};

function apiResponse(result, { status = 200, success = true, errors = [] } = {}) {
  return new Response(JSON.stringify({ success, errors, messages: [], result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestBody(init) {
  return init.body === undefined ? undefined : JSON.parse(init.body);
}

test("declares the exact production route invariants", () => {
  assert.deepEqual(EXPECTED_ROUTES, [
    {
      pattern: "www.sutracmdb.com/assets/*",
      script: null,
      requestLimitFailOpen: null,
    },
    {
      pattern: "www.sutracmdb.com/*",
      script: "sutra-edge-fallback",
      requestLimitFailOpen: true,
    },
    {
      pattern: "sutracmdb.com/*",
      script: "sutra-edge-fallback",
      requestLimitFailOpen: true,
    },
  ]);
});

test("an exact route set is idempotent and needs no actions", () => {
  assert.deepEqual(buildRoutePlan([...exactRoutes, unrelatedRoute]), []);
  assert.doesNotThrow(() => assertExpectedRouteState([...exactRoutes, unrelatedRoute]));
});

test("plans only missing or incorrect Sutra routes and leaves unrelated routes out", () => {
  const routes = [
    exactRoutes[0],
    { ...exactRoutes[1], request_limit_fail_open: false },
    unrelatedRoute,
  ];
  assert.deepEqual(buildRoutePlan(routes), [
    {
      operation: "update",
      pattern: "www.sutracmdb.com/*",
      routeId: "www-route",
      body: {
        pattern: "www.sutracmdb.com/*",
        script: "sutra-edge-fallback",
        request_limit_fail_open: true,
      },
    },
    {
      operation: "create",
      pattern: "sutracmdb.com/*",
      routeId: null,
      body: {
        pattern: "sutracmdb.com/*",
        script: "sutra-edge-fallback",
        request_limit_fail_open: true,
      },
    },
  ]);
});

test("the no-script exclusion omits script instead of using an empty worker name", () => {
  const routes = [
    { ...exactRoutes[0], script: "sutra-edge-fallback" },
    exactRoutes[1],
    exactRoutes[2],
  ];
  const [action] = buildRoutePlan(routes);
  assert.deepEqual(action, {
    operation: "update",
    pattern: "www.sutracmdb.com/assets/*",
    routeId: "assets-route",
    body: { pattern: "www.sutracmdb.com/assets/*" },
  });
  assert.equal(Object.hasOwn(action.body, "script"), false);
});

test("dry-run is read-only by default and does not expose its token", async () => {
  const calls = [];
  const result = await configureRoutes({
    token: TOKEN,
    zoneId: ZONE_ID,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return apiResponse([exactRoutes[0], exactRoutes[1], unrelatedRoute]);
    },
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].operation, "create");
  assert.equal(result.validated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, COLLECTION_URL);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test("apply requires a second explicit environment confirmation before any API call", async () => {
  let calls = 0;
  await assert.rejects(
    configureRoutes({
      token: TOKEN,
      zoneId: ZONE_ID,
      apply: true,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    }),
    new RegExp(`CLOUDFLARE_ROUTE_APPLY_CONFIRM=${APPLY_CONFIRMATION}`),
  );
  assert.equal(calls, 0);
});

test("apply uses exact PUT and POST bodies, then validates final state", async () => {
  const before = [
    { ...exactRoutes[0], script: "sutra-edge-fallback" },
    { ...exactRoutes[1], request_limit_fail_open: false },
    unrelatedRoute,
  ];
  const after = [...exactRoutes, unrelatedRoute];
  const calls = [];

  const result = await configureRoutes({
    token: TOKEN,
    zoneId: ZONE_ID,
    apply: true,
    confirmation: APPLY_CONFIRMATION,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: requestBody(init) });
      switch (calls.length) {
        case 1:
          return apiResponse(before);
        case 2:
          return apiResponse({
            id: exactRoutes[0].id,
            pattern: exactRoutes[0].pattern,
          });
        case 3:
          return apiResponse({
            id: exactRoutes[1].id,
            pattern: exactRoutes[1].pattern,
            script: exactRoutes[1].script,
          });
        case 4:
          return apiResponse(exactRoutes[2]);
        case 5:
          return apiResponse(after);
        default:
          throw new Error("unexpected request");
      }
    },
  });

  assert.deepEqual(
    calls.map(({ url, method, body }) => ({ url, method, body })),
    [
      { url: COLLECTION_URL, method: "GET", body: undefined },
      {
        url: `${COLLECTION_URL}/assets-route`,
        method: "PUT",
        body: { pattern: "www.sutracmdb.com/assets/*" },
      },
      {
        url: `${COLLECTION_URL}/www-route`,
        method: "PUT",
        body: {
          pattern: "www.sutracmdb.com/*",
          script: "sutra-edge-fallback",
          request_limit_fail_open: true,
        },
      },
      {
        url: COLLECTION_URL,
        method: "POST",
        body: {
          pattern: "sutracmdb.com/*",
          script: "sutra-edge-fallback",
          request_limit_fail_open: true,
        },
      },
      { url: COLLECTION_URL, method: "GET", body: undefined },
    ],
  );
  assert.equal(result.mode, "apply");
  assert.equal(result.actions.length, 3);
  assert.equal(result.validated, true);
});

test("duplicate managed patterns fail closed before any mutation", async () => {
  let calls = 0;
  await assert.rejects(
    configureRoutes({
      token: TOKEN,
      zoneId: ZONE_ID,
      apply: true,
      confirmation: APPLY_CONFIRMATION,
      fetchImpl: async () => {
        calls += 1;
        return apiResponse([exactRoutes[0], exactRoutes[1], { ...exactRoutes[1], id: "duplicate" }]);
      },
    }),
    /duplicate routes/,
  );
  assert.equal(calls, 1);
});

test("an inexact mutation result fails before subsequent changes", async () => {
  let calls = 0;
  await assert.rejects(
    configureRoutes({
      token: TOKEN,
      zoneId: ZONE_ID,
      apply: true,
      confirmation: APPLY_CONFIRMATION,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return apiResponse([{ ...exactRoutes[0], script: "wrong-script" }, exactRoutes[1], exactRoutes[2]]);
        }
        return apiResponse({ ...exactRoutes[0], script: "wrong-script" });
      },
    }),
    /did not apply the exact expected route state/,
  );
  assert.equal(calls, 2);
});

test("post-apply validation detects changes to unrelated routes", async () => {
  let calls = 0;
  await assert.rejects(
    configureRoutes({
      token: TOKEN,
      zoneId: ZONE_ID,
      apply: true,
      confirmation: APPLY_CONFIRMATION,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return apiResponse([
            exactRoutes[0],
            { ...exactRoutes[1], request_limit_fail_open: false },
            exactRoutes[2],
            unrelatedRoute,
          ]);
        }
        if (calls === 2) {
          return apiResponse(exactRoutes[1]);
        }
        return apiResponse([
          ...exactRoutes,
          { ...unrelatedRoute, script: "unexpected-change" },
        ]);
      },
    }),
    /unrelated Cloudflare Worker route changed/,
  );
  assert.equal(calls, 3);
});

test("Cloudflare API errors report only status and error codes, never credentials", async () => {
  let error;
  try {
    await configureRoutes({
      token: TOKEN,
      zoneId: ZONE_ID,
      fetchImpl: async () =>
        apiResponse(null, {
          status: 403,
          success: false,
          errors: [{ code: 10000, message: `authentication failed for ${TOKEN}` }],
        }),
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof RouteConfigurationError);
  assert.match(error.message, /HTTP 403/);
  assert.match(error.message, /10000/);
  assert.doesNotMatch(error.message, new RegExp(TOKEN));
});

test("rejects missing credentials and malformed zone identifiers locally", async () => {
  await assert.rejects(
    configureRoutes({ token: "", zoneId: ZONE_ID, fetchImpl: async () => apiResponse([]) }),
    /CLOUDFLARE_API_TOKEN is required/,
  );
  await assert.rejects(
    configureRoutes({ token: TOKEN, zoneId: "not-a-zone", fetchImpl: async () => apiResponse([]) }),
    /32-character hexadecimal/,
  );
});

test("unrelated route comparison is order-independent but content-sensitive", () => {
  assert.doesNotThrow(() =>
    assertUnrelatedRoutesPreserved(
      [...exactRoutes, unrelatedRoute, { ...unrelatedRoute, id: "second", pattern: "other/*" }],
      [{ ...unrelatedRoute, id: "second", pattern: "other/*" }, unrelatedRoute, ...exactRoutes],
    ),
  );
  assert.throws(
    () =>
      assertUnrelatedRoutesPreserved(
        [...exactRoutes, unrelatedRoute],
        [...exactRoutes, { ...unrelatedRoute, script: "changed" }],
      ),
    /unrelated Cloudflare Worker route changed/,
  );
});

test("Wrangler deploys only the script and cannot overwrite API-managed routes", async () => {
  const wrangler = await readFile(new URL("./wrangler.example.toml", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /^\s*\[\[routes\]\]/m);
  assert.match(wrangler, /configure-routes\.mjs/);
});
