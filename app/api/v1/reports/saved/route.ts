import { SavedReportRepository } from "../../../../../db/saved-report-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// A saved view is a small declarative definition — filters, columns, an
// optional sort and limit. Anything larger is not a real report definition.
const MAX_BODY_BYTES = 32 * 1024;
const SAVED_REPORT_ID = /^rpt_[a-f0-9]{32}$/u;

/**
 * Resolve the tenant scope from the explicitly selected connection.
 */
async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request, "connection:read");
    const repository = new SavedReportRepository();
    return jsonResponse({ reports: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The saved-report request is invalid"), { code: "INVALID_INPUT" });
    }
    const { name, definition } = body as { name?: unknown; definition?: unknown };
    if (typeof name !== "string") {
      throw Object.assign(new Error("The saved-report request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request, "connection:manage");
    const repository = new SavedReportRepository();
    const saved = await repository.save(scope, name, definition, authenticated.subject.userId);
    return jsonResponse({ saved, reports: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!SAVED_REPORT_ID.test(id)) {
      throw Object.assign(new Error("The saved-report request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new SavedReportRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, reports: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
