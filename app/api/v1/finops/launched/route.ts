import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { buildLaunchedResources } from "../../../../../lib/finops-launched";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const WINDOWS = ["today", "24h", "7d", "30d"] as const;
type LaunchedWindow = (typeof WINDOWS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Window-start epoch (ms). The route owns the clock; the engine and repo stay pure. */
function windowStartMs(window: LaunchedWindow, now: number): number {
  switch (window) {
    case "today": {
      const date = new Date(now);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    }
    case "24h":
      return now - DAY_MS;
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const rawWindow = url.searchParams.get("window") ?? "7d";
    if (
      !CONNECTION_ID.test(connectionId) ||
      !(WINDOWS as readonly string[]).includes(rawWindow) ||
      [...url.searchParams.keys()].some((key) => key !== "connectionId" && key !== "window")
    ) {
      throw Object.assign(new Error("The launched-resources request is invalid"), { code: "INVALID_INPUT" });
    }
    const window = rawWindow as LaunchedWindow;
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    const now = Date.now();
    const startMs = windowStartMs(window, now);
    const repository = new CmdbWorkspaceRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const HARD_LIMIT = 500;
    const events = await repository.listRecentlyAddedResources(scope, connectionId, startMs, HARD_LIMIT);
    const resources = buildLaunchedResources(events);
    return jsonResponse({
      window,
      generatedAt: new Date(now).toISOString(),
      resources,
      truncated: events.length >= HARD_LIMIT,
      note:
        "Resources newly observed by Sutra between snapshots within the selected window; " +
        "launch time is shown where the provider reports it, otherwise the first-observed time is used.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
