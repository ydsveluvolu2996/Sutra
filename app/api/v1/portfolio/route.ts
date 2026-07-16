import { getPortfolio } from "../../../../db/portfolio-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    return jsonResponse({ portfolio: await getPortfolio(authenticated.subject) });
  } catch (error) {
    return errorResponse(error);
  }
}
