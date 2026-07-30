import { createSamlMetadata } from "../../../../../lib/saml-authn-request";
import { samlServiceProviderMetadata } from "../../../../../lib/hosted-saml-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const metadata = samlServiceProviderMetadata(request);
    return new Response(createSamlMetadata(metadata.spEntityId, metadata.acsUrl), {
      status: 200,
      headers: {
        "cache-control": "public, max-age=300",
        "content-type": "application/samlmetadata+xml; charset=utf-8",
      },
    });
  } catch {
    return new Response("Enterprise SAML metadata is unavailable", {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
}
