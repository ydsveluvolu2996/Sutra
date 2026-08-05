/** Executable, dependency-injected HTTP boundary for the exact dashboard. */
import type { StoredComputeOptimizerExportPlan } from
  "../db/finops-compute-optimizer-export-plan-repository.ts";
import type { StoredComputeOptimizerExportPlanSet } from
  "../db/finops-compute-optimizer-export-plan-set-repository.ts";
import type {
  ComputeOptimizerAcceptedHeadReference,
  ComputeOptimizerExactGenerationScope,
} from "../db/finops-compute-optimizer-exact-generation-repository.ts";
import type { ComputeOptimizerExportGeneration } from
  "./finops-compute-optimizer-export-generation.ts";
import type { ComputeOptimizerExportPlanEnvelope } from
  "./finops-compute-optimizer-export-plan-envelope.ts";
import type { ComputeOptimizerExportPlanSet } from
  "./finops-compute-optimizer-export-plan.ts";
import type { ComputeOptimizerExactDashboard } from
  "./finops-compute-optimizer-exact-dashboard.ts";
import { FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION } from
  "./finops-compute-optimizer-official-definition.ts";
import { errorResponse, jsonResponse } from "./pilot-server.ts";

const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const INTEGER = /^(?:0|[1-9]\d*)$/u;
const SAFE_FILTER = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;
const FAMILIES = new Set(["EC2_INSTANCE", "AUTO_SCALING_GROUP", "EBS_VOLUME", "LAMBDA_FUNCTION", "ECS_SERVICE", "LICENSE", "RDS_DATABASE", "IDLE_RESOURCE"]);
const ALLOWED = new Set([
  "connectionId", "accountId", "region", "exportFamily", "finding", "tagKey",
  "tagValue", "groupByTagKey", "search", "offset", "limit",
]);

interface ExactRouteAuth {
  readonly subject: { readonly orgId: string };
}

interface ExactRouteConnection {
  readonly id: string;
  readonly customerId: string;
  readonly sourceKind: string;
  readonly status: string;
}

export interface ComputeOptimizerExactCollectionState {
  readonly state: "UNAVAILABLE" | "COLLECTING" | "FAILED";
  readonly activationId: string | null;
  readonly scheduledWindow: string | null;
  readonly updatedAtIso: string | null;
}

export interface ComputeOptimizerExactRouteDependencies<TAuth extends ExactRouteAuth = ExactRouteAuth> {
  readonly requireSession: (request: Request) => Promise<TAuth>;
  readonly getConnection: (organizationId: string, connectionId: string) => Promise<ExactRouteConnection | null>;
  readonly assertRead: (auth: TAuth, customerId: string) => void;
  readonly getHeadReference: (scope: ComputeOptimizerExactGenerationScope) => Promise<ComputeOptimizerAcceptedHeadReference | null>;
  /** Durable capability/activation projection; never derived from queue submission. */
  readonly getCollectionState: (
    scope: ComputeOptimizerExactGenerationScope,
  ) => Promise<ComputeOptimizerExactCollectionState>;
  readonly getStoredPlanSet: (scope: ComputeOptimizerExactGenerationScope, planSetId: string) => Promise<StoredComputeOptimizerExportPlanSet | null>;
  readonly getStoredPlan: (scope: ComputeOptimizerExactGenerationScope, planId: string) => Promise<StoredComputeOptimizerExportPlan | null>;
  readonly createEnvelope: () => Promise<ComputeOptimizerExportPlanEnvelope>;
  readonly readPlanSet: (input: {
    readonly scope: ComputeOptimizerExactGenerationScope;
    readonly storedPlanSet: StoredComputeOptimizerExportPlanSet;
    readonly storedPlans: readonly StoredComputeOptimizerExportPlan[];
    readonly envelope: ComputeOptimizerExportPlanEnvelope;
  }) => Promise<ComputeOptimizerExportPlanSet>;
  readonly getGeneration: (scope: ComputeOptimizerExactGenerationScope, planSet: ComputeOptimizerExportPlanSet,
    generationId: string) => Promise<ComputeOptimizerExportGeneration | null>;
  readonly buildDashboard: (input: {
    readonly scope: ComputeOptimizerExactGenerationScope;
    readonly planSet: ComputeOptimizerExportPlanSet;
    readonly generation: ComputeOptimizerExportGeneration;
    readonly filters?: unknown;
  }) => Promise<ComputeOptimizerExactDashboard>;
  readonly nowMs: () => number;
}

function fail(code: string, status: number): never {
  throw Object.assign(new Error("Compute Optimizer exact request rejected"), { code, status });
}

