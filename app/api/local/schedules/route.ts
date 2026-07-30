import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import { authorize } from "../../../../lib/auth-policy";
import type {
  LocalFixtureDescriptor,
  LocalFixtureVersion,
} from "../../../../lib/local-ops-types";
import {
  assertLocalScheduleProvisioningScope,
  localScheduleOperationId,
  persistAndApplyLocalScheduleMutation,
  reconcileLocalScheduleMutations,
} from "../../../../lib/local-schedule-api";
import {
  assertLocalSimulationRuntime,
  errorResponse,
  getLocalFixtureCatalog,
  getLocalFixtureSchedules,
  jsonResponse,
  localFixtureScheduleId,
} from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const ALLOWED_INTERVALS = new Set([300_000, 900_000, 3_600_000, 21_600_000, 86_400_000]);

function parseUpsert(value: unknown): {
  readonly fixtureId: string;
  readonly version: LocalFixtureVersion;
  readonly everyMs: number;
  readonly enabled: boolean;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "enabled,everyMs,fixtureId,version" ||
    typeof record.fixtureId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u.test(record.fixtureId) ||
    (record.version !== "2026.07.0" && record.version !== "2026.07.1") ||
    !Number.isSafeInteger(record.everyMs) ||
    !ALLOWED_INTERVALS.has(record.everyMs as number) ||
    typeof record.enabled !== "boolean"
  ) invalid();
  return {
    fixtureId: record.fixtureId,
    version: record.version,
    everyMs: record.everyMs as number,
    enabled: record.enabled,
  };
}

function invalid(): never {
  throw Object.assign(new Error("The simulated schedule request is invalid"), { code: "INVALID_INPUT" });
}

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
    assertLocalSimulationRuntime();
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
    return jsonResponse({ schedules });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    assertLocalSimulationRuntime();
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    assertSameOrigin(request);
    const body = parseUpsert(await readBoundedJson(request));
    const catalog = await getLocalFixtureCatalog();
    const fixture = catalog.find((candidate) =>
      candidate.tenantId === authenticated.subject.orgId &&
      candidate.fixtureId === body.fixtureId &&
      candidate.availableVersions.includes(body.version));
    if (fixture === undefined) {
      throw Object.assign(new Error("The simulated fixture or version was not found"), { code: "NOT_FOUND" });
    }
    const auditScope = await assertLocalScheduleProvisioningScope(authenticated, fixture);
    const scheduleId = await localFixtureScheduleId(fixture.tenantId, fixture.fixtureId);
    const operationId = await localScheduleOperationId(
      authenticated.subject.orgId,
      request.headers.get("idempotency-key") ?? "",
    );
    const firstRunAt = new Date().toISOString();
    const schedule = await persistAndApplyLocalScheduleMutation({
      operationId,
      orgId: authenticated.subject.orgId,
      actorId: authenticated.subject.userId,
      customerId: auditScope.customerId,
      scheduleId,
      fixtureId: fixture.fixtureId,
      connectionId: fixture.connectionId,
      operationKind: "upsert",
      command: {
        fixtureId: fixture.fixtureId,
        version: body.version,
        everyMs: body.everyMs,
        enabled: body.enabled,
        firstRunAt,
      },
    }, catalog);
    return jsonResponse({ schedule });
  } catch (error) {
    return errorResponse(error);
  }
}
