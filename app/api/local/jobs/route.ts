import { getLocalJobPublications } from "../../../../db/local-operations-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { authorize } from "../../../../lib/auth-policy";
import {
  errorResponse,
  getLocalFixtureCatalog,
  jsonResponse,
  listLocalFixtureJobs,
} from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit") ?? "30";
    if (
      !/^\d{1,3}$/u.test(rawLimit) ||
      [...url.searchParams.keys()].some((key) => key !== "limit")
    ) {
      throw Object.assign(new Error("The local job request is invalid"), { code: "INVALID_INPUT" });
    }
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 100) {
      throw Object.assign(new Error("The local job limit must be between 1 and 100"), { code: "INVALID_INPUT" });
    }
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "workspace:read");
    const catalog = await getLocalFixtureCatalog();
    const visibleFixtures = catalog.filter((fixture) =>
      fixture.tenantId === authenticated.subject.orgId &&
      authorize(authenticated.subject, {
        orgId: authenticated.subject.orgId,
        capability: "connection:read",
        customerId: fixture.customerId,
      }).allowed);
    const scopedLists = await Promise.all(visibleFixtures.map(async (fixture) => {
      const jobs = await listLocalFixtureJobs(limit, {
        tenantId: fixture.tenantId,
        customerId: fixture.customerId,
      });
      if (jobs.some((job) =>
        job.tenantId !== fixture.tenantId ||
        job.customerId !== fixture.customerId ||
        job.fixtureId !== fixture.fixtureId ||
        job.connectionId !== fixture.connectionId
      )) {
        throw Object.assign(new Error("The local job list escaped its signed customer scope"), {
          code: "INVALID_STATE",
        });
      }
      return jobs;
    }));
    const visible = scopedLists
      .flat()
      .sort((left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        right.jobId.localeCompare(left.jobId))
      .slice(0, limit);
    const publications = await getLocalJobPublications(
      authenticated.subject.orgId,
      visible.map((job) => job.jobId),
    );
    const jobs = visible.map((job) => {
      const stored = publications.get(job.jobId) ?? null;
      if (
        stored !== null && (
          stored.customerId !== job.customerId ||
          stored.connectionId !== job.connectionId ||
          stored.fixtureId !== job.fixtureId ||
          stored.fixtureVersion !== job.version
        )
      ) {
        throw Object.assign(new Error("The local job publication scope is inconsistent"), { code: "INVALID_STATE" });
      }
      return { ...job, publication: stored };
    });
    return jsonResponse({ jobs });
  } catch (error) {
    return errorResponse(error);
  }
}
