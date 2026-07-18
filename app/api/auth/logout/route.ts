import { getLocalSession } from "../../../../db/auth-repository";
import { revokeManagedSession } from "../../../../db/session-administration-repository";
import {
  expiredSessionCookie,
  sessionTokenFromRequest,
} from "../../../../lib/api-auth";
import { assertAuthMutation, authErrorResponse } from "../../../../lib/auth-http";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // The same-origin / authentication gate still applies (CSRF protection): a
  // cross-origin request is rejected without touching the session.
  try {
    assertAuthMutation(request);
  } catch (error) {
    return authErrorResponse(error);
  }

  // Past the gate, signing out MUST always clear the client session. Revoking the
  // server-side session row is best-effort: it does a fail-closed, hash-chained
  // audit write, and a failure there (contention, a stale audit chain, a lookup
  // miss) must never keep the user signed in. Previously the cookie was cleared
  // only on the success return, so any throw here left the user logged in with a
  // "could not sign out" error and no redirect.
  try {
    const token = sessionTokenFromRequest(request);
    if (token !== null) {
      const authenticated = await getLocalSession(token);
      if (authenticated !== null) await revokeManagedSession(authenticated, authenticated.session.id);
    }
  } catch {
    // Intentionally swallowed — the cookie is cleared unconditionally below, so
    // the operator is signed out client-side regardless of the revocation result.
  }

  return jsonResponse(
    { signedOut: true },
    { headers: { "set-cookie": expiredSessionCookie(request) } },
  );
}
