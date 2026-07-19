import { createOidcAuthorization, sealOidcTransaction } from "../../../../../lib/oidc-pkce";
import {
  hostedOidcRuntimeConfiguration,
  oidcTransactionCookie,
} from "../../../../../lib/hosted-oidc-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const runtime = hostedOidcRuntimeConfiguration(request);
    const parameters = new URL(request.url).searchParams;
    const authorization = await createOidcAuthorization(
      runtime.client,
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
