import { headers } from "next/headers";

import { PUBLIC_SITE_STRUCTURED_DATA } from "../../lib/site-seo";

function scriptNonce(csp: string | null): string | undefined {
  if (csp === null) return undefined;
  return /'nonce-([A-Za-z0-9+/=_-]+)'/u.exec(csp)?.[1];
}
function serializedStructuredData(): string {
  // JSON-LD is fixed product metadata, but escaping '<' also prevents a future
  // text edit from being interpreted as an HTML script terminator.
  return JSON.stringify(PUBLIC_SITE_STRUCTURED_DATA).replaceAll("<", "\\u003c");
}

export default async function PublicStructuredData() {
  const requestHeaders = await headers();
  return (
    <script
      id="sutra-public-structured-data"
      nonce={scriptNonce(requestHeaders.get("content-security-policy"))}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializedStructuredData() }}
    />
  );
}
