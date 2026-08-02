import { ComputeOptimizerExactGenerationRepository } from
  "../../../../../db/finops-compute-optimizer-exact-generation-repository";
import { ComputeOptimizerExportPlanRepository } from
  "../../../../../db/finops-compute-optimizer-export-plan-repository";
import { ComputeOptimizerExportPlanSetRepository } from
  "../../../../../db/finops-compute-optimizer-export-plan-set-repository";
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

export const dynamic = "force-dynamic";

const exactRepository = new ComputeOptimizerExactGenerationRepository();
const planSetRepository = new ComputeOptimizerExportPlanSetRepository();
const planRepository = new ComputeOptimizerExportPlanRepository();

export const GET = createComputeOptimizerExactGetHandler({
  requireSession: requireApiSession,
  getConnection: getConnectionForOrg,
  assertRead: (auth, customerId) => assertSessionCapability(auth, "connection:read", customerId),
  getHeadReference: (scope) => exactRepository.getAcceptedHeadReference(scope),
  getStoredPlanSet: (scope, planSetId) => planSetRepository.getPlanSet(scope, planSetId),
  getStoredPlan: (scope, planId) => planRepository.getPlan(scope, planId),
  createEnvelope: () => ComputeOptimizerExportPlanEnvelope.fromEnvironment(),
  readPlanSet: readComputeOptimizerExportPlanSet,
  getGeneration: (scope, planSet, generationId) =>
    exactRepository.getAcceptedGeneration(scope, planSet, generationId),
  buildDashboard: buildComputeOptimizerExactDashboard,
  nowMs: Date.now,
});
