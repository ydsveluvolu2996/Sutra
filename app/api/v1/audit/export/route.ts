import { listAuditEventsForOrg } from "../../../../../db/audit-export-repository";
import { appendAuditEvent } from "../../../../../db/pilot-repository";
import { LocalAuthError } from "../../../../../db/auth-repository";
import { requireApiSession } from "../../../../../lib/api-auth";
import { buildVerifiedAuditExport } from "../../../../../lib/audit-export";
import { isOrganizationOwner } from "../../../../../lib/auth-policy";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import { safeCsvCell } from "../../../../../lib/safe-csv";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    if (!isOrganizationOwner(authenticated.subject)) {
      throw new LocalAuthError(
        403,
        "AUTHORIZATION_DENIED",
        "Only an organization owner can export the complete audit chain",
      );
    }
    const url = new URL(request.url);
    const format = url.searchParams.get("format") ?? "json";
    if (
      (format !== "json" && format !== "csv") ||
      [...url.searchParams.keys()].some((key) => key !== "format")
    ) {
      throw Object.assign(new Error("Choose json or csv audit format"), { code: "INVALID_INPUT" });
    }
    const exportedAt = new Date().toISOString();
    await appendAuditEvent({
      orgId: authenticated.subject.orgId,
      actorId: authenticated.subject.userId,
      action: "audit.exported",
      targetType: "organization",
      targetId: authenticated.subject.orgId,
      customerId: null,
      outcome: "allowed",
      requestId: `audit.exported:${crypto.randomUUID()}`,
      metadata: { format },
    });
    const auditExport = await buildVerifiedAuditExport({
      orgId: authenticated.subject.orgId,
      exportedAt,
      events: await listAuditEventsForOrg(authenticated.subject.orgId),
    });
    const filenameTimestamp = exportedAt.replaceAll(":", "-");
    if (format === "json") {
      const response = jsonResponse(auditExport);
      response.headers.set(
        "content-disposition",
        `attachment; filename="sutra-audit-${filenameTimestamp}.json"`,
      );
      return response;
    }
    const header = [
      "event_id", "org_id", "customer_id", "occurred_at", "actor_type", "actor_id",
      "action", "target_type", "target_id", "outcome", "request_id", "metadata_json",
      "previous_event_hash", "event_hash", "hash_version", "export_sha256",
    ];
    const rows = auditExport.events.map((event) => [
      event.eventId,
      event.orgId,
      event.customerId,
      new Date(event.occurredAt).toISOString(),
      event.actorType,
      event.actorId,
      event.action,
      event.targetType,
      event.targetId,
      event.outcome,
      event.requestId,
      event.metadataJson,
      event.previousEventHash,
      event.eventHash,
      event.hashVersion,
      auditExport.exportSha256,
    ]);
    return new Response(
      `${header.map(safeCsvCell).join(",")}\r\n${rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}\r\n`,
      {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="sutra-audit-${filenameTimestamp}.csv"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
