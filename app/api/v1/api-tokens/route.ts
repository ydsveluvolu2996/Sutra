import { ApiTokenRepository } from "../../../../db/api-token-repository";
import { requireConnectionScope } from "../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const TOKEN_ID = /^pat_[a-f0-9]{32}$/u;

async function resolveScope(request: Request) {
  return requireConnectionScope(request, "connection:manage");
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope } = await resolveScope(request);
    const repository = new ApiTokenRepository();
    return jsonResponse({ tokens: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null) {
      throw Object.assign(new Error("The token request is invalid"), { code: "INVALID_INPUT" });
    }
    const { name, scopes, expiresAt } = body as { name?: unknown; scopes?: unknown; expiresAt?: unknown };
    if (
      typeof name !== "string" || !Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string") ||
      (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== "string")
    ) {
      throw Object.assign(new Error("The token request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request);
    const repository = new ApiTokenRepository();
    const minted = await repository.mint(scope, name, scopes as string[], expiresAt ?? null, authenticated.subject.userId);
    // The full secret appears in this response and nowhere else, ever.
    return jsonResponse({ minted, tokens: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!TOKEN_ID.test(id)) {
      throw Object.assign(new Error("The token request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveScope(request);
    const repository = new ApiTokenRepository();
    const revoked = await repository.revoke(scope, id);
    return jsonResponse({ revoked, tokens: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
