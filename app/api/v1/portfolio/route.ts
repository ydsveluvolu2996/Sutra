import { getPortfolio } from "../../../../db/portfolio-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { portfolioForRuntime } from "../../../../lib/portfolio-presentation";
import { errorResponse, isLocalSimulationRuntime, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    const portfolio = await getPortfolio(authenticated.subject);
    return jsonResponse({
      portfolio: portfolioForRuntime(portfolio, isLocalSimulationRuntime()),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
