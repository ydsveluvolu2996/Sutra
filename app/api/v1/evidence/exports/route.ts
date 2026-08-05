import { EvidenceRepository } from "../../../../../db/evidence-repository";
import { appendAuditEvent, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { buildEvidenceExport, type EvidenceExportFormat } from "../../../../../lib/evidence-export";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function parseFormat(value: unknown): EvidenceExportFormat {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "format"
  ) {
    throw Object.assign(new Error("The managed export request is invalid"), { code: "INVALID_INPUT" });
  }
  const format = (value as { format?: unknown }).format;
  if (format !== "json" && format !== "csv") {
    throw Object.assign(new Error("The managed export request is invalid"), { code: "INVALID_INPUT" });
  }
  return format;
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { authenticated, scope, connection } =
      await requireConnectionScope(request, "export:read");
    const format = parseFormat(await readBoundedJson(request, 1_024));
    const state = await getPilotStateForOrg(scope.orgId, connection.id);
    if (state.connection === null || state.connection.customerId !== scope.customerId) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    const exportedAt = new Date().toISOString();
    const artifact = buildEvidenceExport(state, format, exportedAt);
    const runId = `export_${crypto.randomUUID().replaceAll("-", "")}`;
    const repository = new EvidenceRepository();
    const object = await repository.archive({
      scope: { ...scope, connectionId: connection.id },
      runId,
      snapshotId: state.activeSnapshot?.id ?? null,
      artifactKind: artifact.artifactKind,
      contentType: artifact.contentType,
      body: artifact.body,
      createdBy: authenticated.subject.userId,
    });
    const grant = await repository.issueGrant({
      scope: { ...scope, connectionId: connection.id },
      objectId: object.id,
      actorId: authenticated.subject.userId,
      purpose: "export_download",
    });
    await appendAuditEvent({
      orgId: scope.orgId,
      actorId: authenticated.subject.userId,
      action: "evidence.export.archived",
      targetType: "evidence_object",
      targetId: object.id,
      customerId: scope.customerId,
      outcome: "allowed",
      metadata: {
        format,
        connectionId: connection.id,
        contentSha256: object.contentSha256,
        byteSize: object.byteSize,
      },
    });
    return jsonResponse({
      exportedAt,
      object,
      grant,
      download: { method: "POST", path: "/api/v1/evidence/download" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
