/**
 * Buffers a request body fully at the worker entry, before the framework sees it.
 *
 * ── WHY BUFFER INSTEAD OF STREAM ────────────────────────────────────────────
 * An abandoned request body KILLS the wrangler runtime. Reproduced locally on
 * 2026-07-29 against the exact production command (`wrangler dev --config
 * dist/server/wrangler.json ...`): POSTs with a JSON body to a route that rejects
 * before reading crash wrangler within ~10 requests; identical POSTs with
 * `content-length: 0` never do. The mechanism, from the wrangler debug log: the
 * unread stream breaks the connection between miniflare's proxy worker and the
 * user worker ("Network connection lost"), ProxyController treats the resulting
 * error event as FATAL, and wrangler exits 1 with an empty `✘ [ERROR]`. In
 * production the supervisor restarts it; requests landing in the gap get 500/503,
 * and five deaths in an hour exhausts the restart budget. An unauthenticated
 * client could force a container restart just by POSTing bodies.
 *
 * Cancelling the unread stream after the handler returned was tried first and did
 * NOT fix it (deployed and measured 2026-07-29, digest f08e78cd…): vinext's
 * pipeline wraps and clones the request (`middleware-runtime.js`,
 * `app-route-handler-runtime.js`), so the branch a route abandons is not the one
 * the entry can still see. Consuming the incoming stream BEFORE the framework
 * gets it is the only place the fix holds: after this, whatever the pipeline
 * clones or abandons is a memory-backed stream the proxy never notices.
 *
 * Every route already treats bodies as bounded (readBoundedJson caps at 16 KiB
 * by default, 3 MiB max; server actions at 1 MB), so routes never relied on
 * streaming. The 4 MiB cap here sits above all of them and turns the remaining
 * risk — an unauthenticated caller making us buffer — into a bounded allocation,
 * refused with 413 the moment the cap is crossed rather than after.
 */

export const MAX_BUFFERED_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export type BufferedRequestResult =
  | { readonly kind: "buffered"; readonly request: Request }
  | { readonly kind: "unmodified"; readonly request: Request }
  | { readonly kind: "too-large"; readonly limitBytes: number };

/**
 * Returns a request whose body (if any) is fully read into memory. "too-large"
 * means the caller must answer 413; by then the stream has been cancelled, so
 * nothing is left dangling either way.
 */
export async function bufferRequestBody(
  request: Request,
  limitBytes: number = MAX_BUFFERED_REQUEST_BODY_BYTES,
): Promise<BufferedRequestResult> {
  const body = request.body;
  if (body === null || request.bodyUsed) return { kind: "unmodified", request };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        // Refuse as soon as the cap is crossed — never buffer first and check
        // later. The remainder is cancelled so the incoming stream is settled;
        // an unread remainder would recreate the exact crash this file closes.
        await reader.cancel();
        return { kind: "too-large", limitBytes };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    kind: "buffered",
    // A fresh Request over the same url/method/headers with a memory-backed
    // body. Downstream clones tee memory, which is harmless to abandon.
    request: new Request(request, { body: buffered }),
  };
}
