import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
import { ScadAllocationRepository } from "../../../../../db/finops-scad-allocation-repository";
import { ScadCur2RuntimeAttemptRepository } from "../../../../../db/finops-scad-runtime-attempt-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  buildScadDashboard,
  type ScadDashboardFilters,
} from "../../../../../lib/finops-scad-dashboard";
import type {
  ScadMetric,
  ScadPlatform,
} from "../../../../../lib/finops-scad-allocation";
import { SCAD_OFFICIAL_DEFINITION } from "../../../../../lib/finops-scad-official-definition";
import { SCAD_CUR2_RUNTIME_BINDING } from "../../../../../lib/finops-scad-durable-runtime-binding";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
export const dynamic = "force-dynamic";
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const SAFE = /^[^\u0000-\u001f\u007f<>]{1,128}$/u;
const PLATFORMS: readonly ScadPlatform[] = [
  "EKS",
  "ECS",
  "BATCH_EKS",
  "BATCH_ECS",
];
const METRICS: readonly ScadMetric[] = [
  "VCPU",
  "MEMORY",
  "GPU",
  "TRAINIUM",
  "INFERENTIA",
  "OTHER_ACCELERATOR",
];
const SHOWBACK: readonly ScadDashboardFilters["showbackBy"][] = [
  "ACCOUNT",
  "CLUSTER",
  "NAMESPACE",
  "WORKLOAD",
  "TAG",
];
const ALLOWED = new Set([
  "connectionId",
  "accountId",
  "region",
  "platform",
  "cluster",
  "namespace",
  "workload",
  "metric",
  "tagKey",
  "tagValue",
  "search",
  "showbackBy",
]);
const FRESH = 48;
async function collectionState(scope: { readonly organizationId: string; readonly customerId: string;
  readonly connectionId: string }): Promise<{ readonly available: boolean;
    readonly lifecycleState: "UNAVAILABLE" | "COLLECTING" | "FAILED" | "READY";
    readonly reason: string | null; readonly latestAttempt: unknown }> {
  // Compatibility reason remains SCAD_CUR2_MATERIALIZER_JOB_HANDLER_NOT_REGISTERED until shared registration.
  if (!SCAD_CUR2_RUNTIME_BINDING.registeredInSharedRuntime) return { available: false,
    lifecycleState: "UNAVAILABLE", reason: SCAD_CUR2_RUNTIME_BINDING.activationReason, latestAttempt: null };
  const latest = await new ScadCur2RuntimeAttemptRepository().latest(scope);
  if (latest === null || latest.state === "IN_PROGRESS" || latest.state === "PERSISTED") {
    return { available: true, lifecycleState: "COLLECTING", reason: null, latestAttempt: latest };
  }
  if (latest.state === "FAILED" || latest.state === "RETRYABLE_FAILED") {
    return { available: true, lifecycleState: "FAILED", reason: latest.failureCode, latestAttempt: latest };
  }
  return { available: true, lifecycleState: "READY", reason: null, latestAttempt: latest };
}
function bad(): never {
  throw Object.assign(new Error("The SCAD allocation request is invalid"), {
    code: "INVALID_INPUT",
    status: 400,
  });
}
function missing(): never {
  throw Object.assign(new Error("Cloud connection not found"), {
    code: "NOT_FOUND",
    status: 404,
  });
}
function member<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  if (value === null) return null;
  if (!allowed.includes(value as T)) bad();
  return value as T;
}
function safe(value: string | null): string | null {
  if (value !== null && !SAFE.test(value)) bad();
  return value;
}
function parse(request: Request): {
  connectionId: string;
  filters: ScadDashboardFilters;
} {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!ALLOWED.has(key)) bad();
  for (const key of ALLOWED) if (values.getAll(key).length > 1) bad();
  const connectionId = values.get("connectionId") ?? "";
  const accountId = values.get("accountId");
  const region = values.get("region");
  if (
    !CONNECTION.test(connectionId) ||
    (accountId !== null && !ACCOUNT.test(accountId)) ||
    (region !== null && !REGION.test(region))
  )
    bad();
  const tagKey = safe(values.get("tagKey"));
  const tagValue = safe(values.get("tagValue"));
  const showbackBy = member(values.get("showbackBy"), SHOWBACK) ?? "WORKLOAD";
  if (showbackBy === "TAG" && tagKey === null) bad();
  return {
    connectionId,
    filters: {
      accountId,
      region,
      platform: member(values.get("platform"), PLATFORMS),
      cluster: safe(values.get("cluster")),
      namespace: safe(values.get("namespace")),
      workload: safe(values.get("workload")),
      metric: member(values.get("metric"), METRICS),
      tagKey,
      tagValue,
      search: safe(values.get("search")),
      showbackBy,
    },
  };
}
function age(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > Date.now() + 300_000) return null;
  return Math.round(Math.max(0, (Date.now() - parsed) / 3_600_000) * 100) / 100;
}
export async function GET(request: Request): Promise<Response> {
  try {
    const query = parse(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      query.connectionId,
    );
    if (
      connection === null ||
      !isCollectableAwsSourceKind(connection.sourceKind) ||
      connection.status !== "active"
    )
      missing();
    assertSessionCapability(
      authenticated,
      "connection:read",
      connection.customerId,
    );
    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const repository = new ScadAllocationRepository();
    const [heads, history, collection] = await Promise.all([
      repository.listActiveSnapshots(scope),
      repository.listHistory(scope),
      collectionState(scope),
    ]);
    if (heads.length === 0)
      return jsonResponse({
        schema: "sutra.finops-scad-allocation.v1",
        connectionId: connection.id,
        sourceState: history[0]?.state ?? "CONFIGURATION_REQUIRED",
        dashboard: null,
        officialDefinition: SCAD_OFFICIAL_DEFINITION,
        latestAttempt: collection.latestAttempt,
        collection,
        limitations: [
          "No complete accepted SCAD billing-period generation is available.",
        ],
      });
    const dashboard = buildScadDashboard(heads, query.filters);
    const dataThrough =
      heads
        .map((head) => head.snapshot.dataThroughAt)
        .sort()
        .at(0) ?? null;
    const currentAge = dataThrough === null ? null : age(dataThrough);
    const newestAccepted =
      heads
        .map((head) => head.snapshot.generatedAt)
        .sort()
        .at(-1) ?? "";
    const newerIncomplete = history.some(
      (item) => !item.complete && item.generatedAt >= newestAccepted,
    );
    const sourceState = newerIncomplete
      ? "PARTIAL"
      : currentAge === null || currentAge > FRESH
        ? "STALE"
        : dashboard.executive.groupCount === 0
          ? "NO_USAGE"
          : "READY";
    return jsonResponse({
      schema: "sutra.finops-scad-allocation.v1",
      connectionId: connection.id,
      source: "AWS_CUR2_SPLIT_COST_ALLOCATION_DATA",
      sourceState,
      officialDefinition: SCAD_OFFICIAL_DEFINITION,
      freshness: {
        dataThroughAt: dataThrough,
        ageHours: currentAge,
        staleAfterHours: FRESH,
      },
      ...dashboard,
      history: history.slice(0, 180),
      evidence: {
        acceptedHeads: heads.map((head) => ({
          generationId: head.generationId,
          contentSha256: head.contentSha256,
          captureId: head.snapshot.captureId,
          activeBillingGenerationId: head.snapshot.activeGenerationId,
          billingPeriodStartAt: head.snapshot.billingPeriodStartAt,
        })),
      },
      latestAttempt: collection.latestAttempt,
      collection,
      limitations: [
        ...dashboard.limitations,
        ...(collection.lifecycleState === "UNAVAILABLE"
          ? ["The permanent S3/CUR2 materializer is complete but remains outside the shared runtime registry."] : []),
        ...(newerIncomplete
          ? [
              "A newer incomplete or corrected delivery did not displace its complete accepted billing-period head.",
            ]
          : []),
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
