import { env } from "cloudflare:workers";

import {
  beginIdentityInvitationDelivery,
  completeIdentityInvitationDelivery,
} from "../../../../../../db/identity-invitation-repository";
import { requireRecentMfa } from "../../../../../../db/auth-repository";
import { authorizeMembershipManagementRequest, isHostedOidcRuntime } from "../../../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  exactInputObject,
  readAuthJson,
} from "../../../../../../lib/auth-http";
import {
  deliverInvitationEmail,
  type InvitationDeliveryEnv,
} from "../../../../../../lib/invitation-delivery";
import { jsonResponse } from "../../../../../../lib/pilot-server";

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
    // The delivery adapter reports EMAIL_NOT_CONFIGURED/INVALID; retaining the
    // request URL here preserves the existing one-time manual-copy fallback.
  }
  return requestUrl;
}

function activationUrl(request: Request, token: string, deliveryEnv: InvitationDeliveryEnv): URL {
  const base = activationBase(request.url, deliveryEnv.SUTRA_PUBLIC_ORIGIN);
  if (isHostedOidcRuntime()) {
    const url = new URL("/api/auth/oidc/start", base);
    url.searchParams.set("invitation", token);
    url.searchParams.set("returnTo", "/dashboard");
    return url;
  }
  const url = new URL("/accept-invite", base);
  url.searchParams.set("token", token);
  return url;
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly invitationId: string }> },
): Promise<Response> {
  try {
    assertAuthMutation(request);
    const { actor, scope } = await authorizeMembershipManagementRequest(request);
    requireRecentMfa(actor.authenticated);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const body = exactInputObject(await readAuthJson(request, 1024), ["lifetimeHours"]);
    if (typeof body.lifetimeHours !== "number" || !Number.isSafeInteger(body.lifetimeHours)) {
      throw Object.assign(new Error("The invitation lifetime is invalid"), { code: "INVALID_INPUT" });
    }
    const { invitationId } = await context.params;
    const begun = await beginIdentityInvitationDelivery(actor.authenticated, scope, {
      invitationId,
      idempotencyKey,
      rotateToken: true,
      lifetimeMs: body.lifetimeHours * 60 * 60 * 1000,
    });
    if (begun.replayed || begun.token === null) {
      return jsonResponse({
        invitation: begun.invitation,
        delivery: begun.invitation.delivery,
        replayed: true,
        activationUrlShownOnce: false,
      }, { headers: { "cache-control": "no-store" } });
    }

    const deliveryEnv = env as unknown as InvitationDeliveryEnv;
    const url = activationUrl(request, begun.token, deliveryEnv);
    const outcome = await deliverInvitationEmail({
      recipient: begun.invitation.email,
      activationUrl: url.toString(),
      expiresAt: begun.invitation.expiresAt,
      role: begun.invitation.role,
    }, deliveryEnv);
    let invitation = begun.invitation;
    try {
      invitation = await completeIdentityInvitationDelivery(
        actor.authenticated,
        scope,
        invitationId,
        idempotencyKey,
        outcome,
      );
    } catch {
      // The claim and rotated token digest are durable. Preserve its honest
      // in-flight state; it becomes `unknown` rather than triggering a duplicate.
    }
    return jsonResponse({
      invitation,
      delivery: invitation.delivery,
      replayed: false,
      activationUrl: url.toString(),
      activationUrlShownOnce: true,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
