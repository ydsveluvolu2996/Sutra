import { requireRecentMfa, unlockLocalUserAccount } from "../../../../../db/auth-repository";
import { authorizePilotRequest } from "../../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// Operator account-unlock: an org operator (org_owner / org_admin) clears the
// per-account failed-attempt lockout for a local member of their own org — the
// recovery path for the login lockout-DoS. Requires a fresh MFA step-up. The
// capability + org-scope checks live in unlockLocalUserAccount so the boundary
// is enforced in one place.
export async function POST(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const actor = await authorizePilotRequest(request, "workspace:read");
    requireRecentMfa(actor.authenticated);
    const body = exactInputObject(await readAuthJson(request, 1024), ["userId"]);
    const unlocked = await unlockLocalUserAccount(
      actor.authenticated,
      boundedInputString(body.userId, { label: "account identifier", maximum: 64 }),
    );
    return jsonResponse({ unlocked });
  } catch (error) {
    return authErrorResponse(error);
  }
}
