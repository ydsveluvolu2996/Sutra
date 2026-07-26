// Governance approval gate. GET lists the requests awaiting a human decision;
// POST either raises a request for a matched policy's action, or decides one.
//
// AUTHORIZATION — deliberately asymmetric:
//   * read / raise a request: `connection:read` / `connection:manage`, the same
//     capability that authors a policy (allocation-rules route precedent).
//   * DECIDE (approve / reject): `connection:manage` AND the org-level
//     `membership:manage`. That second conjunct is the separation: a
//     customer_admin holds `connection:manage` and can therefore write a policy
//     and raise a request, but only an org_owner / org_admin holds
//     `membership:manage` and can authorize the action. It is intentionally NOT
//     the owner-only `canAdministerRecovery` gate — recovery is a break-glass
//     credential reset, whereas approving a governance action is routine
//     operational work an org_admin must be able to do without the owner.
//   * On top of the capability check, the repository refuses SELF-approval: the
//     account that raised a request can never decide it, following the
//     self-targeting refusal in db/recovery-administration-repository.ts. The
//     decision ledger is append-only, so a decision can never be rewritten.
import { getLatestConnectionForOrg } from "../../../../../db/pilot-repository";
import { governancePublicError, GovernancePolicyRepository } from "../../../../../db/governance-policy-repository";
import { isGovernanceActionKind } from "../../../../../lib/governance-policy-engine";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import type { Capability } from "../../../../../lib/auth-policy";

export const dynamic = "force-dynamic";

const POLICY_ID = /^gpol_[a-f0-9]{32}$/u;
const REQUEST_ID = /^greq_[a-f0-9]{32}$/u;
const BODY_BYTES = 8192;

async function resolveScope(request: Request, capabilities: readonly Capability[]) {
  const authenticated = await requireApiSession(request);
  const connection = await getLatestConnectionForOrg(authenticated.subject.orgId);
  if (connection === null) throw Object.assign(new Error("No cloud connection is configured"), { code: "NOT_FOUND" });
  for (const capability of capabilities) {
    assertSessionCapability(authenticated, capability, connection.customerId);
  }
  return { authenticated, connection, scope: { orgId: authenticated.subject.orgId, customerId: connection.customerId } };
}

function badRequest(): never {
  throw Object.assign(new Error("The governance-approval request is invalid"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request, ["connection:read"]);
    const repository = new GovernancePolicyRepository();
    return jsonResponse({
      pending: await repository.listPendingApprovals(scope),
      ledger: await repository.listApprovalLedger(scope),
    });
  } catch (error) {
    return errorResponse(governancePublicError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body: unknown = await readBoundedJson(request, BODY_BYTES);
    if (typeof body !== "object" || body === null) badRequest();
    const { intent, policyId, requestKey, actionKind, targetRef, requestId, reason } = body as Record<string, unknown>;
    if (typeof reason !== "string") badRequest();
    if (intent !== "request" && intent !== "approve" && intent !== "reject") badRequest();
    const repository = new GovernancePolicyRepository();

    if (intent === "request") {
      if (typeof policyId !== "string" || !POLICY_ID.test(policyId)) badRequest();
      if (typeof requestKey !== "string" || requestKey.length === 0) badRequest();
      if (typeof actionKind !== "string" || !isGovernanceActionKind(actionKind)) badRequest();
      if (targetRef !== undefined && targetRef !== null && typeof targetRef !== "string") badRequest();
      const { authenticated, scope } = await resolveScope(request, ["connection:manage"]);
      const requested = await repository.requestApproval(scope, {
        policyId,
        requestKey,
        actionKind,
        targetRef: (targetRef ?? null) as string | null,
        reason,
        actorUserId: authenticated.subject.userId,
      });
      return jsonResponse({ requested, pending: await repository.listPendingApprovals(scope) });
    }

    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) badRequest();
    // Deciding is the privileged step: customer-scoped `connection:manage` is
    // not enough on its own, the actor must also hold org-level
    // `membership:manage` (org_owner / org_admin).
    const { authenticated, scope } = await resolveScope(request, ["connection:manage", "membership:manage"]);
    const history = await repository.decideApproval(scope, {
      requestId,
      decision: intent === "approve" ? "approved" : "rejected",
      reason,
      actorUserId: authenticated.subject.userId,
    });
    return jsonResponse({ history, pending: await repository.listPendingApprovals(scope) });
  } catch (error) {
    return errorResponse(governancePublicError(error));
  }
}
