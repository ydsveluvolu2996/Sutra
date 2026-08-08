import {
  chooseOnboardingGoals,
  getOnboardingProgress,
  OnboardingError,
  shareWorkspaceName,
} from "../../../../db/onboarding-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    return jsonResponse({ onboarding: await getOnboardingProgress(authenticated.subject) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Records one onboarding choice: `{ goals: [...] }` or `{ workspaceName: "..." }`.
 *
 * Gated on `connection:manage` -- the same operator capability the flow's final
 * step requires -- so a viewer can see the strip but only a workspace operator
 * can steer it. Goals are a lens, never a permission.
 */
export async function PATCH(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:manage");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OnboardingError(400, "The request body must be JSON");
    }
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const hasGoals = "goals" in record;
    const hasName = "workspaceName" in record;
    if (hasGoals === hasName) {
      throw new OnboardingError(400, "Send exactly one of goals or workspaceName");
    }
    const onboarding = hasGoals
      ? await chooseOnboardingGoals(authenticated.subject, record.goals as readonly string[])
      : await shareWorkspaceName(authenticated.subject, record.workspaceName as string);
    return jsonResponse({ onboarding });
  } catch (error) {
    if (error instanceof OnboardingError) {
      return jsonResponse(
        { error: { code: "ONBOARDING_INVALID", message: error.message } },
        { status: error.status },
      );
    }
    return errorResponse(error);
  }
}
