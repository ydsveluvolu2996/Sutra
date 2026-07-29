import assert from "node:assert/strict";
import test from "node:test";

import { bufferRequestBody, MAX_BUFFERED_REQUEST_BODY_BYTES } from "../lib/request-body-buffer.ts";

/**
 * The regression these tests pin, reproduced locally 2026-07-29 against the exact
 * production command: POSTs with a body to a route that rejects before reading kill
 * the wrangler runtime within ~10 requests ("Network connection lost" →
 * ProxyController treats it as fatal → exit 1); identical POSTs with
 * `content-length: 0` never do. Cancelling the stream after the handler returned was
 * deployed first and did NOT hold — the framework clones the request, so the
 * abandoned branch is out of the entry's reach. The fix is to consume the incoming
 * stream before the framework sees it; these tests pin that consumption.
 */

test("a bodied request is fully consumed and replaced with a memory-backed copy", async () => {
  const original = new Request("https://example.test/api/v1/cases", {
    method: "POST",
    headers: { "content-type": "application/json", "x-custom": "kept" },
    body: JSON.stringify({ operation: "create" }),
  });

  const result = await bufferRequestBody(original);
  assert.equal(result.kind, "buffered");
  if (result.kind !== "buffered") return;

  // The incoming stream is settled — nothing left for the proxy to trip over.
  assert.equal(original.bodyUsed, true, "the original stream must be consumed");

  // The replacement is byte-identical and keeps method, url and headers.
  assert.equal(result.request.method, "POST");
  assert.equal(result.request.url, "https://example.test/api/v1/cases");
  assert.equal(result.request.headers.get("x-custom"), "kept");
  assert.deepEqual(await result.request.json(), { operation: "create" });
});

/**
 * The framework clones the request (middleware-runtime.js, route-handler runtime).
 * A clone of the buffered request must tee memory, not the incoming socket — and
 * abandoning one branch, which is exactly what a rejecting route does, must leave
 * the other fully readable.
 */
test("a clone of the buffered request survives its sibling being abandoned", async () => {
  const result = await bufferRequestBody(new Request("https://example.test/api/v1/cases", {
    method: "POST",
    body: JSON.stringify({ operation: "create" }),
  }));
  assert.equal(result.kind, "buffered");
  if (result.kind !== "buffered") return;

  const clone = result.request.clone();
  // The original branch is abandoned — never read, never cancelled — like a route
  // that rejects before reading. The clone must still deliver the payload.
  assert.deepEqual(await clone.json(), { operation: "create" });
});

test("a request with no body passes through untouched", async () => {
  const original = new Request("https://example.test/login");
  const result = await bufferRequestBody(original);
  assert.equal(result.kind, "unmodified");
  if (result.kind !== "unmodified") return;
  assert.equal(result.request, original, "no copy for the common case");
});

/**
 * The cap is refused the moment it is crossed, not after buffering the whole
 * payload — an unauthenticated caller must not be able to make us hold more than
 * the limit. The remainder is cancelled so the refusal itself cannot leave an
 * unread stream behind, which would recreate the crash this module closes.
 */
test("a body over the cap is refused as too-large without buffering it all", async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const request = new Request("https://example.test/api/v1/cases", {
    method: "POST",
    body: endless,
    // @ts-expect-error -- duplex is required for a stream body and is not in the DOM lib types.
    duplex: "half",
  });

  const result = await bufferRequestBody(request, 256 * 1024);
  assert.equal(result.kind, "too-large");
  if (result.kind !== "too-large") return;
  assert.equal(result.limitBytes, 256 * 1024);
  // 256 KiB cap over 64 KiB chunks: crossed on the 5th chunk. A few pulls of
  // slack are fine; buffering megabytes before refusing is not.
  assert.ok(pulled <= 8, `refused after ${pulled} pulls — the cap must bind during the read`);
});

test("a body exactly at the cap is accepted", async () => {
  const exact = new Uint8Array(1024);
  const result = await bufferRequestBody(
    new Request("https://example.test/api/v1/cases", { method: "POST", body: exact }),
    1024,
  );
  assert.equal(result.kind, "buffered");
  if (result.kind !== "buffered") return;
  assert.equal((await result.request.arrayBuffer()).byteLength, 1024);
});

test("the default cap sits above every route-level bound", () => {
  // readBoundedJson allows up to 3 MiB (MAX_CONFIGURABLE_JSON_BODY_LIMIT) and
  // server actions 1 MB; the entry cap must never be the binding constraint for
  // a legitimate request.
  assert.ok(MAX_BUFFERED_REQUEST_BODY_BYTES >= 3 * 1024 * 1024 + 1);
});
