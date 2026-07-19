import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

async function resolveScope(request: Request, connectionId: string, capability: "connection:read" | "connection:manage") {
  if (!CONNECTION_ID.test(connectionId)) {
    throw Object.assign(new Error("The annotation request is invalid"), { code: "INVALID_INPUT" });
  }
  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) {
    throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
  }
  assertSessionCapability(authenticated, capability, connection.customerId);
  return { authenticated, scope: { orgId: authenticated.subject.orgId, customerId: connection.customerId } };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const { scope } = await resolveScope(request, connectionId, "connection:read");
    const repository = new CmdbWorkspaceRepository();
    const annotations = await repository.annotationsForConnection(scope, connectionId);
    return jsonResponse({ connectionId, annotations });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The annotation request is invalid"), { code: "INVALID_INPUT" });
    }
    const { connectionId, annotation } = body as { connectionId?: unknown; annotation?: unknown };
    if (typeof connectionId !== "string" || typeof annotation !== "object" || annotation === null) {
      throw Object.assign(new Error("The annotation request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request, connectionId, "connection:manage");
    const repository = new CmdbWorkspaceRepository();
    await repository.upsertAnnotation(
      scope,
      connectionId,
      annotation as { resourceKey: string },
      authenticated.subject.userId,
    );
    const annotations = await repository.annotationsForConnection(scope, connectionId);
    return jsonResponse({ connectionId, annotations });
  } catch (error) {
    return errorResponse(error);
  }
}
