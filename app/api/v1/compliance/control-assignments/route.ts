import { ComplianceWorkspaceRepository } from "../../../../../db/compliance-workspace-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request, "connection:read");
    const repository = new ComplianceWorkspaceRepository();
    return jsonResponse({ assignments: await repository.listControlAssignments(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The control-assignment request is invalid"), { code: "INVALID_INPUT" });
    }
    const { controlId, ownerTeam, ownerEmail } = body as { controlId?: unknown; ownerTeam?: unknown; ownerEmail?: unknown };
    if (
      typeof controlId !== "string" ||
      (ownerTeam !== undefined && ownerTeam !== null && typeof ownerTeam !== "string") ||
      (ownerEmail !== undefined && ownerEmail !== null && typeof ownerEmail !== "string")
    ) {
      throw Object.assign(new Error("The control-assignment request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request, "connection:manage");
    const repository = new ComplianceWorkspaceRepository();
    await repository.assignControlOwner(scope, controlId, ownerTeam ?? null, ownerEmail ?? null, authenticated.subject.userId);
    return jsonResponse({ assignments: await repository.listControlAssignments(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
