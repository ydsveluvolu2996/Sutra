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

export const dynamic = "force-dynamic";

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
  try {
    const transactionKey = hostedOidcTransactionKey(request);
    const sealed = requestCookie(request, OIDC_TRANSACTION_COOKIE);
    if (sealed === null) throw new Error("OIDC transaction is missing");
    const transaction = await openOidcTransaction(sealed, transactionKey);
    // Bind the whole callback to the SEALED provider only. A token minted by a
    // different federated provider can never satisfy this transaction because
    // the issuer/audience/JWKS below all come from this provider's pinned config.
    const provider = resolveHostedOidcProvider(request, transaction.provider);
    const code = validateOidcCallback(request.url, transaction);
    const idToken = await exchangeOidcAuthorizationCode(
      provider.client,
      code,
      transaction.codeVerifier,
    );
    const jwks = await fetchOidcJwks(provider.client);
    const identity = await verifyOidcIdToken(idToken, {
      issuer: provider.client.issuer,
      clientId: provider.client.clientId,
      nonce: transaction.nonce,
      jwks,
    });
    const result = transaction.invitationToken === null
      ? await resolveHostedSession(identity, request)
      : await acceptIdentityInvitation(identity, transaction.invitationToken);
    const maximumAgeSeconds = Math.max(
      1,
      Math.floor((new Date(result.session.session.expiresAt).getTime() - Date.now()) / 1000),
    );
    const headers = new Headers({
      "cache-control": "no-store",
      location: transaction.returnTo,
    });
    headers.append("set-cookie", expiredOidcTransactionCookie());
    headers.append("set-cookie", sessionCookie(request, result.token, maximumAgeSeconds));
    return new Response(null, { status: 302, headers });
  } catch {
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
