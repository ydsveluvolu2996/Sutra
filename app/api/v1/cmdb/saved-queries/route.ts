import { CmdbWorkspaceRepository } from "../../../../../db/cmdb-workspace-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const SAVED_QUERY_ID = /^sq_[a-f0-9]{32}$/u;

async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request, "connection:read");
    const repository = new CmdbWorkspaceRepository();
    return jsonResponse({ queries: await repository.listQueries(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The saved-query request is invalid"), { code: "INVALID_INPUT" });
    }
    const { name, description, query } = body as { name?: unknown; description?: unknown; query?: unknown };
    if (typeof name !== "string" || (description !== undefined && description !== null && typeof description !== "string")) {
      throw Object.assign(new Error("The saved-query request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request, "connection:manage");
    const repository = new CmdbWorkspaceRepository();
    const saved = await repository.saveQuery(scope, name, description ?? null, query, authenticated.subject.userId);
    return jsonResponse({ saved, queries: await repository.listQueries(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!SAVED_QUERY_ID.test(id)) {
      throw Object.assign(new Error("The saved-query request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new CmdbWorkspaceRepository();
    const deleted = await repository.deleteQuery(scope, id);
    return jsonResponse({ deleted, queries: await repository.listQueries(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
