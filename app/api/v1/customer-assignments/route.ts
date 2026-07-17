import {
  listCustomerAssignments,
  replaceCustomerAssignments,
  type CustomerAssignmentGrant,
} from "../../../../db/customer-assignment-repository";
import { LocalAuthError, requireRecentMfa } from "../../../../db/auth-repository";
import { authorizePilotRequest } from "../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../lib/auth-http";
import type { CustomerRole, ScopeMode } from "../../../../lib/auth-policy";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function parseGrants(value: unknown): readonly CustomerAssignmentGrant[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new LocalAuthError(400, "INVALID_INPUT", "Customer assignments must be a bounded list");
  }
  return value.map((candidate) => {
    const grant = exactInputObject(candidate, ["customerId", "role"]);
    return {
      customerId: boundedInputString(grant.customerId, {
        label: "customer identifier",
        maximum: 128,
      }),
      role: boundedInputString(grant.role, {
        label: "customer role",
        maximum: 32,
      }) as CustomerRole,
    };
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await authorizePilotRequest(request, "membership:manage");
    return jsonResponse(await listCustomerAssignments(actor.authenticated));
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const actor = await authorizePilotRequest(request, "membership:manage");
    requireRecentMfa(actor.authenticated);
    const body = exactInputObject(
      await readAuthJson(request, 64 * 1024),
      ["membershipId", "scopeMode", "grants"],
    );
    const member = await replaceCustomerAssignments(actor.authenticated, {
      membershipId: boundedInputString(body.membershipId, {
        label: "membership identifier",
        maximum: 128,
      }),
      scopeMode: boundedInputString(body.scopeMode, {
        label: "customer scope",
        maximum: 32,
      }) as ScopeMode,
      grants: parseGrants(body.grants),
    });
    return jsonResponse({ member });
  } catch (error) {
    return authErrorResponse(error);
  }
}
