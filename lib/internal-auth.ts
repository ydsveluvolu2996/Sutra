/**
 * Constant-time verification of the shared token that gates system-internal
 * endpoints (currently the background-job runner). Extracted as a tiny pure
 * helper so the auth decision is unit-testable without a live request or the
 * worker runtime, and so the comparison never short-circuits on content.
 */
export type InternalTokenVerdict = "ok" | "not-configured" | "unauthorized";

/** Constant-time string compare — leaks length only, never content. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

/**
 * Decide whether a presented token authorizes a system-internal request.
 * `not-configured` means the endpoint has no expected token set (the caller
 * should respond 503, never treat it as authorized); `unauthorized` covers a
 * missing or mismatched token.
 */
export function verifyInternalToken(expected: string | undefined, provided: string | null): InternalTokenVerdict {
  const trimmed = expected?.trim();
  if (trimmed === undefined || trimmed.length === 0) return "not-configured";
  if (provided === null || provided.length === 0) return "unauthorized";
  return timingSafeEqual(trimmed, provided) ? "ok" : "unauthorized";
}
