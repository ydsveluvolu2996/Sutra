import assert from "node:assert/strict";
import test from "node:test";

import { discardUnreadRequestBody } from "../lib/request-body-drain.ts";

/**
 * The regression these tests exist for, measured against production 2026-07-29.
 *
 * Four POSTs to /api/v1/cases, identical headers, identical 401 outcome, differing
 * only in whether a body was attached:
 *
 *   content-length: 0  -> 4x 401, ZERO runtime restarts
 *   a JSON body        -> 401, 401, 401, then 503, and one runtime restart
 *
 * Every mutation route validates origin and session BEFORE reading the body, which
 * is the correct order — an unauthenticated caller must not be able to make us
 * buffer their bytes. That leaves the stream unread, and an unread request body
 * kills the workerd runtime: wrangler exits 1 with an empty error and the
 * supervisor restarts it. Five deaths in an hour exhausts the restart budget, so
 * an unauthenticated client could force a container restart just by POSTing a body
 * repeatedly. These tests pin the drain that closes it.
 */

test("an unread body is released rather than abandoned", async () => {
  const request = new Request("https://example.test/api/v1/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create" }),
  });
  assert.equal(request.bodyUsed, false, "precondition: nothing has read it");
  assert.notEqual(request.body, null, "precondition: there is a stream to release");

  await discardUnreadRequestBody(request);

  // Cancelled, so nothing is left dangling for the runtime to trip over. Reading it
  // afterwards must not yield the payload either.
  await assert.rejects(
    async () => request.text(),
    "a cancelled body must not still be readable",
  );
});

/**
 * The common case by request count. A GET has no body at all, and the drain must
 * not invent work — or worse, throw on the hot path for every page view.
 */
test("a request with no body is a no-op", async () => {
  const request = new Request("https://example.test/login");
  assert.equal(request.body, null);
  await assert.doesNotReject(async () => discardUnreadRequestBody(request));
});

/**
 * The successful mutation path: the route DID read the body. Cancelling a consumed
 * stream throws, so the guard must notice and leave it alone. Getting this wrong
 * would break every authenticated write rather than only the rejected ones.
 */
test("a body the route already read is left alone", async () => {
  const request = new Request("https://example.test/api/v1/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create" }),
  });
  const parsed = (await request.json()) as { operation: string };
  assert.equal(parsed.operation, "create", "the route got its payload");
  assert.equal(request.bodyUsed, true);

  await assert.doesNotReject(async () => discardUnreadRequestBody(request));
});

/**
 * Draining twice must be safe. The main path and the deployment-boundary rejection
 * both drain, and a future branch could reach one after the other; a throw here
 * would turn a correct response into a 500.
 */
test("draining twice does not throw", async () => {
  const request = new Request("https://example.test/api/v1/cases", {
    method: "POST",
    body: "{}",
  });
  await discardUnreadRequestBody(request);
  await assert.doesNotReject(async () => discardUnreadRequestBody(request));
});

/**
 * A body that errors mid-stream must not become the response. The drain swallows
 * failures on purpose: by the time it runs the response is already built and
 * correct, and a body we could not release is not the caller's problem.
 */
test("a body that fails to cancel does not surface as an error", async () => {
  const failing = new Request("https://example.test/api/v1/cases", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error("upstream connection dropped"));
      },
    }),
    // @ts-expect-error -- duplex is required for a stream body and is not in the DOM lib types.
    duplex: "half",
  });
  await assert.doesNotReject(async () => discardUnreadRequestBody(failing));
});
