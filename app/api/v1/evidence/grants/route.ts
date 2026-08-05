import { EvidenceRepository, type EvidenceDownloadPurpose } from "../../../../../db/evidence-repository";
import { appendAuditEvent } from "../../../../../db/pilot-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function parseBody(value: unknown): {
  readonly objectId: string;
  readonly purpose: EvidenceDownloadPurpose;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "objectId,purpose"
  ) {
    throw Object.assign(new Error("The evidence grant request is invalid"), { code: "INVALID_INPUT" });
  }
  const body = value as { objectId?: unknown; purpose?: unknown };
  if (
    typeof body.objectId !== "string" ||
    !/^eobj_[a-f0-9]{32}$/u.test(body.objectId) ||
    (body.purpose !== "raw_evidence_review" && body.purpose !== "export_download")
  ) {
    throw Object.assign(new Error("The evidence grant request is invalid"), { code: "INVALID_INPUT" });
  }
  return { objectId: body.objectId, purpose: body.purpose };
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { authenticated, scope, connection } =
      await requireConnectionScope(request, "export:read");
    const body = parseBody(await readBoundedJson(request, 2_048));
    const grant = await new EvidenceRepository().issueGrant({
      scope: { ...scope, connectionId: connection.id },
      objectId: body.objectId,
      actorId: authenticated.subject.userId,
      purpose: body.purpose,
    });
    // The bearer token is intentionally absent from every audit event. It is
    // returned once over the authenticated response and only its digest exists
    // at rest.
    await appendAuditEvent({
      orgId: scope.orgId,
      actorId: authenticated.subject.userId,
      action: "evidence.download_grant.issued",
      targetType: "evidence_object",
      targetId: body.objectId,
      customerId: scope.customerId,
      outcome: "allowed",
      metadata: { purpose: body.purpose, connectionId: connection.id },
    });
    return jsonResponse({
      ...grant,
      download: { method: "POST", path: "/api/v1/evidence/download" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
