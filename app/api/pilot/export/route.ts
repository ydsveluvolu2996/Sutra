import { getPilotState } from "../../../../db/pilot-repository";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    requirePilotActor(request);
    const format = new URL(request.url).searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "csv") {
      throw Object.assign(new Error("Choose json or csv export format"), { code: "INVALID_INPUT" });
    }
    const state = await getPilotState();
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    if (format === "json") {
      const response = jsonResponse({ exportedAt: new Date().toISOString(), state });
      response.headers.set("content-disposition", `attachment; filename="sutra-cmdb-${timestamp}.json"`);
      return response;
    }
    const header = [
      "resource_key", "service", "resource_type", "native_id", "arn", "name", "region", "state",
      "account_id", "collected_at", "content_sha256",
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
