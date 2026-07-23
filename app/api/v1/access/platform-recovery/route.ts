import { platformRecoverOwnerMfa } from "../../../../../db/recovery-administration-repository";
import { LocalAuthError } from "../../../../../db/auth-repository";
import { assertBootstrapToken, isLoopbackHostname } from "../../../../../lib/api-auth";
import {
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// Host-local platform cold path: recover an organization owner's MFA when no
// owner can authenticate. This is only reachable on a genuine loopback host and
// only with the host's bootstrap token — never over the public origin. It has
// no authenticated actor; the audit event is attributed to the platform system.
export async function POST(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (!isLoopbackHostname(url.hostname)) {
      throw new LocalAuthError(404, "AUTHENTICATION_REQUIRED", "Platform recovery is unavailable");
    }
    await assertBootstrapToken(request);
    const body = exactInputObject(
      await readAuthJson(request, 4 * 1024),
      ["orgId", "targetUserId", "operationId"],
    );
    await platformRecoverOwnerMfa({
      orgId: boundedInputString(body.orgId, { label: "organization identifier", maximum: 128 }),
      targetUserId: boundedInputString(body.targetUserId, { label: "account identifier", maximum: 64 }),
      operationId: boundedInputString(body.operationId, { label: "operation identifier", maximum: 64 }),
    });
    return jsonResponse({ ok: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
