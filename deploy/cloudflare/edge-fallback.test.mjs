import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  handleRequest,
  MAINTENANCE_CSS,
  MAINTENANCE_STYLE_SHA256,
} from "./edge-fallback.mjs";

const env = {
  ORIGIN_HOSTNAME: "origin.sutracmdb.com",
  PUBLIC_HOSTNAME: "www.sutracmdb.com",
  APEX_HOSTNAME: "sutracmdb.com",
};

function request(path = "/dashboard", init) {
  return new Request(`https://www.sutracmdb.com${path}`, init);
}

function assertFallbackHeaders(response, expectedType) {
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type") ?? "", expectedType);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /unsafe-inline/);
}

test("healthy origin responses are returned unchanged, including cookies", async () => {
  const upstream = new Response("healthy", {
    status: 201,
    headers: { "Set-Cookie": "sutra_session=opaque; HttpOnly; Secure; SameSite=Lax" },
  });
  const response = await handleRequest(request("/login"), env, { fetch: async () => upstream });

  assert.strictEqual(response, upstream);
  assert.equal(response.headers.get("set-cookie"), "sutra_session=opaque; HttpOnly; Secure; SameSite=Lax");
});

test("all configured origin failure statuses produce the branded HTML fallback", async () => {
  const statuses = [502, 503, 504, ...Array.from({ length: 11 }, (_, index) => 520 + index)];

  for (const status of statuses) {
    const response = await handleRequest(request(), env, {
      fetch: async () => new Response(`origin detail ${status}`, { status }),
    });
    assertFallbackHeaders(response, /^text\/html/);
    const body = await response.text();
    assert.match(body, /Sutra/);
    assert.match(body, /We are weaving things back together/);
    assert.doesNotMatch(body, new RegExp(`origin detail ${status}`));
  }
});

test("unlisted origin errors pass through unchanged", async () => {
  const upstream = new Response("application error", { status: 500 });
  const response = await handleRequest(request(), env, { fetch: async () => upstream });
  assert.strictEqual(response, upstream);
});

test("API, OpenAPI and webhook-like paths receive RFC problem JSON", async () => {
  const paths = [
    "/api/public/v1/resources",
    "/api",
    "/openapi.json",
    "/integrations/slack/webhook/events",
    "/integrations/teams/webhooks/events",
    "/hooks/runtime",
  ];

  for (const path of paths) {
    const response = await handleRequest(request(path), env, {
      fetch: async () => new Response("bad gateway", { status: 502 }),
    });
    assertFallbackHeaders(response, /^application\/problem\+json/);
    assert.deepEqual(await response.json(), {
      type: "https://www.sutracmdb.com/problems/service-unavailable",
      title: "Service temporarily unavailable",
      status: 503,
      detail: "Sutra is temporarily unavailable. Retry the request shortly.",
    });
  }
});

test("HEAD fallbacks preserve HEAD semantics for UI and API routes", async () => {
  for (const path of ["/dashboard", "/api/public/v1/resources"]) {
    const response = await handleRequest(request(path, { method: "HEAD" }), env, {
      fetch: async () => new Response(null, { status: 503 }),
    });
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "");
    assert.match(
      response.headers.get("content-type") ?? "",
      path.startsWith("/api/") ? /^application\/problem\+json/ : /^text\/html/,
    );
  }
});

test("network failures return a fallback after exactly one attempt", async () => {
  let calls = 0;
  const response = await handleRequest(request(), env, {
    fetch: async () => {
      calls += 1;
      throw new Error("origin address is unreachable");
    },
  });

  assert.equal(calls, 1);
  assertFallbackHeaders(response, /^text\/html/);
});

