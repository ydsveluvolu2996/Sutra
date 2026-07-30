import { createOidcAuthorization, sealOidcTransaction } from "../../../../../lib/oidc-pkce";
import {
  oidcTransactionCookie,
  resolveDefaultHostedOidcProvider,
  resolveHostedOidcProvider,
} from "../../../../../lib/hosted-oidc-runtime";

export const dynamic = "force-dynamic";

// The caller selects WHICH federated provider to authenticate against with a
// bounded `?provider=` slug (e.g. google, entra). The chosen provider id is
// recorded inside the sealed transaction so the callback can validate the
// returned token strictly against that provider only.
const PROVIDER_PARAM = /^[a-z][a-z0-9_-]{1,31}$/u;

export async function GET(request: Request): Promise<Response> {
  try {
    const parameters = new URL(request.url).searchParams;
    const providerParam = parameters.get("provider");
    if (providerParam !== null && !PROVIDER_PARAM.test(providerParam)) {
      throw new Error("A supported sign-in provider must be selected");
    }
    const runtime = providerParam === null
      ? resolveDefaultHostedOidcProvider(request)
      : resolveHostedOidcProvider(request, providerParam);
    const authorization = await createOidcAuthorization(
      runtime.client,
      runtime.providerId,
      parameters.get("returnTo"),
      Date.now(),
      parameters.get("invitation"),
    );
    const sealed = await sealOidcTransaction(authorization.transaction, runtime.transactionKey);
    return new Response(null, {
      status: 302,
      headers: {
        "cache-control": "no-store",
        location: authorization.url,
        "set-cookie": oidcTransactionCookie(sealed),
      },
    });
  } catch {
    return Response.json(
      { error: { code: "AUTH_REQUEST_FAILED", message: "Hosted sign-in is unavailable" } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
