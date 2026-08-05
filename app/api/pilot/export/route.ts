import { getConnectionForOrg, getPilotStateForOrg } from "../../../../db/pilot-repository";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../lib/api-auth";
import { safeCsvCell } from "../../../../lib/safe-csv";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    if (
      process.env.SUTRA_DEPLOYMENT_ENV === "production" ||
      process.env.SUTRA_HOSTED_ENABLED === "true"
    ) {
      throw Object.assign(
        new Error("Use the managed evidence export workflow"),
        { code: "INVALID_STATE" },
      );
    }
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
      const connection = await getConnectionForOrg(actor.orgId, connectionId);
      if (connection === null) {
        throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
      }
      assertSessionCapability(actor.authenticated, "export:read", connection.customerId);
    }
    const state = await getPilotStateForOrg(actor.orgId, connectionId ?? undefined);
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
      "lifecycle_state", "consecutive_complete_misses", "account_id", "collected_at",
      "content_sha256", "evidence_snapshot_id", "evidence_snapshot_sha256",
      "active_snapshot_id", "origin_kind", "fixture_id", "fixture_version",
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
      resource.lifecycleState ?? "active",
      resource.consecutiveCompleteMisses ?? 0,
      resource.source.accountId,
      resource.source.collectedAt,
      resource.contentSha256,
      resource.evidenceSnapshot?.id,
      resource.evidenceSnapshot?.snapshotSha256,
      state.activeSnapshot?.id,
      state.activeSnapshot?.origin.kind,
      state.activeSnapshot?.origin.fixtureId,
      state.activeSnapshot?.origin.fixtureVersion,
    ]);
    const csv = `${header.map(safeCsvCell).join(",")}\r\n${rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}\r\n`;
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
