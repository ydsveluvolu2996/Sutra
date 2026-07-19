import { getLocalJobPublications } from "../../../../db/local-operations-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { authorize } from "../../../../lib/auth-policy";
import {
  acknowledgeLocalFixtureJobPublication,
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
      const scope = { tenantId: fixture.tenantId, customerId: fixture.customerId };
      const [latest, reviewRequired] = await Promise.all([
        listLocalFixtureJobs(limit, scope),
        listLocalFixtureJobs(100, scope, { reviewRequired: true }),
      ]);
      const jobs = [...new Map(
        [...latest, ...reviewRequired].map((job) => [job.jobId, job]),
      ).values()];
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
    const candidates = scopedLists
      .flat()
      .sort((left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        right.jobId.localeCompare(left.jobId));
    const publicationMaps = await Promise.all(
      Array.from({ length: Math.ceil(candidates.length / 100) }, (_, index) =>
        getLocalJobPublications(
          authenticated.subject.orgId,
          candidates.slice(index * 100, index * 100 + 100).map((job) => job.jobId),
        )),
    );
    const publications = new Map(
      publicationMaps.flatMap((publicationMap) => [...publicationMap.entries()]),
    );
    const reviewRequired = candidates.filter((job) =>
      (job.status === "pending" || job.status === "leased" || job.status === "succeeded") &&
      publications.get(job.jobId) === undefined);
    const visibleById = new Map(reviewRequired.map((job) => [job.jobId, job]));
    for (const job of candidates) {
      if (visibleById.size >= reviewRequired.length + limit) break;
      visibleById.set(job.jobId, job);
    }
    const visible = [...visibleById.values()].sort((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      right.jobId.localeCompare(left.jobId));
    const fixtureById = new Map(visibleFixtures.map((fixture) => [fixture.fixtureId, fixture]));
    await Promise.all(visible.map(async (job) => {
      const stored = publications.get(job.jobId);
      if (stored === undefined) return;
      const fixture = fixtureById.get(job.fixtureId);
      if (fixture === undefined) {
        throw Object.assign(new Error("The local job escaped its visible fixture scope"), {
          code: "INVALID_STATE",
        });
      }
      await acknowledgeLocalFixtureJobPublication({
        fixture,
        jobId: job.jobId,
        publicationId: stored.snapshotId,
        publishedAt: stored.publishedAt,
      });
    }));
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
    return jsonResponse({ jobs, recentLimit: limit, reviewRequired: reviewRequired.length });
  } catch (error) {
    return errorResponse(error);
  }
}
