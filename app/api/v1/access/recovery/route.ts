import {
  provisionOwner,
  recoverMemberMfa,
  transferOwner,
} from "../../../../../db/recovery-administration-repository";
import { LocalAuthError, requireRecentMfa } from "../../../../../db/auth-repository";
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

// Owner-driven recovery administration. The capability gate here only ensures
// the actor can manage membership at all; the owner-only refinement (and every
// isolation/last-owner invariant) lives in the repository so the boundary is
// enforced in one place, in SQL. A fresh MFA step-up is mandatory.
export async function POST(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const actor = await authorizePilotRequest(request, "membership:manage");
    requireRecentMfa(actor.authenticated);
    const body = exactInputObject(
      await readAuthJson(request, 4 * 1024),
      ["operation", "operationId", "target"],
    );
    const operation = boundedInputString(body.operation, { label: "recovery operation", maximum: 32 });
    const operationId = boundedInputString(body.operationId, { label: "operation identifier", maximum: 64 });
    const target = boundedInputString(body.target, { label: "recovery target", maximum: 64 });
    if (operation === "reset_member_mfa") {
      await recoverMemberMfa(actor.authenticated, { targetUserId: target, operationId });
      return jsonResponse({ ok: true });
    }
    if (operation === "provision_owner") {
      await provisionOwner(actor.authenticated, { targetMembershipId: target, operationId });
      return jsonResponse({ ok: true });
    }
    if (operation === "transfer_owner") {
      await transferOwner(actor.authenticated, { targetMembershipId: target, operationId });
      return jsonResponse({ ok: true });
    }
    throw new LocalAuthError(400, "INVALID_INPUT", "The recovery operation is invalid");
  } catch (error) {
    return authErrorResponse(error);
  }
}
