import { getConnection, getPilotState } from "../../../../db/pilot-repository";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../lib/api-auth";

export const dynamic = "force-dynamic";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    const url = new URL(request.url);
    const format = url.searchParams.get("format") ?? "json";
    const connectionId = url.searchParams.get("connectionId");
    if (
      (format !== "json" && format !== "csv") ||
      (connectionId !== null && !/^conn_[a-f0-9]{32}$/u.test(connectionId)) ||
      [...url.searchParams.keys()].some((key) => key !== "format" && key !== "connectionId")
    ) {
      throw Object.assign(new Error("Choose json or csv export format"), { code: "INVALID_INPUT" });
    }
    if (connectionId !== null) {
      const connection = await getConnection(connectionId);
      if (connection === null) {
        throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
      }
      assertSessionCapability(actor.authenticated, "export:read", connection.customerId);
    }
    const state = await getPilotState(connectionId ?? undefined);
    if (state.connection !== null) {
      assertSessionCapability(actor.authenticated, "export:read", state.connection.customerId);
    }
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    if (format === "json") {
      const response = jsonResponse({ exportedAt: new Date().toISOString(), state });
      response.headers.set("content-disposition", `attachment; filename="sutra-cmdb-${timestamp}.json"`);
      return response;
    }
    const header = [
      "resource_key", "service", "resource_type", "native_id", "arn", "name", "region", "state",
      "account_id", "collected_at", "content_sha256", "snapshot_id", "origin_kind", "fixture_id", "fixture_version",
    ];
    const rows = state.resources.map((resource) => [
      resource.resourceKey,
      resource.service,
      resource.resourceType,
      resource.nativeId,
      resource.arn,
      resource.name,
      resource.region,
      resource.state,
      resource.source.accountId,
      resource.source.collectedAt,
      resource.contentSha256,
      state.activeSnapshot?.id,
      state.activeSnapshot?.origin.kind,
      state.activeSnapshot?.origin.fixtureId,
      state.activeSnapshot?.origin.fixtureVersion,
    ]);
    const csv = `${header.map(csvCell).join(",")}\r\n${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="sutra-cmdb-${timestamp}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
