import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import {
  assertLocalSimulationRuntime,
  errorResponse,
  getLocalFixtureCatalog,
  getLocalFixtureSchedules,
  jsonResponse,
  localFixtureScheduleId,
} from "../../../../../lib/pilot-server";
import {
  assertLocalScheduleProvisioningScope,
  localScheduleOperationId,
  persistAndApplyLocalScheduleMutation,
  reconcileLocalScheduleMutations,
} from "../../../../../lib/local-schedule-api";

export const dynamic = "force-dynamic";

function parseToggle(value: unknown): { readonly fixtureId: string; readonly enabled: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "enabled,fixtureId" ||
    typeof record.fixtureId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u.test(record.fixtureId) ||
    typeof record.enabled !== "boolean"
  ) invalid();
  return { fixtureId: record.fixtureId, enabled: record.enabled };
}

function invalid(): never {
  throw Object.assign(new Error("The simulated schedule request is invalid"), { code: "INVALID_INPUT" });
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalSimulationRuntime();
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    assertSameOrigin(request);
    const body = parseToggle(await readBoundedJson(request));
    const catalog = await getLocalFixtureCatalog();
    const fixture = catalog.find((candidate) =>
      candidate.tenantId === authenticated.subject.orgId && candidate.fixtureId === body.fixtureId);
    if (fixture === undefined) {
      throw Object.assign(new Error("The simulated fixture was not found"), { code: "NOT_FOUND" });
    }
    const auditScope = await assertLocalScheduleProvisioningScope(authenticated, fixture, {
      allowInactive: body.enabled === false,
    });
    const scheduleId = await localFixtureScheduleId(fixture.tenantId, fixture.fixtureId);
    await reconcileLocalScheduleMutations(catalog);
    const current = (await getLocalFixtureSchedules(fixture))
      .find((schedule) => schedule.scheduleId === scheduleId);
    if (current === undefined) {
      throw Object.assign(new Error("Configure the simulated schedule before changing its state"), {
        code: "NOT_FOUND",
      });
    }
    const operationId = await localScheduleOperationId(
      authenticated.subject.orgId,
      request.headers.get("idempotency-key") ?? "",
    );
    const schedule = await persistAndApplyLocalScheduleMutation({
      operationId,
      orgId: authenticated.subject.orgId,
      actorId: authenticated.subject.userId,
      customerId: auditScope.customerId,
      scheduleId,
      fixtureId: fixture.fixtureId,
      connectionId: fixture.connectionId,
      operationKind: "toggle",
      command: { fixtureId: fixture.fixtureId, enabled: body.enabled },
    }, catalog);
    return jsonResponse({ schedule });
  } catch (error) {
    return errorResponse(error);
  }
}
