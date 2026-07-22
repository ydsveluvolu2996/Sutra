import { robotsText } from "../../lib/site-seo.ts";

export function GET(): Response {
  return new Response(robotsText(), {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
