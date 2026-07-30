import { getLatestConnectionForCustomer, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, decodeCursor, paginate, parsePageSize, publicCursorContext, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:findings", new ApiTokenRepository());
    const url = new URL(request.url);
    const cursorContext = publicCursorContext(request, token, "findings");
    const offset = await decodeCursor(url.searchParams.get("cursor"), cursorContext);
    const limit = parsePageSize(url.searchParams.get("limit"));
    const connection = await getLatestConnectionForCustomer(token.orgId, token.customerId);
    if (connection === null) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const state = await getPilotStateForOrg(token.orgId, connection.id);
    const { page, nextCursor } = await paginate(state.findings, offset, limit, cursorContext);
    return publicJson(page, { nextCursor });
  } catch (error) {
    return publicError(error);
  }
}
