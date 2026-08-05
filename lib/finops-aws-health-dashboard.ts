import type {
  AwsHealthActionability,
  AwsHealthEventCategory,
  AwsHealthEventStatus,
  AwsHealthNormalizedEvent,
  AwsHealthOrganizationSnapshot,
} from "./finops-aws-health-organization.ts";

export interface AwsHealthAcceptedHead {
  readonly generationId: string;
  readonly contentSha256: string;
  readonly snapshot: AwsHealthOrganizationSnapshot;
}

export interface AwsHealthDashboardFilters {
  readonly status: AwsHealthEventStatus | null;
  readonly category: AwsHealthEventCategory | null;
  readonly service: string | null;
  readonly accountId: string | null;
  readonly region: string | null;
  readonly actionability: AwsHealthActionability | null;
  readonly search: string | null;
}

interface HistoryRow {
  readonly generationId: string;
  readonly contentSha256: string;
  readonly observedAt: string;
  readonly captureId: string;
  readonly event: AwsHealthNormalizedEvent;
}

function eventTime(event: AwsHealthNormalizedEvent, observed: string): string {
  return event.lastUpdatedAt ?? event.startAt ?? observed;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function explicitDeprecatedVersions(
  event: AwsHealthNormalizedEvent,
): readonly string[] {
  const values = event.details.flatMap((detail) =>
    detail.metadata.flatMap(({ key, value }) => {
      const normalized = key.toLocaleLowerCase().replaceAll(/[^a-z]/gu, "");
      return normalized === "deprecatedversion"
        || normalized === "deprecatedversions"
        ? [value]
        : [];
    }));
  return [...new Set(values)].sort(compareText);
}

export function buildAwsHealthPlanningDashboard(
  heads: readonly AwsHealthAcceptedHead[],
  filters: AwsHealthDashboardFilters,
  nowMs = Date.now(),
) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || heads.length > 730) {
    throw new Error("aws-health-dashboard-invalid");
  }
  const history: HistoryRow[] = heads.flatMap((head) =>
    head.snapshot.events.map((event) => ({
      generationId: head.generationId,
      contentSha256: head.contentSha256,
      observedAt: head.snapshot.observedAtIso,
      captureId: head.snapshot.captureId,
      event,
    })));
  const current = new Map<string, HistoryRow>();
  for (const item of history) {
    const previous = current.get(item.event.arn);
    if (previous === undefined
      || eventTime(item.event, item.observedAt)
        > eventTime(previous.event, previous.observedAt)) {
      current.set(item.event.arn, item);
    }
  }
  const search = filters.search?.toLocaleLowerCase() ?? null;
  const rows = [...current.values()].filter(({ event }) =>
    (filters.status === null || event.status === filters.status)
    && (filters.category === null || event.category === filters.category)
    && (filters.service === null || event.service === filters.service)
    && (
      filters.accountId === null
      || event.affectedAccounts.includes(filters.accountId)
    )
    && (filters.region === null || event.region === filters.region)
    && (
      filters.actionability === null
      || event.actionability === filters.actionability
    )
    && (
      search === null
      || `${event.eventTypeCode} ${event.service ?? ""} ${event.region ?? ""} ${
        event.details.map((detail) => detail.description ?? "").join(" ")
      } ${
        event.affectedEntities.map((entity) => entity.entityValue ?? "")
          .join(" ")
      }`.toLocaleLowerCase().includes(search)
    )).sort((left, right) =>
    eventTime(right.event, right.observedAt)
      .localeCompare(eventTime(left.event, left.observedAt))
    || left.event.arn.localeCompare(right.event.arn));

  const transitions = new Map<string, {
    arn: string;
    eventTypeCode: string;
    points: {
      observedAt: string;
      status: AwsHealthEventStatus;
      lastUpdatedAt: string | null;
      generationId: string;
    }[];
  }>();
  for (const item of [...history].sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt)
    || left.generationId.localeCompare(right.generationId))) {
    const transition = transitions.get(item.event.arn) ?? {
      arn: item.event.arn,
      eventTypeCode: item.event.eventTypeCode,
      points: [],
    };
    const previous = transition.points.at(-1);
    if (previous === undefined
      || previous.status !== item.event.status
      || previous.lastUpdatedAt !== item.event.lastUpdatedAt) {
      transition.points.push({
        observedAt: item.observedAt,
        status: item.event.status,
        lastUpdatedAt: item.event.lastUpdatedAt,
        generationId: item.generationId,
      });
    }
    transitions.set(item.event.arn, transition);
  }

  const upcomingTimeline = rows.filter(({ event }) =>
    (event.status === "open" || event.status === "upcoming")
    && event.startAt !== null)
    .sort((left, right) =>
      (left.event.startAt ?? "").localeCompare(right.event.startAt ?? "")
      || left.event.arn.localeCompare(right.event.arn))
    .slice(0, 500)
    .map(({ event, generationId, observedAt }) => ({
      arn: event.arn,
      eventTypeCode: event.eventTypeCode,
      service: event.service,
      region: event.region,
      status: event.status,
      startAt: event.startAt as string,
      endAt: event.endAt,
      actionability: event.actionability,
      affectedAccountCount: event.affectedAccounts.length,
      affectedEntityCount: event.affectedEntities.length,
      generationId,
      observedAt,
    }));

  const deprecationItems = rows.flatMap(({ event, generationId, observedAt }) =>
    explicitDeprecatedVersions(event).map((deprecatedVersions) => ({
      arn: event.arn,
      eventTypeCode: event.eventTypeCode,
      service: event.service,
      region: event.region,
      status: event.status,
      startAt: event.startAt,
      deprecatedVersions,
      generationId,
      observedAt,
    }))).sort((left, right) =>
    (left.startAt ?? "").localeCompare(right.startAt ?? "")
    || left.eventTypeCode.localeCompare(right.eventTypeCode)
    || left.arn.localeCompare(right.arn));

  const latest = heads.map((head) => head.snapshot.observedAtIso).sort().at(-1)
    ?? null;
  const ageHours = latest === null
    ? null
    : Math.round(Math.max(0, (nowMs - Date.parse(latest)) / 3_600_000) * 100)
      / 100;
  return {
    schemaVersion: "sutra.aws-health-planning-dashboard.v1",
    generatedAtIso: new Date(nowMs).toISOString(),
    filters,
    planningSemantics: {
      notRealTime: true,
      minimumDocumentedLagHours: 48,
      purpose: "PLANNING_AND_HISTORICAL_ANALYSIS",
      warning:
        "AWS Health organization data can lag by 48 hours or more. Do not use this dashboard for real-time incident response.",
    },
    freshness: {
      latestAcceptedObservedAt: latest,
      ageHours,
      staleAfterHours: 72,
    },
    prerequisites: heads.at(-1)?.snapshot.prerequisites ?? null,
    configurationState:
      heads.at(-1)?.snapshot.configurationState ?? "unavailable",
    summary: {
      eventCount: rows.length,
      pastCount: rows.filter((row) => row.event.status === "closed").length,
      currentCount: rows.filter((row) => row.event.status === "open").length,
      upcomingCount: rows.filter((row) => row.event.status === "upcoming")
        .length,
      actionRequiredCount: rows.filter((row) =>
        row.event.actionability === "ACTION_REQUIRED").length,
      affectedAccountCount: new Set(rows.flatMap((row) =>
        row.event.affectedAccounts)).size,
      affectedEntityCount: rows.reduce((sum, row) =>
        sum + row.event.affectedEntities.length, 0),
      historyGenerationCount: heads.length,
    },
    upcomingTimeline,
    upcomingTimelineTruncated: rows.filter(({ event }) =>
      (event.status === "open" || event.status === "upcoming")
      && event.startAt !== null).length > 500,
    deprecatingVersions: {
      status: deprecationItems.length === 0
        ? "unavailable" as const
        : "available" as const,
      evidenceField: "deprecated_versions" as const,
      derivation: "explicit_event_detail_metadata_only" as const,
      items: deprecationItems.slice(0, 500),
      truncated: deprecationItems.length > 500,
      unavailableReason: deprecationItems.length === 0
        ? "EXPLICIT_DEPRECATED_VERSIONS_METADATA_NOT_RETURNED" as const
        : null,
    },
    events: rows.slice(0, 500),
    eventsTruncated: rows.length > 500,
    eventHistory: [...transitions.values()].sort((left, right) =>
      left.eventTypeCode.localeCompare(right.eventTypeCode)
      || left.arn.localeCompare(right.arn)),
    filterOptions: {
      statuses: [...new Set([...current.values()].map((row) =>
        row.event.status))].sort(),
      categories: [...new Set([...current.values()].map((row) =>
        row.event.category))].sort(),
      services: [...new Set([...current.values()].map((row) => row.event.service)
        .filter((item): item is string => item !== null))].sort(),
      accounts: [...new Set([...current.values()].flatMap((row) =>
        row.event.affectedAccounts))].sort(),
      regions: [...new Set([...current.values()].map((row) => row.event.region)
        .filter((item): item is string => item !== null))].sort(),
      actionabilities: [...new Set([...current.values()].map((row) =>
        row.event.actionability).filter((item): item is AwsHealthActionability =>
        item !== null))].sort(),
    },
    lineage: heads.map((head) => ({
      generationId: head.generationId,
      contentSha256: head.contentSha256,
      captureId: head.snapshot.captureId,
      observedAt: head.snapshot.observedAtIso,
      coverage: head.snapshot.coverage,
    })),
    limitations: [
      "This is planning and historical evidence with documented 48-hour-or-greater lag, never a real-time incident feed.",
      "AWS provider retention is limited; Sutra history contains only snapshots collected and accepted after activation.",
      "Descriptions, affected entities and metadata are tenant-private and exposed only through authenticated same-tenant access.",
      "Deprecating versions are shown only when explicit deprecated_versions event-detail metadata is present; Sutra does not infer versions from descriptions.",
      "An empty result does not prove that no incident exists or that provider publication has completed.",
    ],
  };
}
