import { env } from "cloudflare:workers";
import {
  LocalAuthError,
  loginHostedUser,
  provisionSelfServeHostedOrg,
  type HostedIdentity,
} from "../../../../../db/auth-repository";
import { acceptIdentityInvitation } from "../../../../../db/identity-invitation-repository";
import { sessionCookie } from "../../../../../lib/api-auth";
import { exchangeOidcAuthorizationCode, fetchOidcJwks } from "../../../../../lib/hosted-oidc";
import {
  expiredOidcTransactionCookie,
  hostedOidcTransactionKey,
  hostedSignupAllowedDomains,
  hostedSignupSourceKey,
  isHostedSelfServeSignupEnabled,
  OIDC_TRANSACTION_COOKIE,
  requestCookie,
  resolveHostedOidcProvider,
} from "../../../../../lib/hosted-oidc-runtime";
import { verifyOidcIdToken } from "../../../../../lib/oidc-id-token";
import { openOidcTransaction, validateOidcCallback } from "../../../../../lib/oidc-pkce";
import type { ManagedOutboundEnvironment } from "../../../../../lib/managed-outbound-fetch";

export const dynamic = "force-dynamic";

type OidcCallbackStage =
  | "runtime"
  | "transaction_cookie"
  | "transaction_open"
  | "provider_resolve"
  | "callback_validate"
  | "code_exchange"
  | "jwks_fetch"
  | "id_token_verify"
  | "session_resolve";

function reportOidcCallbackFailure(
  stage: OidcCallbackStage,
  providerId: string | null,
  error: unknown,
): void {
  // Log only bounded enums already owned by Sutra. Never include request URLs,
  // authorization codes, sealed cookies, tokens, identity claims, or exception
  // messages: any of those could contain credentials or personal data.
  console.error(JSON.stringify({
    event: "sutra.oidc.callback.failed",
    stage,
    providerId: providerId ?? "unknown",
    failureCode: error instanceof LocalAuthError ? error.code : "UNEXPECTED",
  }));
}

/**
 * Resolve a session for a verified identity that presented NO invitation.
 *
 * Default (invite-only) behaviour is unchanged: loginHostedUser only issues a
 * session for an identity already provisioned into exactly one active org, and
 * refuses everything else. Self-serve org creation is attempted ONLY when the
 * separate SUTRA_HOSTED_SELF_SERVE_SIGNUP switch is on AND the identity has no
 * membership at all; provisionSelfServeHostedOrg itself re-checks that the
 * (issuer, subject) pair is brand new and never joins an existing org.
 */
async function resolveHostedSession(
  identity: HostedIdentity,
  request: Request,
): ReturnType<typeof loginHostedUser> {
  try {
    return await loginHostedUser(identity);
  } catch (error) {
    if (
      error instanceof LocalAuthError &&
      error.code === "IDENTITY_NOT_PROVISIONED" &&
      isHostedSelfServeSignupEnabled()
    ) {
      // Self-serve abuse controls (INFO-2) apply ONLY here, on the create-new-org
      // path: a per-source-IP rate limit keyed on the trusted edge IP, and an
      // OPTIONAL verified-email domain allowlist. Neither touches invited-join or
      // an existing-identity login.
      return await provisionSelfServeHostedOrg(identity, {
        sourceKey: hostedSignupSourceKey(request),
        allowedEmailDomains: hostedSignupAllowedDomains(),
      });
    }
    throw error;
  }
}

export async function GET(request: Request): Promise<Response> {
  let stage: OidcCallbackStage = "runtime";
  let providerId: string | null = null;
  try {
    const transactionKey = hostedOidcTransactionKey(request);
    stage = "transaction_cookie";
    const sealed = requestCookie(request, OIDC_TRANSACTION_COOKIE);
    if (sealed === null) throw new Error("OIDC transaction is missing");
    stage = "transaction_open";
    const transaction = await openOidcTransaction(sealed, transactionKey);
    providerId = transaction.provider;
    // Bind the whole callback to the SEALED provider only. A token minted by a
    // different federated provider can never satisfy this transaction because
    // the issuer/audience/JWKS below all come from this provider's pinned config.
    stage = "provider_resolve";
    const provider = resolveHostedOidcProvider(request, transaction.provider);
    stage = "callback_validate";
    const code = validateOidcCallback(request.url, transaction);
    stage = "code_exchange";
    const idToken = await exchangeOidcAuthorizationCode(
      provider.client,
      code,
      transaction.codeVerifier,
      undefined,
      env as unknown as ManagedOutboundEnvironment,
    );
    stage = "jwks_fetch";
    const jwks = await fetchOidcJwks(
      provider.client,
      undefined,
      env as unknown as ManagedOutboundEnvironment,
    );
    stage = "id_token_verify";
    const identity = await verifyOidcIdToken(idToken, {
      issuer: provider.client.issuer,
      clientId: provider.client.clientId,
      nonce: transaction.nonce,
      jwks,
    });
    stage = "session_resolve";
    const result = transaction.invitationToken === null
      ? await resolveHostedSession(identity, request)
      : await acceptIdentityInvitation(identity, transaction.invitationToken);
    const headers = new Headers({
      "cache-control": "no-store",
      location: transaction.returnTo,
    });
    headers.append("set-cookie", expiredOidcTransactionCookie());
    headers.append("set-cookie", sessionCookie(request, result.token));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    reportOidcCallbackFailure(stage, providerId, error);
    return Response.json(
      { error: { code: "AUTH_REQUEST_FAILED", message: "Sutra could not complete hosted sign-in" } },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          "set-cookie": expiredOidcTransactionCookie(),
        },
      },
    );
  }
}
