import {
  createIdentityInvitation,
  listIdentityInvitations,
  revokeIdentityInvitation,
} from "../../../../db/identity-invitation-repository";
import { requireRecentMfa } from "../../../../db/auth-repository";
import { authorizeMembershipManagementRequest } from "../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../lib/auth-http";
import type { OrgRole, ScopeMode } from "../../../../lib/auth-policy";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const { actor, scope } = await authorizeMembershipManagementRequest(request);
    return jsonResponse({ invitations: await listIdentityInvitations(actor.authenticated, scope) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const { actor, scope } = await authorizeMembershipManagementRequest(request);
    requireRecentMfa(actor.authenticated);
    const body = exactInputObject(
      await readAuthJson(request, 4 * 1024),
      ["email", "role", "scopeMode", "lifetimeHours"],
      ["customerId", "allowedIssuer"],
    );
    const role = boundedInputString(body.role, { label: "membership role", maximum: 32 }) as OrgRole;
    const scopeMode = boundedInputString(body.scopeMode, { label: "customer scope", maximum: 32 }) as ScopeMode;
    if (typeof body.lifetimeHours !== "number" || !Number.isSafeInteger(body.lifetimeHours)) {
      throw { code: "INVALID_INPUT" };
    }
    const customerId =
      body.customerId === undefined || body.customerId === null
        ? null
        : boundedInputString(body.customerId, { label: "customer identifier", maximum: 128 });
    // (LOW-2) OPTIONAL: pin the invitation to a specific OIDC issuer/provider so
    // only an identity from that IdP can accept it. Absent => unpinned (unchanged).
    const allowedIssuer =
      body.allowedIssuer === undefined || body.allowedIssuer === null
        ? null
        : boundedInputString(body.allowedIssuer, { label: "sign-in provider issuer", maximum: 2048 });
    const created = await createIdentityInvitation(actor.authenticated, scope, {
      email: boundedInputString(body.email, { label: "email address", maximum: 254 }),
      role,
      scopeMode,
      lifetimeMs: body.lifetimeHours * 60 * 60 * 1000,
      customerId,
      allowedIssuer,
    });
    const invitationUrl = new URL("/api/auth/oidc/start", request.url);
    invitationUrl.searchParams.set("invitation", created.token);
    invitationUrl.searchParams.set("returnTo", "/dashboard");
    return jsonResponse(
      {
        invitation: created.invitation,
        activationUrl: invitationUrl.toString(),
        activationUrlShownOnce: true,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const { actor, scope } = await authorizeMembershipManagementRequest(request);
    requireRecentMfa(actor.authenticated);
    const body = exactInputObject(await readAuthJson(request, 1024), ["invitationId"]);
    await revokeIdentityInvitation(
      actor.authenticated,
      scope,
      boundedInputString(body.invitationId, { label: "invitation identifier", maximum: 64 }),
    );
    return jsonResponse({ revoked: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