export function parseComputeOptimizerExactRouteQuery(request: Request): {
  readonly connectionId: string;
  readonly filters: Readonly<Record<string, unknown>>;
} {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) if (!ALLOWED.has(key)) fail("INVALID_INPUT", 400);
  for (const key of ALLOWED) if (parameters.getAll(key).length > 1) fail("INVALID_INPUT", 400);
  const connectionId = parameters.get("connectionId") ?? "";
  if (!CONNECTION.test(connectionId)) fail("INVALID_INPUT", 400);
  const filters: Record<string, unknown> = {};
  for (const key of ["accountId", "region", "exportFamily", "finding", "tagKey", "tagValue", "groupByTagKey", "search"] as const) {
    const value = parameters.get(key);
    if (value !== null) {
      if (value.trim() !== value || !SAFE_FILTER.test(value)
        || (key === "accountId" && !ACCOUNT.test(value))
        || (key === "region" && !REGION.test(value))
        || (key === "exportFamily" && !FAMILIES.has(value))) fail("INVALID_INPUT", 400);
      filters[key] = value;
    }
  }
  for (const key of ["offset", "limit"] as const) {
    const value = parameters.get(key); if (value === null) continue;
    if (!INTEGER.test(value)) fail("INVALID_INPUT", 400);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || (key === "offset" && parsed > 100_000)
      || (key === "limit" && (parsed < 1 || parsed > 500))) fail("INVALID_INPUT", 400);
    filters[key] = parsed;
  }
  if (filters.tagValue !== undefined && filters.tagKey === undefined) fail("INVALID_INPUT", 400);
  return Object.freeze({ connectionId, filters: Object.freeze(filters) });
}

export function createComputeOptimizerExactGetHandler<TAuth extends ExactRouteAuth>(
  dependencies: ComputeOptimizerExactRouteDependencies<TAuth>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const query = parseComputeOptimizerExactRouteQuery(request);
      const auth = await dependencies.requireSession(request);
      const connection = await dependencies.getConnection(auth.subject.orgId, query.connectionId);
      if (connection === null || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") fail("NOT_FOUND", 404);
      dependencies.assertRead(auth, connection.customerId);
      const scope = Object.freeze({ organizationId: auth.subject.orgId, customerId: connection.customerId, connectionId: connection.id });
      const head = await dependencies.getHeadReference(scope);
      if (head === null) {
        const collection = await dependencies.getCollectionState(scope);
        if (collection.state === "UNAVAILABLE") return jsonResponse({
          schema: "sutra.finops-compute-optimizer.v2", connectionId: connection.id,
          sourceState: "EXPORT_CONFIGURATION_REQUIRED", dashboard: null,
          officialDefinition: FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
          collection: Object.freeze({ available: true, ...collection }),
          limitations: Object.freeze(["A verified standard-2026-08.5 regional capability is required before exact organization exports can be collected."]),
        });
        if (collection.state === "FAILED") return jsonResponse({
          schema: "sutra.finops-compute-optimizer.v2", connectionId: connection.id,
          sourceState: "COLLECTION_FAILED", dashboard: null,
          officialDefinition: FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
          collection: Object.freeze({ available: true, ...collection }),
          limitations: Object.freeze(["The latest durable activation failed without advancing an accepted exact-evidence head."]),
        });
        return jsonResponse({
          schema: "sutra.finops-compute-optimizer.v2", connectionId: connection.id,
          sourceState: "COLLECTING", dashboard: null,
          officialDefinition: FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
          collection: Object.freeze({ available: true, ...collection }),
          limitations: Object.freeze(["Exact export collection is in progress; readiness is reported only after an accepted generation head is persisted."]),
        });
      }
      const storedPlanSet = await dependencies.getStoredPlanSet(scope, head.planSetId);
      if (storedPlanSet === null || storedPlanSet.contentSha256 !== head.planSetContentSha256) fail("STORED_EVIDENCE_INVALID", 500);
      const storedPlans = await Promise.all(storedPlanSet.planIds.map((planId) => dependencies.getStoredPlan(scope, planId)));
      if (storedPlans.some((plan) => plan === null)) fail("STORED_EVIDENCE_INVALID", 500);
      let envelope: ComputeOptimizerExportPlanEnvelope;
      try { envelope = await dependencies.createEnvelope(); } catch {
        return jsonResponse({
          schema: "sutra.finops-compute-optimizer.v2", connectionId: connection.id,
          sourceState: "EVIDENCE_KEY_UNAVAILABLE", dashboard: null,
          officialDefinition: FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
          collection: Object.freeze({ available: false, state: "EXACT_EVIDENCE_KEY_NOT_CONFIGURED" }),
          limitations: Object.freeze(["Accepted evidence exists but its regional plan envelopes cannot be authenticated by this runtime."]),
        }, { status: 503 });
      }
      const planSet = await dependencies.readPlanSet({ scope, storedPlanSet,
        storedPlans: storedPlans.filter((plan): plan is StoredComputeOptimizerExportPlan => plan !== null), envelope });
      const generation = await dependencies.getGeneration(scope, planSet, head.generationId);
      if (generation === null) fail("STORED_EVIDENCE_INVALID", 500);
      const dashboard = await dependencies.buildDashboard({ scope, planSet, generation, filters: query.filters });
      const ageHours = Math.round(Math.max(0,
        (dependencies.nowMs() - Date.parse(generation.dataThroughAtIso)) / 3_600_000) * 100) / 100;
      return jsonResponse({
        schema: "sutra.finops-compute-optimizer.v2", connectionId: connection.id,
        source: "AWS_COMPUTE_OPTIMIZER_EXACT_ORGANIZATION_S3_EXPORT",
        sourceState: ageHours > 48 ? "STALE" : "READY",
        freshness: Object.freeze({ dataThroughAt: generation.dataThroughAtIso, ageHours, staleAfterHours: 48 }),
        dashboard, officialDefinition: FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
        evidence: Object.freeze({ acceptedHead: head, planIds: planSet.planIds,
          schemaAssurances: generation.schemaAssurances, unresolvedEvidence: generation.unresolvedEvidence }),
        collection: Object.freeze({ available: true, state: "READY",
          acceptedGenerationId: head.generationId }),
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
