import { EvidenceRepository, EvidenceRepositoryError } from "../../../../../db/evidence-repository";
import { appendAuditEvent } from "../../../../../db/pilot-repository";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, requirePilotActor, type PilotActor } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const GENERIC_DENIAL = Object.freeze({
  code: "EVIDENCE_GRANT_INVALID",
  message: "Evidence download is unavailable",
});

function generic(status: number): Response {
  return Response.json(GENERIC_DENIAL, {
    status,
    headers: {
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseToken(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "token"
  ) return null;
  const token = (value as { token?: unknown }).token;
  return typeof token === "string" ? token : null;
}

async function authorizedDownload(request: Request, actor: PilotActor): Promise<Response> {
  const repository = new EvidenceRepository();
  const deny = async (): Promise<Response> => {
    // A denial deliberately reveals neither whether the token existed nor
    // which actor/customer/object it was bound to.
    await appendAuditEvent({
      orgId: actor.orgId,
      actorId: actor.id,
      action: "evidence.download.denied",
      targetType: "evidence_grant",
      targetId: null,
      customerId: null,
      outcome: "denied",
      metadata: { generic: true },
    });
    return generic(404);
  };
  let token: string | null;
  try {
    token = parseToken(await readBoundedJson(request, 2_048));
  } catch {
    return await deny();
  }
  if (token === null) return await deny();
  const candidate = await repository.peekGrantScope({
    orgId: actor.orgId,
    actorId: actor.id,
    token,
  });
  if (candidate === null) return await deny();
  try {
    // Re-check the actor's live customer assignment at consumption time. A
    // grant issued before role removal becomes useless immediately.
    assertSessionCapability(actor.authenticated, "export:read", candidate.customerId);
  } catch {
    return await deny();
  }
  const object = await repository.consumeGrant({
    orgId: actor.orgId,
    actorId: actor.id,
    token,
  });
  if (object === null) return await deny();
  try {
    const stored = await repository.readVerified(object);
    await appendAuditEvent({
      orgId: actor.orgId,
      actorId: actor.id,
      action: "evidence.download.completed",
      targetType: "evidence_object",
      targetId: object.id,
      customerId: object.customer_id,
      outcome: "allowed",
      metadata: {
        purpose: candidate.purpose,
        connectionId: object.connection_id,
        contentSha256: object.content_sha256,
        byteSize: Number(object.byte_size),
      },
    });
    const extension = object.artifact_kind === "export_csv"
      ? "csv"
      : object.artifact_kind === "export_json" ? "json" : "bin";
    const responseBody = new Uint8Array(stored.body.byteLength);
    responseBody.set(stored.body);
    return new Response(responseBody.buffer, {
      headers: {
        "content-type": stored.contentType,
        "content-disposition": `attachment; filename="sutra-evidence-${object.id}.${extension}"`,
        "content-length": String(stored.body.byteLength),
        "cache-control": "no-store, private",
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "x-sutra-content-sha256": stored.contentSha256,
      },
    });
  } catch (error) {
    await appendAuditEvent({
      orgId: actor.orgId,
      actorId: actor.id,
      action: "evidence.download.failed",
      targetType: "evidence_object",
      targetId: object.id,
      customerId: object.customer_id,
      outcome: "failed",
      metadata: { generic: true },
    });
    return generic(error instanceof EvidenceRepositoryError ? 503 : 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    return await authorizedDownload(request, actor);
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("cache-control", "no-store, private");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  }
}
