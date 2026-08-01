import { AwsNewsFeedsRepository } from "../../../../../db/finops-aws-news-feeds-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  buildAwsNewsDashboardProjection,
  type AwsNewsDashboardFilters,
} from "../../../../../lib/finops-aws-news-dashboard";
import type { AwsNewsFeedKind, AwsNewsFeedSourceId } from "../../../../../lib/finops-aws-news-feeds";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const SOURCES = new Set<AwsNewsFeedSourceId>(["aws_whats_new", "aws_news_blog", "aws_security_blog", "aws_security_bulletins", "aws_official_video"]);
const KINDS = new Set<AwsNewsFeedKind>(["WHATS_NEW", "BLOG", "SECURITY_BLOG", "SECURITY_BULLETIN", "VIDEO"]);
const ALLOWED = new Set(["connectionId", "sourceId", "feedKind", "serviceId", "category", "relevance", "search"]);
const FRESHNESS_HOURS = 48;

function invalid(): never {
  throw Object.assign(new Error("The AWS News Feeds dashboard request is invalid"), { code: "INVALID_INPUT", status: 400 });
}

function text(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > maximum
    || /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) invalid();
  return normalized;
}

function parse(request: Request): { readonly connectionId: string; readonly filters: AwsNewsDashboardFilters } {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) if (!ALLOWED.has(key)) invalid();
  for (const key of ALLOWED) if (parameters.getAll(key).length > 1) invalid();
  const connectionId = parameters.get("connectionId") ?? "";
  const sourceId = parameters.get("sourceId");
  const feedKind = parameters.get("feedKind");
  const serviceId = parameters.get("serviceId");
  const category = text(parameters.get("category"), 128);
  const relevance = parameters.get("relevance");
  const search = text(parameters.get("search"), 100);
  if (!CONNECTION_ID.test(connectionId)
    || (sourceId !== null && !SOURCES.has(sourceId as AwsNewsFeedSourceId))
    || (feedKind !== null && !KINDS.has(feedKind as AwsNewsFeedKind))
    || (serviceId !== null && !SERVICE_ID.test(serviceId))
    || (relevance !== null && relevance !== "ALL" && relevance !== "TENANT_RELEVANT")) invalid();
  return {
    connectionId,
    filters: {
      sourceId: sourceId as AwsNewsFeedSourceId | null,
      feedKind: feedKind as AwsNewsFeedKind | null,
      serviceId,
      category,
      relevance: relevance as AwsNewsDashboardFilters["relevance"],
      search,
    },
  };
}

function ageHours(value: string): number | null {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || epoch > Date.now() + 300_000) return null;
  return Math.round(Math.max(0, (Date.now() - epoch) / 3_600_000) * 100) / 100;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, query.connectionId);
    if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { organizationId: authenticated.subject.orgId, customerId: connection.customerId, connectionId: connection.id };
    const repository = new AwsNewsFeedsRepository();
    const [active, latest, history] = await Promise.all([
      repository.getActiveSnapshot(scope), repository.getLatestSnapshot(scope), repository.listHistory(scope, 30),
    ]);
    const selected = active ?? latest;
    if (selected === null) return jsonResponse({
      schema: "sutra.finops-aws-news-dashboard.v1",
      connectionId: connection.id,
      sourceState: "configuration_required",
      dashboard: null,
      collection: { runtimeBound: false, reason: "AWS_NEWS_FEEDS_JOB_HANDLER_NOT_REGISTERED" },
    });
    const projection = buildAwsNewsDashboardProjection(selected.snapshot, history, query.filters);
    const freshnessAgeHours = ageHours(selected.snapshot.observedAt);
    const newerIncomplete = active !== null && latest !== null && latest.generationId !== active.generationId;
    const sourceState = newerIncomplete || selected.snapshot.state === "PARTIAL" ? "partial"
      : selected.snapshot.state === "FAILED" ? "failed"
        : selected.snapshot.state === "STALE" || freshnessAgeHours === null || freshnessAgeHours > FRESHNESS_HOURS ? "stale"
          : projection.resultCount === 0 ? "empty" : "complete";
    return jsonResponse({
      ...projection,
      connectionId: connection.id,
      sourceState,
      freshness: { observedAt: selected.snapshot.observedAt, ageHours: freshnessAgeHours, staleAfterHours: FRESHNESS_HOURS },
      sourceEvidence: selected.snapshot.sourceEvidence,
      evidence: {
        generationId: selected.generationId,
        activeGenerationId: active?.generationId ?? null,
        latestGenerationId: latest?.generationId ?? null,
        newerIncomplete,
        captureId: selected.snapshot.captureId,
        catalogId: selected.snapshot.catalogId,
        contentSha256: selected.contentSha256,
        coverage: selected.snapshot.coverage,
        counts: selected.snapshot.counts,
        limitations: selected.snapshot.limitations,
      },
      collection: { runtimeBound: false, reason: "AWS_NEWS_FEEDS_JOB_HANDLER_NOT_REGISTERED" },
      disclosure: "Public AWS announcements are contextual intelligence, not evidence that a tenant resource is affected.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
