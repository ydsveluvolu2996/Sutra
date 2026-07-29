/**
 * Releases a request body that no route ever read.
 *
 * ── WHY THIS IS NOT HOUSEKEEPING ────────────────────────────────────────────
 * Abandoning an unread request body KILLS the workerd runtime. Measured against
 * production on 2026-07-29: four POSTs to /api/v1/cases, identical headers, an
 * identical 401 outcome, differing only in whether a body was attached.
 *
 *   content-length: 0  ->  4x 401, ZERO runtime restarts
 *   a JSON body        ->  401, 401, 401, then 503, and one runtime restart
 *
 * Neither the route nor the response is at fault. Every mutation handler checks the
 * origin and the session BEFORE it reads the body, which is the correct order — an
 * unauthenticated caller must not be able to make us buffer their bytes. But that
 * leaves the stream unread, wrangler exits code 1 with an empty `✘ [ERROR]`, and the
 * supervisor restarts the runtime. Requests landing in that gap get 500 ("Network
 * connection lost") or 503. Five deaths within an hour exhausts the restart budget,
 * so an unauthenticated client could force a container restart just by POSTing a
 * body repeatedly. That made it an availability bug rather than a tidiness one.
 *
 * Cancelling instead of reading is deliberate: it discards the bytes without
 * buffering them, so draining costs nothing and gives an unauthenticated caller no
 * way to make us allocate.
 *
 * Failures are swallowed on purpose. By the time this runs the response is already
 * built and correct; a body we could not release must not turn it into an error.
 */
export async function discardUnreadRequestBody(request: Request): Promise<void> {
  const body = request.body;
  if (body === null || request.bodyUsed) return;
  try {
    await body.cancel();
  } catch {
    // Already errored, already locked, or consumed between the check and here.
    // Nothing left to release, and nothing the caller can act on.
  }
}
