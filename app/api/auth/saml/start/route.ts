import { createSamlAuthorizationUrl } from "../../../../../lib/saml-authn-request";
import {
  resolveDefaultHostedSamlProvider,
  resolveHostedSamlProvider,
  samlTransactionCookie,
} from "../../../../../lib/hosted-saml-runtime";
import { createSamlTransaction, sealSamlTransaction } from "../../../../../lib/saml-transaction";

export const dynamic = "force-dynamic";
const PROVIDER = /^[a-z][a-z0-9_-]{1,31}$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const parameters = new URL(request.url).searchParams;
    const providerId = parameters.get("provider");
    if (providerId !== null && !PROVIDER.test(providerId)) throw new Error("SAML provider is invalid");
    const resolved = providerId === null
      ? resolveDefaultHostedSamlProvider(request)
      : resolveHostedSamlProvider(request, providerId);
    const transaction = createSamlTransaction(
      resolved.provider.id,
      parameters.get("returnTo"),
      parameters.get("invitation"),
    );
    const sealed = await sealSamlTransaction(transaction, resolved.transactionKey);
    return new Response(null, {
      status: 302,
      headers: {
        "cache-control": "no-store",
        location: createSamlAuthorizationUrl(
          resolved.provider,
          transaction,
          resolved.spEntityId,
          resolved.acsUrl,
        ),
        "set-cookie": samlTransactionCookie(sealed),
      },
    });
  } catch {
    return Response.json(
      { error: { code: "AUTH_REQUEST_FAILED", message: "Enterprise SAML sign-in is unavailable" } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
