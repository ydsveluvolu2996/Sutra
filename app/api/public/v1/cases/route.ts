import { getLatestConnectionForCustomer } from "../../../../../db/pilot-repository";
import { listFindingCases } from "../../../../../db/case-repository";
import { ApiTokenRepository } from "../../../../../db/api-token-repository";
import { authenticatePublicRequest, decodeCursor, paginate, parsePageSize, publicCursorContext, publicError, publicJson, PublicApiError } from "../../../../../lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const token = await authenticatePublicRequest(request, "read:cases", new ApiTokenRepository());
    const url = new URL(request.url);
    const cursorContext = publicCursorContext(request, token, "cases");
    const offset = await decodeCursor(url.searchParams.get("cursor"), cursorContext);
    const limit = parsePageSize(url.searchParams.get("limit"));
    const connection = await getLatestConnectionForCustomer(token.orgId, token.customerId);
    if (connection === null) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    const cases = await listFindingCases({ orgId: token.orgId, customerId: token.customerId, connectionId: connection.id });
    const { page, nextCursor } = await paginate(cases, offset, limit, cursorContext);
    return publicJson(page, { nextCursor });
  } catch (error) {
    return publicError(error);
  }
}
