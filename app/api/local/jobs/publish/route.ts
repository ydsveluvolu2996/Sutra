import { publishLocalFixtureJob } from "../../../../../db/local-operations-repository";
import { getConnectionForOrg, getPilotState, LOCAL_ORG_ID } from "../../../../../db/pilot-repository";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { authorize } from "../../../../../lib/auth-policy";
import {
  assertLocalSimulationRuntime,
  acknowledgeLocalFixtureJobPublication,
  errorResponse,
  getLocalFixtureCatalog,
  getLocalFixtureJobResult,
  jsonResponse,
  PilotServerError,
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
    assertLocalSimulationRuntime();
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const requestedJobId = jobId(await readBoundedJson(request));
    const catalog = await getLocalFixtureCatalog();
    const authorizedFixtures = catalog.filter((candidate) =>
      candidate.tenantId === actor.orgId &&
      authorize(actor.authenticated.subject, {
        orgId: actor.orgId,
        capability: "sync:run",
        customerId: candidate.customerId,
      }).allowed);
    let scoped: {
      readonly fixture: (typeof authorizedFixtures)[number];
      readonly result: Awaited<ReturnType<typeof getLocalFixtureJobResult>>;
    } | null = null;
    for (const candidate of authorizedFixtures) {
      try {
        scoped = {
          fixture: candidate,
          result: await getLocalFixtureJobResult({
            jobId: requestedJobId,
            fixture: candidate,
          }),
        };
        break;
      } catch (error) {
        if (!(error instanceof PilotServerError && error.code === "JOB_NOT_FOUND")) {
          throw error;
        }
      }
    }
    if (scoped === null) {
      throw Object.assign(new Error("The fixture job was not found in an authorized customer scope"), {
        code: "NOT_FOUND",
      });
    }
    const { fixture, result } = scoped;
    assertSessionCapability(actor.authenticated, "sync:run", fixture.customerId);
    const existingConnection = await getConnectionForOrg(LOCAL_ORG_ID, fixture.connectionId);
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
    await acknowledgeLocalFixtureJobPublication({
      fixture,
      jobId: publication.jobId,
      publicationId: publication.snapshotId,
      publishedAt: publication.publishedAt,
    });
    return jsonResponse({
      publication,
      state: await getPilotState(fixture.connectionId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
