import { env } from "cloudflare:workers";

import {
  beginIdentityInvitationDelivery,
  completeIdentityInvitationDelivery,
  createIdentityInvitationIdempotently,
  listIdentityInvitations,
  revokeIdentityInvitation,
} from "../../../../db/identity-invitation-repository";
import { requireRecentMfa } from "../../../../db/auth-repository";
import { authorizeMembershipManagementRequest, isHostedOidcRuntime } from "../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../lib/auth-http";
import type { OrgRole, ScopeMode } from "../../../../lib/auth-policy";
import {
  deliverInvitationEmail,
  type InvitationDeliveryEnv,
} from "../../../../lib/invitation-delivery";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function activationBase(requestUrl: string, configuredOrigin: string | undefined): string {
  try {
    const parsed = new URL(configuredOrigin ?? "");
    if (
      parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
    ) return parsed.origin;
  } catch {
    // The delivery adapter reports configuration failure. Keep the existing
    // request-origin URL available as the one-time manual-copy fallback.
  }
  return requestUrl;
}

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
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const created = await createIdentityInvitationIdempotently(actor.authenticated, scope, {
      email: boundedInputString(body.email, { label: "email address", maximum: 254 }),
      role,
      scopeMode,
      lifetimeMs: body.lifetimeHours * 60 * 60 * 1000,
      customerId,
      allowedIssuer,
    }, idempotencyKey);
    if (created.replayed || created.token === null) {
      return jsonResponse({
        invitation: created.invitation,
        delivery: created.invitation.delivery,
        replayed: true,
        activationUrlShownOnce: false,
      }, { headers: { "cache-control": "no-store" } });
    }
    // The activation URL depends on how members authenticate. OIDC deployments
    // hand the token to the federated sign-in start endpoint; local and
    // managed-password deployments send the invitee to the set-password page.
    let invitationUrl: URL;
    const deliveryEnv = env as unknown as InvitationDeliveryEnv;
    const urlBase = activationBase(request.url, deliveryEnv.SUTRA_PUBLIC_ORIGIN);
    if (isHostedOidcRuntime()) {
      invitationUrl = new URL("/api/auth/oidc/start", urlBase);
      invitationUrl.searchParams.set("invitation", created.token);
      invitationUrl.searchParams.set("returnTo", "/dashboard");
    } else {
      invitationUrl = new URL("/accept-invite", urlBase);
      invitationUrl.searchParams.set("token", created.token);
    }
    const deliveryIdempotencyKey = `creation-${created.invitation.id}`;
    const begun = await beginIdentityInvitationDelivery(actor.authenticated, scope, {
      invitationId: created.invitation.id,
      idempotencyKey: deliveryIdempotencyKey,
      rotateToken: false,
    });
    const outcome = await deliverInvitationEmail({
      recipient: created.invitation.email,
      activationUrl: invitationUrl.toString(),
      expiresAt: created.invitation.expiresAt,
      role: created.invitation.role,
    }, deliveryEnv);
    let invitation = begun.invitation;
    try {
      invitation = await completeIdentityInvitationDelivery(
        actor.authenticated,
        scope,
        created.invitation.id,
        deliveryIdempotencyKey,
        outcome,
      );
    } catch {
      // The invitation and claim are already durable. If the outcome update
      // fails, surface the stored `sending` state; it ages to `unknown` instead
      // of falsely claiming the email was delivered or failed.
    }
    return jsonResponse(
      {
        invitation,
        delivery: invitation.delivery,
        replayed: false,
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