test("unsafe requests are proxied once and never replayed after an origin failure", async () => {
  let calls = 0;
  let received;
  const response = await handleRequest(
    request("/api/public/v1/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "demo-key" },
      body: JSON.stringify({ title: "demo" }),
    }),
    env,
    {
      fetch: async (originRequest) => {
        calls += 1;
        received = {
          url: originRequest.url,
          method: originRequest.method,
          body: await originRequest.text(),
          forwardedHost: originRequest.headers.get("x-forwarded-host"),
          forwardedProto: originRequest.headers.get("x-forwarded-proto"),
        };
        return new Response("unavailable", { status: 503 });
      },
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(received, {
    url: "https://origin.sutracmdb.com/api/public/v1/cases",
    method: "POST",
    body: JSON.stringify({ title: "demo" }),
    forwardedHost: "www.sutracmdb.com",
    forwardedProto: "https",
  });
  assertFallbackHeaders(response, /^application\/problem\+json/);
});

test("origin routing preserves path and query while replacing only the authority", async () => {
  let received;
  const upstream = new Response("ok");
  const response = await handleRequest(request("/findings?severity=critical&cursor=opaque"), env, {
    fetch: async (originRequest) => {
      received = originRequest;
      return upstream;
    },
  });

  assert.strictEqual(response, upstream);
  assert.equal(
    received.url,
    "https://origin.sutracmdb.com/findings?severity=critical&cursor=opaque",
  );
  assert.equal(received.headers.get("x-sutra-edge"), "cloudflare-worker");
  assert.equal(received.headers.get("cf-access-client-id"), null);
  assert.equal(received.headers.get("cf-access-client-secret"), null);
});

test("client-supplied Access identity headers are stripped before origin fetch", async () => {
  let received;
  const response = await handleRequest(request("/dashboard", {
    headers: {
      "CF-Access-Client-Id": "attacker-client-id-value",
      "CF-Access-Client-Secret": "attacker-secret-value",
      "CF-Access-Jwt-Assertion": "attacker-jwt-value",
    },
  }), env, {
    fetch: async (originRequest) => {
      received = originRequest;
      return new Response("ok");
    },
  });
  assert.equal(response.status, 200);
  assert.equal(received.headers.get("cf-access-client-id"), null);
  assert.equal(received.headers.get("cf-access-client-secret"), null);
  assert.equal(received.headers.get("cf-access-jwt-assertion"), null);
});

test("missing, invalid or recursive origin configuration fails closed", async () => {
  const variants = [
    {},
    { ...env, ORIGIN_HOSTNAME: "not a hostname" },
    { ...env, ORIGIN_HOSTNAME: "www.sutracmdb.com" },
    { ...env, ORIGIN_HOSTNAME: "sutracmdb.com" },
  ];

  for (const variant of variants) {
    let calls = 0;
    const response = await handleRequest(request(), variant, {
      fetch: async () => {
        calls += 1;
        return new Response("must not happen");
      },
    });
    assert.equal(calls, 0);
    assertFallbackHeaders(response, /^text\/html/);
  }
});

test("apex browser requests redirect to www without touching the origin", async () => {
  let calls = 0;
  const apexRequest = new Request("https://sutracmdb.com/docs?from=apex");
  const response = await handleRequest(apexRequest, env, {
    fetch: async () => {
      calls += 1;
      return new Response("must not happen");
    },
  });

  assert.equal(calls, 0);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://www.sutracmdb.com/docs?from=apex");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(await response.text(), "");
});

test("apex write requests are not redirected or replayed", async () => {
  let calls = 0;
  const apexRequest = new Request("https://sutracmdb.com/webhooks/falco", {
    method: "POST",
    body: "signed-event",
  });
  const response = await handleRequest(apexRequest, env, {
    fetch: async () => {
      calls += 1;
      return new Response("must not happen");
    },
  });

  assert.equal(calls, 0);
  assert.equal(response.status, 421);
  assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/);
  assert.equal((await response.json()).status, 421);
});

test("unexpected hostnames fail closed without becoming an open proxy", async () => {
  let calls = 0;
  const response = await handleRequest(new Request("https://attacker.example/dashboard"), env, {
    fetch: async () => {
      calls += 1;
      return new Response("must not happen");
    },
  });

  assert.equal(calls, 0);
  assert.equal(response.status, 421);
});

test("maintenance CSP authorizes only the exact embedded stylesheet", () => {
  const digest = createHash("sha256").update(MAINTENANCE_CSS).digest("base64");
  assert.equal(MAINTENANCE_STYLE_SHA256, `sha256-${digest}`);
});
