import assert from "node:assert/strict";
import test from "node:test";

import { TURNSTILE_ACTIONS } from "../lib/turnstile-contract.ts";
import {
  TurnstileVerificationError,
  turnstileClientConfiguration,
  verifyTurnstileToken,
  type TurnstileEnvironment,
} from "../lib/turnstile-server.ts";

const NOW = Date.parse("2026-07-24T08:00:00.000Z");
const TOKEN = "valid-token_1234567890";
const ACTIVE: TurnstileEnvironment = {
  SUTRA_DEPLOYMENT_ENV: "staging",
  SUTRA_LOCAL_MODE: "false",
  SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
  SUTRA_TURNSTILE_ENABLED: "true",
  SUTRA_TURNSTILE_SITE_KEY: "0x4AAAAAAAAAAAAAAAAAAAAAAA",
  SUTRA_TURNSTILE_SECRET_KEY: "0x4BBBBBBBBBBBBBBBBBBBBBBB",
  SUTRA_TURNSTILE_DEV_BYPASS: "false",
};

function siteverify(
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json(
    {
      success: true,
      challenge_ts: new Date(NOW).toISOString(),
      hostname: "www.sutracmdb.com",
      action: TURNSTILE_ACTIONS.login,
      ...overrides,
    },
    { headers: { "content-type": "application/json" } },
  );
}

async function rejectedCode(
  operation: Promise<unknown>,
): Promise<{ readonly code: string; readonly status: number }> {
  try {
    await operation;
    assert.fail("expected Turnstile verification to fail");
  } catch (error) {
    assert.ok(error instanceof TurnstileVerificationError);
    return { code: error.code, status: error.status };
  }
}

test("client config exposes only the site key, never the verification secret", () => {
  const configuration = turnstileClientConfiguration(
    ACTIVE,
    new Request("https://www.sutracmdb.com/login"),
  );
  assert.deepEqual(configuration, {
    enabled: true,
    siteKey: ACTIVE.SUTRA_TURNSTILE_SITE_KEY,
  });
  assert.doesNotMatch(
    JSON.stringify(configuration),
    new RegExp(ACTIVE.SUTRA_TURNSTILE_SECRET_KEY ?? "missing", "u"),
  );
});

test("verification binds the one-time token to the exact route action and canonical hostname", async () => {
  let call:
    | { readonly url: string; readonly init: RequestInit; readonly body: URLSearchParams }
    | undefined;
  await verifyTurnstileToken(
    new Request("https://www.sutracmdb.com/api/auth/login"),
    ACTIVE,
    TOKEN,
    TURNSTILE_ACTIONS.login,
    {
      now: NOW,
      fetch: async (url, init) => {
        assert.ok(init?.body instanceof URLSearchParams);
        call = {
          url: String(url),
          init: init ?? {},
          body: init.body,
        };
        return siteverify();
      },
    },
  );
  assert.equal(
    call?.url,
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  );
  assert.equal(call?.init.method, "POST");
  const headers = new Headers(call?.init.headers);
  assert.match(
    headers.get("idempotency-key") ?? "",
    /^sutra-turnstile-[a-f0-9]{64}$/u,
  );
  assert.equal(call?.body.get("secret"), ACTIVE.SUTRA_TURNSTILE_SECRET_KEY);
  assert.equal(call?.body.get("response"), TOKEN);
  assert.match(call?.body.get("idempotency_key") ?? "", /^[a-f0-9-]{36}$/u);
});

test("a transient Siteverify failure is retried once with the same idempotency key", async () => {
  let calls = 0;
  const idempotencyKeys: string[] = [];
  const gatewayIdempotencyKeys: string[] = [];
  await verifyTurnstileToken(
    new Request("https://www.sutracmdb.com/api/auth/login"),
    ACTIVE,
    TOKEN,
    TURNSTILE_ACTIONS.login,
    {
      now: NOW,
      fetch: async (_url, init) => {
        calls += 1;
        assert.ok(init?.body instanceof URLSearchParams);
        idempotencyKeys.push(init.body.get("idempotency_key") ?? "");
        gatewayIdempotencyKeys.push(
          new Headers(init.headers).get("idempotency-key") ?? "",
        );
        if (calls === 1) throw new Error("temporary network failure");
        return siteverify();
      },
    },
  );
  assert.equal(calls, 2);
  assert.match(idempotencyKeys[0] ?? "", /^[a-f0-9-]{36}$/u);
  assert.equal(idempotencyKeys[1], idempotencyKeys[0]);
  assert.equal(gatewayIdempotencyKeys[1], gatewayIdempotencyKeys[0]);
});

test("a transient Siteverify HTTP response is retried once", async () => {
  let calls = 0;
  await verifyTurnstileToken(
    new Request("https://www.sutracmdb.com/api/auth/login"),
    ACTIVE,
    TOKEN,
    TURNSTILE_ACTIONS.login,
    {
      now: NOW,
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? Response.json({ success: false }, { status: 503 })
          : siteverify();
      },
    },
  );
  assert.equal(calls, 2);
});

