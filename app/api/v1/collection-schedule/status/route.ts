import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { authorize } from "../../../../../lib/auth-policy";
import { evaluateSchedules } from "../../../../../lib/collection-schedule";
import { buildCollectionScheduleInputs } from "../../../../../lib/collection-schedule-inputs";
import type { LocalFixtureDescriptor } from "../../../../../lib/local-ops-types";
import { reconcileLocalScheduleMutations } from "../../../../../lib/local-schedule-api";
import {
  errorResponse,
  getLocalFixtureCatalog,
  getLocalFixtureSchedules,
  jsonResponse,
  localFixtureScheduleId,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function invalid(): never {
  throw Object.assign(new Error("The collection schedule status request is invalid"), {
    code: "INVALID_INPUT",
  });
}

// Same tenant gate the Operations schedules route uses: the caller must be an
// authenticated session with workspace:read, and only fixtures owned by the
// session's org for which the subject additionally holds connection:read are
// evaluated. Tenant identity comes from the session, never from the caller.
function visibleFixtures(
  catalog: readonly LocalFixtureDescriptor[],
  authenticated: Awaited<ReturnType<typeof requireApiSession>>,
): readonly LocalFixtureDescriptor[] {
  return catalog.filter((fixture) =>
    fixture.tenantId === authenticated.subject.orgId &&
    authorize(authenticated.subject, {
      orgId: authenticated.subject.orgId,
      capability: "connection:read",
      customerId: fixture.customerId,
    }).allowed);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length !== 0) invalid();

    const catalog = await getLocalFixtureCatalog();
    await reconcileLocalScheduleMutations(catalog);
    const fixtures = visibleFixtures(catalog, authenticated);
    const scoped = await Promise.all(fixtures.map(async (fixture) => {
      const expectedScheduleId = await localFixtureScheduleId(fixture.tenantId, fixture.fixtureId);
      const schedules = await getLocalFixtureSchedules(fixture);
      if (schedules.some((schedule) => schedule.scheduleId !== expectedScheduleId)) {
        throw Object.assign(new Error("The collector returned an unmanaged schedule identity"), {
          code: "INVALID_STATE",
        });
      }
      return schedules;
    }));
    const schedules = scoped.flat().sort((left, right) =>
      left.customerId.localeCompare(right.customerId) || left.scheduleId.localeCompare(right.scheduleId));

    // now is captured server-side and passed into the engine, which reads no
    // wall clock itself. An empty configured set flows through as an explicit
    // total:0 evaluation rather than being treated as "no schedules due".
    const inputs = buildCollectionScheduleInputs(schedules, Date.now());
    return jsonResponse(evaluateSchedules(inputs.schedules, inputs.nowMinutes));
  } catch (error) {
    return errorResponse(error);
  }
}
