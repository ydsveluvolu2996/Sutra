import { assertSessionCapability } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import type { LocalFixtureVersion } from "../../../../../lib/local-ops-types";
import {
  enqueueLocalFixtureJob,
  errorResponse,
  getLocalFixtureCatalog,
  jsonResponse,
  requirePilotActor,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const IDEMPOTENCY_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function parseBody(value: unknown): { fixtureId: string; version: LocalFixtureVersion } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Object.assign(new Error("The simulated sync request is invalid"), { code: "INVALID_INPUT" });
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "fixtureId,version" ||
    typeof record.fixtureId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u.test(record.fixtureId) ||
    (record.version !== "2026.07.0" && record.version !== "2026.07.1")
  ) {
    throw Object.assign(new Error("The simulated sync request is invalid"), { code: "INVALID_INPUT" });
  }
  return { fixtureId: record.fixtureId, version: record.version };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw Object.assign(new Error("A valid idempotency key is required"), { code: "INVALID_INPUT" });
    }
    const body = parseBody(await readBoundedJson(request));
    const catalog = await getLocalFixtureCatalog();
    const fixture = catalog.find((candidate) =>
      candidate.tenantId === actor.orgId && candidate.fixtureId === body.fixtureId);
    if (fixture === undefined || !fixture.availableVersions.includes(body.version)) {
      throw Object.assign(new Error("The simulated fixture or version was not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(actor.authenticated, "sync:run", fixture.customerId);
    const result = await enqueueLocalFixtureJob({
      fixture,
      version: body.version,
      idempotencyKey,
    });
    return jsonResponse(result, { status: result.created ? 202 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
