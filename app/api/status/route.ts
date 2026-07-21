import { UptimeRepository } from "../../../db/uptime-repository";
import { errorResponse, jsonResponse } from "../../../lib/pilot-server";

export const dynamic = "force-dynamic";

/**
 * Public status feed for the /status page. Deliberately unauthenticated to
 * match the page itself (a public trust page rendered without AppShell), and it
 * exposes only derived platform health — never tenant data, configuration, or
 * dependency internals. The computation is entirely evidence-honest: components
 * with no recorded probe come back "unknown", and uptime % is null for any
 * window with no samples (see lib/uptime-status.ts).
 */
export async function GET(): Promise<Response> {
  try {
    const report = await new UptimeRepository().summarize();
    return jsonResponse(report);
  } catch (error) {
    return errorResponse(error);
  }
}
