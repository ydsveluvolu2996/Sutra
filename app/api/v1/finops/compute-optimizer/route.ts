import { ComputeOptimizerExactGenerationRepository } from
  "../../../../../db/finops-compute-optimizer-exact-generation-repository";
import { ComputeOptimizerExportPlanRepository } from
  "../../../../../db/finops-compute-optimizer-export-plan-repository";
import { ComputeOptimizerExportPlanSetRepository } from
  "../../../../../db/finops-compute-optimizer-export-plan-set-repository";
import { ComputeOptimizerActivationRepository } from
  "../../../../../db/finops-compute-optimizer-activation-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildComputeOptimizerExactDashboard } from
  "../../../../../lib/finops-compute-optimizer-exact-dashboard";
import { createComputeOptimizerExactGetHandler } from
  "../../../../../lib/finops-compute-optimizer-exact-route-handler";
import { ComputeOptimizerExportPlanEnvelope } from
  "../../../../../lib/finops-compute-optimizer-export-plan-envelope";
import { readComputeOptimizerExportPlanSet } from
  "../../../../../lib/finops-compute-optimizer-export-plan-set-reader";
import { createComputeOptimizerCapabilityPostHandler } from
  "../../../../../lib/finops-compute-optimizer-capability-route-handler";
import { assertSameOrigin, readBoundedJson } from
  "../../../../../lib/aws-pilot-security";
import { runComputeOptimizerMaterializationActivationManifest } from
  "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const exactRepository = new ComputeOptimizerExactGenerationRepository();
const planSetRepository = new ComputeOptimizerExportPlanSetRepository();
const planRepository = new ComputeOptimizerExportPlanRepository();
const activationRepository = new ComputeOptimizerActivationRepository();

export const GET = createComputeOptimizerExactGetHandler({
  requireSession: requireApiSession,
  getConnection: getConnectionForOrg,
  assertRead: (auth, customerId) => assertSessionCapability(auth, "connection:read", customerId),
  getHeadReference: (scope) => exactRepository.getAcceptedHeadReference(scope),
  getCollectionState: async (scope) => {
    const capability = await activationRepository.getCurrentCapability(scope);
    if (capability === null || !capability.enabled) return {
      state: "UNAVAILABLE" as const,
      activationId: null,
      scheduledWindow: null,
      updatedAtIso: null,
    };
    const latest = await activationRepository.getLatestActivation(scope);
    if (latest === null) return {
      state: "COLLECTING" as const,
      activationId: null,
      scheduledWindow: null,
      updatedAtIso: capability.verifiedAtIso,
    };
    if (latest.state === "COMPLETE") {
      throw Object.assign(new Error("Accepted Compute Optimizer head missing"), {
        code: "STORED_EVIDENCE_INVALID",
        status: 500,
      });
    }
    return {
      state: latest.state === "FAILED" ? "FAILED" as const : "COLLECTING" as const,
      activationId: latest.activationId,
      scheduledWindow: latest.scheduledWindow,
      updatedAtIso: latest.updatedAtIso,
    };
  },
  getStoredPlanSet: (scope, planSetId) => planSetRepository.getPlanSet(scope, planSetId),
  getStoredPlan: (scope, planId) => planRepository.getPlan(scope, planId),
  createEnvelope: () => ComputeOptimizerExportPlanEnvelope.fromEnvironment(),
  readPlanSet: readComputeOptimizerExportPlanSet,
  getGeneration: (scope, planSet, generationId) =>
    exactRepository.getAcceptedGeneration(scope, planSet, generationId),
  buildDashboard: buildComputeOptimizerExactDashboard,
  nowMs: Date.now,
});

export const POST = createComputeOptimizerCapabilityPostHandler({
  assertSameOrigin,
  readBody: readBoundedJson,
  requireSession: requireApiSession,
  getConnection: getConnectionForOrg,
  assertManage: (auth, customerId) =>
    assertSessionCapability(auth, "connection:manage", customerId),
  transport: {
    readActivationManifest: (request, context) =>
      runComputeOptimizerMaterializationActivationManifest(request, {
        signal: context.signal,
        deadlineAtMs: Date.now() + 15_000,
      }),
  },
  getCurrentCapability: (scope) => activationRepository.getCurrentCapability(scope),
  recordCapability: (scope, input, nowMs) =>
    activationRepository.recordCapability(scope, input, nowMs),
  nowMs: Date.now,
});
