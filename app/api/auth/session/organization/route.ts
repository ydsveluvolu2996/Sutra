import { getLocalSession, LocalAuthError, requireRecentMfa } from "../../../../../db/auth-repository";
import { switchActiveOrganization } from "../../../../../db/session-administration-repository";
import { requireApiSession, sessionTokenFromRequest } from "../../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

/**
 * Switch the caller's active organization. Any authenticated, MFA-verified
 * member may switch to an organization they belong to — the membership is
 * verified inside switchActiveOrganization, not gated on a management
 * capability. Recent-MFA is required, consistent with other privileged session
 * actions. The session token/cookie is unchanged (the switch only moves
 * selected_org_id), so no set-cookie is issued; the refreshed session is
 * returned for the client to re-render tenant-scoped views.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const token = sessionTokenFromRequest(request);
    const authenticated = await requireApiSession(request, { requireMfa: true });
    requireRecentMfa(authenticated);
    const body = exactInputObject(await readAuthJson(request, 256), ["organizationId"]);
    const targetOrgId = boundedInputString(body.organizationId, { label: "organization identifier", maximum: 64 });
    await switchActiveOrganization(authenticated, targetOrgId);
    const refreshed = token === null ? null : await getLocalSession(token);
    if (refreshed === null) {
      throw new LocalAuthError(401, "AUTHENTICATION_REQUIRED", "Sign in before switching organizations");
    }
    return jsonResponse({ session: refreshed.session }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