test("missing tokens, mismatched actions, mismatched hosts and stale challenges fail closed", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return siteverify();
  };
  assert.deepEqual(
    await rejectedCode(
      verifyTurnstileToken(
        new Request("https://www.sutracmdb.com/api/auth/login"),
        ACTIVE,
        "",
        TURNSTILE_ACTIONS.login,
        { now: NOW, fetch: fetcher },
      ),
    ),
    { code: "TURNSTILE_REQUIRED", status: 400 },
  );
  assert.equal(calls, 0, "a malformed token must not consume provider capacity");

  for (const response of [
    siteverify({ action: TURNSTILE_ACTIONS.contact }),
    siteverify({ hostname: "attacker.example" }),
    siteverify({ challenge_ts: "2026-07-24T07:40:00.000Z" }),
    siteverify({ success: false }),
  ]) {
    assert.deepEqual(
      await rejectedCode(
        verifyTurnstileToken(
          new Request("https://www.sutracmdb.com/api/auth/login"),
          ACTIVE,
          TOKEN,
          TURNSTILE_ACTIONS.login,
          { now: NOW, fetch: async () => response },
        ),
      ),
      { code: "TURNSTILE_REJECTED", status: 400 },
    );
  }
});

test("provider outages, malformed payloads and oversized responses fail closed as unavailable", async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => {
      throw new Error("network down");
    },
    async () => new Response("not json", { status: 502 }),
    async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    async () =>
      new Response("x".repeat(8 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ];
  for (const fetcher of cases) {
    assert.deepEqual(
      await rejectedCode(
        verifyTurnstileToken(
          new Request("https://www.sutracmdb.com/api/contact"),
          ACTIVE,
          TOKEN,
          TURNSTILE_ACTIONS.contact,
          { now: NOW, fetch: fetcher },
        ),
      ),
      { code: "TURNSTILE_UNAVAILABLE", status: 503 },
    );
  }
});

