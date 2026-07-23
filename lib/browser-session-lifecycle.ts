/**
 * Human browser sessions expire after fifteen minutes without an authenticated
 * request. This is independent of the absolute deadline stored on the session
 * row and intentionally does not apply to public API bearer tokens.
 */
export const BROWSER_SESSION_IDLE_TTL_MS = 15 * 60 * 1000;

export interface BrowserSessionDeadline {
  readonly absoluteExpiresAt: number;
  readonly lastSeenAt: number;
  readonly revokedAt: number | null;
}

export function browserSessionEffectiveExpiresAt(
  session: Pick<BrowserSessionDeadline, "absoluteExpiresAt" | "lastSeenAt">,
  idleTtlMs = BROWSER_SESSION_IDLE_TTL_MS,
): number {
  return Math.min(session.absoluteExpiresAt, session.lastSeenAt + idleTtlMs);
}

export function browserSessionIsActive(
  session: BrowserSessionDeadline,
  now: number,
  idleTtlMs = BROWSER_SESSION_IDLE_TTL_MS,
): boolean {
  return Number.isFinite(now) &&
    Number.isFinite(idleTtlMs) &&
    idleTtlMs > 0 &&
    session.revokedAt === null &&
    browserSessionEffectiveExpiresAt(session, idleTtlMs) > now;
}
