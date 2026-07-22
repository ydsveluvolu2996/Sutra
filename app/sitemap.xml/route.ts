import { sitemapXml } from "../../lib/site-seo.ts";

export function GET(): Response {
  return new Response(sitemapXml(), {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