test("one deadline covers a request stalled before headers and a response body stalled afterward", async () => {
  const request = new Request("https://www.sutracmdb.com/api/auth/login");
  const never = new Promise<Response>(() => undefined);
  assert.deepEqual(
    await rejectedCode(
      verifyTurnstileToken(
        request,
        ACTIVE,
        TOKEN,
        TURNSTILE_ACTIONS.login,
        {
          now: NOW,
          timeoutMs: 20,
          fetch: async () => await never,
        },
      ),
    ),
    { code: "TURNSTILE_UNAVAILABLE", status: 503 },
  );

  let cancelled = false;
  const stalledBody = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual(
    await rejectedCode(
      verifyTurnstileToken(
        request,
        ACTIVE,
        TOKEN,
        TURNSTILE_ACTIONS.login,
        {
          now: NOW,
          timeoutMs: 20,
          fetch: async () =>
            new Response(stalledBody, {
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ),
    { code: "TURNSTILE_UNAVAILABLE", status: 503 },
  );
  assert.equal(cancelled, true, "a timed-out response body must be cancelled");
});

test("the deadline is not reset by a response body that drip-feeds data", async () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      success: true,
      challenge_ts: new Date(NOW).toISOString(),
      hostname: "www.sutracmdb.com",
      action: TURNSTILE_ACTIONS.login,
    }),
  );
  let offset = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const dripFedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      interval = setInterval(() => {
        if (offset === encoded.byteLength) {
          if (interval !== undefined) clearInterval(interval);
          controller.close();
          return;
        }
        controller.enqueue(encoded.subarray(offset, offset + 1));
        offset += 1;
      }, 3);
    },
    cancel() {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
    },
  });

  assert.deepEqual(
    await rejectedCode(
      verifyTurnstileToken(
        new Request("https://www.sutracmdb.com/api/auth/login"),
        ACTIVE,
        TOKEN,
        TURNSTILE_ACTIONS.login,
        {
          now: NOW,
          timeoutMs: 30,
          fetch: async () =>
            new Response(dripFedBody, {
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ),
    { code: "TURNSTILE_UNAVAILABLE", status: 503 },
  );
  assert.ok(offset < encoded.byteLength, "the full body must not be consumed");
  assert.equal(cancelled, true, "the drip-fed body must be cancelled");
});

test("chunked oversized response bodies are rejected before unbounded buffering", async () => {
  let pulls = 0;
  let cancelled = false;
  const oversizedBody = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(8 * 1024).fill(0x20));
          return;
        }
        controller.enqueue(Uint8Array.of(0x20));
      },
      cancel() {
        cancelled = true;
      }
    },
    {
      // Prevent the stream implementation from speculatively pulling another
      // chunk after Sutra receives the first over-limit byte.
      highWaterMark: 0,
    },
  );

  assert.deepEqual(
    await rejectedCode(
      verifyTurnstileToken(
        new Request("https://www.sutracmdb.com/api/auth/login"),
        ACTIVE,
        TOKEN,
        TURNSTILE_ACTIONS.login,
        {
          now: NOW,
          fetch: async () =>
            new Response(oversizedBody, {
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ),
    { code: "TURNSTILE_UNAVAILABLE", status: 503 },
  );
  assert.equal(pulls, 2, "verification must stop at the first over-limit byte");
  assert.equal(cancelled, true, "an oversized response body must be cancelled");
});

test("the development bypass is explicit, loopback-only and impossible in staging", async () => {
  const local: TurnstileEnvironment = {
    SUTRA_DEPLOYMENT_ENV: "local",
    SUTRA_LOCAL_MODE: "true",
    SUTRA_TURNSTILE_ENABLED: "false",
    SUTRA_TURNSTILE_DEV_BYPASS: "true",
  };
  assert.deepEqual(
    turnstileClientConfiguration(local, new Request("http://127.0.0.1:3000/login")),
    { enabled: false },
  );
  await verifyTurnstileToken(
    new Request("http://localhost:3000/api/auth/login"),
    local,
    "",
    TURNSTILE_ACTIONS.login,
    { fetch: async () => assert.fail("bypass must not contact Siteverify") },
  );

  for (const [environment, url] of [
    [{ ...local, SUTRA_DEPLOYMENT_ENV: "staging" }, "https://www.sutracmdb.com/login"],
    [{ ...local, SUTRA_LOCAL_MODE: "false" }, "http://127.0.0.1:3000/login"],
    [local, "https://example.test/login"],
    [{ ...local, SUTRA_TURNSTILE_ENABLED: "true" }, "http://127.0.0.1:3000/login"],
  ] as const) {
    assert.throws(
      () =>
        turnstileClientConfiguration(
          environment,
          new Request(url),
        ),
      (error: unknown) =>
        error instanceof TurnstileVerificationError &&
        error.code === "TURNSTILE_CONFIGURATION_INVALID" &&
        error.status === 503,
    );
  }
});

test("configuration is deny-by-default and rejects malformed boolean or key values", () => {
  for (const environment of [
    {},
    { ...ACTIVE, SUTRA_TURNSTILE_ENABLED: "TRUE" },
    { ...ACTIVE, SUTRA_TURNSTILE_SITE_KEY: "short" },
    { ...ACTIVE, SUTRA_TURNSTILE_SECRET_KEY: "short" },
    { ...ACTIVE, SUTRA_PUBLIC_ORIGIN: "https://attacker.example/path" },
    { ...ACTIVE, SUTRA_TURNSTILE_DEV_BYPASS: "TRUE" },
  ]) {
    assert.throws(
      () =>
        turnstileClientConfiguration(
          environment,
          new Request("https://www.sutracmdb.com/login"),
        ),
      (error: unknown) =>
        error instanceof TurnstileVerificationError &&
        error.code === "TURNSTILE_CONFIGURATION_INVALID",
    );
  }
});

test("a partial managed outbound tuple is a configuration error before egress", async () => {
  assert.deepEqual(
    await rejectedCode(
      verifyTurnstileToken(
        new Request("https://www.sutracmdb.com/api/auth/login"),
        {
          ...ACTIVE,
          SUTRA_MANAGED_OUTBOUND_URL: "https://outbound.sutracmdb.com",
        },
        TOKEN,
        TURNSTILE_ACTIONS.login,
        { now: NOW },
      ),
    ),
    { code: "TURNSTILE_CONFIGURATION_INVALID", status: 503 },
  );
});

test("network runtimes reject Cloudflare's public test credentials while local testing remains possible", () => {
  const alwaysPassSiteKey = "1x00000000000000000000AA";
  const alwaysPassSecretKey = "1x0000000000000000000000000000000AA";
  for (const environment of [
    { ...ACTIVE, SUTRA_TURNSTILE_SITE_KEY: alwaysPassSiteKey },
    { ...ACTIVE, SUTRA_TURNSTILE_SECRET_KEY: alwaysPassSecretKey },
    {
      ...ACTIVE,
      SUTRA_TURNSTILE_SITE_KEY: ACTIVE.SUTRA_TURNSTILE_SECRET_KEY,
    },
  ]) {
    assert.throws(
      () =>
        turnstileClientConfiguration(
          environment,
          new Request("https://www.sutracmdb.com/login"),
        ),
      (error: unknown) =>
        error instanceof TurnstileVerificationError &&
        error.code === "TURNSTILE_CONFIGURATION_INVALID",
    );
  }

  assert.deepEqual(
    turnstileClientConfiguration(
      {
        SUTRA_DEPLOYMENT_ENV: "local",
        SUTRA_LOCAL_MODE: "true",
        SUTRA_TURNSTILE_ENABLED: "true",
        SUTRA_TURNSTILE_SITE_KEY: alwaysPassSiteKey,
        SUTRA_TURNSTILE_SECRET_KEY: alwaysPassSecretKey,
        SUTRA_TURNSTILE_DEV_BYPASS: "false",
      },
      new Request("http://127.0.0.1:3000/login"),
    ),
    { enabled: true, siteKey: alwaysPassSiteKey },
  );
});
