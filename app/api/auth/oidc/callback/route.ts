import { loginHostedUser } from "../../../../../db/auth-repository";
import { acceptIdentityInvitation } from "../../../../../db/identity-invitation-repository";
import { sessionCookie } from "../../../../../lib/api-auth";
import { exchangeOidcAuthorizationCode, fetchOidcJwks } from "../../../../../lib/hosted-oidc";
import {
  expiredOidcTransactionCookie,
  hostedOidcRuntimeConfiguration,
  OIDC_TRANSACTION_COOKIE,
  requestCookie,
} from "../../../../../lib/hosted-oidc-runtime";
import { verifyOidcIdToken } from "../../../../../lib/oidc-id-token";
import { openOidcTransaction, validateOidcCallback } from "../../../../../lib/oidc-pkce";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = hostedOidcRuntimeConfiguration(request);
    const sealed = requestCookie(request, OIDC_TRANSACTION_COOKIE);
    if (sealed === null) throw new Error("OIDC transaction is missing");
    const transaction = await openOidcTransaction(sealed, runtime.transactionKey);
    const code = validateOidcCallback(request.url, transaction);
    const idToken = await exchangeOidcAuthorizationCode(
      runtime.client,
      code,
      transaction.codeVerifier,
    );
    const jwks = await fetchOidcJwks(runtime.client);
    const identity = await verifyOidcIdToken(idToken, {
      issuer: runtime.client.issuer,
      clientId: runtime.client.clientId,
      nonce: transaction.nonce,
      jwks,
    });
    const result = transaction.invitationToken === null
      ? await loginHostedUser(identity)
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
