import assert from "node:assert/strict";
import test from "node:test";

import { effectiveRequestOrigin } from "../lib/request-origin.ts";
import { assertSameOrigin } from "../lib/aws-pilot-security.ts";

const request = (url: string, headers: Record<string, string>): Request =>
  new Request(url, { headers });

/**
 * The regression these tests exist for, in one sentence: a wrangler/miniflare bump
 * changed `request.url` from reflecting the Host header to reflecting the listening
 * socket, the derived origin silently became https://127.0.0.1:3000, and all 54
 * assertSameOrigin call sites began rejecting every browser request — sign-in
 * included — with only "The request origin is invalid" to go on.
 *
 * The first test is the exact production request shape. If it ever fails again, the
 * whole write path is down.
 */
test("the canonical Host header wins over a socket-derived request URL", () => {
  assert.equal(
    effectiveRequestOrigin(
      request("http://127.0.0.1:3000/api/auth/login", {
        host: "www.sutracmdb.com",
        "x-forwarded-proto": "https",
      }),
    ),
    "https://www.sutracmdb.com",
  );
});

test("a browser Origin passes the same-origin check behind the production proxy", () => {
  // End to end through the real assertion, not just the helper: this is what login does.
  assert.doesNotThrow(() => {
    assertSameOrigin(
      request("http://127.0.0.1:3000/api/auth/login", {
        host: "www.sutracmdb.com",
        "x-forwarded-proto": "https",
        origin: "https://www.sutracmdb.com",
        "sec-fetch-site": "same-origin",
      }),
    );
  });
});

test("a cross-origin browser request is still rejected", () => {
  assert.throws(() => {
    assertSameOrigin(
      request("http://127.0.0.1:3000/api/auth/login", {
        host: "www.sutracmdb.com",
        "x-forwarded-proto": "https",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      }),
    );
  });
});

test("local development without proxy headers still resolves its own origin", () => {
  assert.equal(effectiveRequestOrigin(request("http://localhost:8787/x", {})), "http://localhost:8787");
});

test("an ambiguous or hostile Host fails closed instead of falling back to the socket", () => {
  // Falling back silently is precisely what made the outage hard to see, so each of
  // these returns null rather than quietly using 127.0.0.1:3000.
  for (const host of ["a.example, b.example", "evil.example/path", "   "]) {
    assert.equal(
      effectiveRequestOrigin(request("http://127.0.0.1:3000/x", { host })),
      null,
      `Host "${host}" must not resolve`,
    );
  }
});

test("a malformed or multi-valued forwarded protocol fails closed", () => {
  for (const proto of ["gopher", "https,https", ""]) {
    assert.equal(
      effectiveRequestOrigin(
        request("http://127.0.0.1:3000/x", { host: "www.sutracmdb.com", "x-forwarded-proto": proto }),
      ),
      null,
      `x-forwarded-proto "${proto}" must not resolve`,
    );
  }
});

test("a string input keeps working for callers that have only a URL", () => {
  assert.equal(effectiveRequestOrigin("https://www.sutracmdb.com/anything"), "https://www.sutracmdb.com");
});
