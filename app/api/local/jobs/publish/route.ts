import { publishLocalFixtureJob } from "../../../../../db/local-operations-repository";
import { getConnection, getPilotState } from "../../../../../db/pilot-repository";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getLocalFixtureCatalog,
  getLocalFixtureJobResult,
  jsonResponse,
  requirePilotActor,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function jobId(value: unknown): string {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).join(",") !== "jobId" ||
    !("jobId" in value) || typeof value.jobId !== "string" ||
    !/^job_[a-f0-9]{48}$/u.test(value.jobId)
  ) {
    throw Object.assign(new Error("The fixture publication request is invalid"), { code: "INVALID_INPUT" });
  }
  return value.jobId;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const requestedJobId = jobId(await readBoundedJson(request));
    const catalog = await getLocalFixtureCatalog();
    const result = await getLocalFixtureJobResult({
      jobId: requestedJobId,
      fixtures: catalog.filter((candidate) => candidate.tenantId === actor.orgId),
    });
    const job = result.job;
    const fixture = catalog.find((candidate) =>
      candidate.tenantId === actor.orgId &&
      candidate.fixtureId === job.fixtureId &&
      candidate.customerId === job.customerId &&
      candidate.connectionId === job.connectionId &&
      candidate.availableVersions.includes(job.version));
    if (fixture === undefined) {
      throw Object.assign(new Error("The fixture job scope is not in the signed catalog"), { code: "INVALID_STATE" });
    }
    assertSessionCapability(actor.authenticated, "sync:run", fixture.customerId);
    const existingConnection = await getConnection(fixture.connectionId);
    const allowProvisioning = existingConnection === null;
    if (allowProvisioning) {
      assertSessionCapability(actor.authenticated, "customer:create");
      assertSessionCapability(actor.authenticated, "connection:manage", fixture.customerId);
    }
    const publication = await publishLocalFixtureJob({
      fixture,
      result,
      actorId: actor.id,
      allowProvisioning,
    });
    return jsonResponse({
      publication,
      state: await getPilotState(fixture.connectionId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
