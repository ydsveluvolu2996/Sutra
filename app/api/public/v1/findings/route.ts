import { getLatestConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, decodeCursor, paginate, parsePageSize, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:findings", new ApiTokenRepository());
    const url = new URL(request.url);
    const offset = decodeCursor(url.searchParams.get("cursor"));
    const limit = parsePageSize(url.searchParams.get("limit"));
    const connection = await getLatestConnectionForOrg(token.orgId);
    if (connection === null || connection.customerId !== token.customerId) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const state = await getPilotStateForOrg(token.orgId, connection.id);
    const { page, nextCursor } = paginate(state.findings, offset, limit);
    return publicJson(page, { nextCursor });
  } catch (error) {
    return publicError(error);
  }
}
