import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const BUDGET_ID = /^fb_[a-f0-9]{32}$/u;

async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request, "connection:read");
    const repository = new FinopsWorkspaceRepository();
    return jsonResponse({ budgets: await repository.listBudgets(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The budget request is invalid"), { code: "INVALID_INPUT" });
    }
    const { name, currency, limitMicros, filter } = body as { name?: unknown; currency?: unknown; limitMicros?: unknown; filter?: unknown };
    if (typeof name !== "string" || typeof currency !== "string" || typeof limitMicros !== "string") {
      throw Object.assign(new Error("The budget request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request, "connection:manage");
    const repository = new FinopsWorkspaceRepository();
    const saved = await repository.saveBudget(
      scope,
      { name, currency, limitMicros, filter: filter as undefined },
      authenticated.subject.userId,
    );
    return jsonResponse({ saved, budgets: await repository.listBudgets(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!BUDGET_ID.test(id)) {
      throw Object.assign(new Error("The budget request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new FinopsWorkspaceRepository();
    const deleted = await repository.deleteBudget(scope, id);
    return jsonResponse({ deleted, budgets: await repository.listBudgets(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
