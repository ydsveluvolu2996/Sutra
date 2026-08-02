/** Crash-safe read-before-seal persistence for immutable regional plan envelopes. */
import type {
  ComputeOptimizerActivationReadyPersistenceInput,
} from "./finops-compute-optimizer-activation-producer.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { ComputeOptimizerActivationBoundary } from
  "./finops-compute-optimizer-activation-jobs.ts";
import type { ComputeOptimizerExportPlanEnvelope } from
  "./finops-compute-optimizer-export-plan-envelope.ts";
import type { ComputeOptimizerExportPlanRepository } from
  "../db/finops-compute-optimizer-export-plan-repository.ts";
import type { ComputeOptimizerExportPlanSetRepository } from
  "../db/finops-compute-optimizer-export-plan-set-repository.ts";
import type { ComputeOptimizerActivationRepository } from
  "../db/finops-compute-optimizer-activation-repository.ts";

export interface ComputeOptimizerReadyPlanPersistenceDependencies {
  readonly planRepository: Pick<ComputeOptimizerExportPlanRepository, "getPlan" | "recordPlan">;
  readonly planSetRepository: Pick<ComputeOptimizerExportPlanSetRepository, "recordPlanSet">;
  readonly activationRepository: Pick<ComputeOptimizerActivationRepository, "stageReadyAndOutbox">;
  readonly envelope: Pick<ComputeOptimizerExportPlanEnvelope, "seal" | "open">;
  readonly nowMs?: () => number;
}

function assertActive(
  boundary: ComputeOptimizerActivationBoundary,
  nowMs: () => number,
): void {
  if (boundary.signal.aborted) throw new Error("compute-optimizer-boundary-aborted");
  if (nowMs() >= boundary.deadlineAtMs) {
    throw new Error("compute-optimizer-boundary-deadline-exceeded");
  }
}

async function verifyStoredPlan(
  dependencies: ComputeOptimizerReadyPlanPersistenceDependencies,
  scope: { readonly organizationId: string; readonly customerId: string; readonly connectionId: string },
  discoveryRunId: string,
  expected: ComputeOptimizerActivationReadyPersistenceInput["regionalPlans"][number],
  stored: NonNullable<Awaited<ReturnType<ComputeOptimizerExportPlanRepository["getPlan"]>>>,
): Promise<void> {
  const opened = await dependencies.envelope.open(stored.sealedEnvelope, {
    orgId: scope.organizationId,
    customerId: scope.customerId,
    connectionId: scope.connectionId,
    discoveryRunId,
    planId: expected.planId,
    contentSha256: expected.contentSha256,
  });
  if (canonicalJson(opened) !== canonicalJson(expected)
    || stored.discoveryRunId !== discoveryRunId) {
    throw new Error("compute-optimizer-plan-replay-conflict");
  }
}

export async function persistComputeOptimizerReadyPlansReadBeforeSealCore(
  input: ComputeOptimizerActivationReadyPersistenceInput,
  boundary: ComputeOptimizerActivationBoundary,
  dependencies: ComputeOptimizerReadyPlanPersistenceDependencies,
): Promise<void> {
  const nowMs = dependencies.nowMs ?? Date.now;
  assertActive(boundary, nowMs);
  const scope = {
    organizationId: input.activation.scope.orgId,
    customerId: input.activation.scope.customerId,
    connectionId: input.activation.scope.connectionId,
  };
  for (let index = 0; index < input.regionalPlans.length; index += 1) {
    assertActive(boundary, nowMs);
    const plan = input.regionalPlans[index]!;
    const reference = input.regionalPlanDiscoveryReferences[index];
    if (reference === undefined || reference.planId !== plan.planId
      || reference.region !== plan.regions[0]) {
      throw new Error("compute-optimizer-plan-lineage-invalid");
    }
    let existing = await dependencies.planRepository.getPlan(scope, plan.planId);
    assertActive(boundary, nowMs);
    if (existing !== null) {
      await verifyStoredPlan(dependencies, scope, reference.discoveryRunId, plan, existing);
      continue;
    }
    const context = {
      orgId: scope.organizationId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      discoveryRunId: reference.discoveryRunId,
      planId: plan.planId,
      contentSha256: plan.contentSha256,
    };
    const sealedEnvelope = await dependencies.envelope.seal(plan, context);
    assertActive(boundary, nowMs);
    try {
      await dependencies.planRepository.recordPlan(scope, {
        discoveryRunId: reference.discoveryRunId,
        planId: plan.planId,
        contentSha256: plan.contentSha256,
        requesterAccountId: plan.requesterAccountId,
        partition: plan.partition,
        region: plan.regions[0]!,
        regionCount: plan.regions.length,
        exportFamilyCount: plan.exportFamilies.length,
        targetCount: plan.targets.length,
        sealedEnvelope,
      });
      assertActive(boundary, nowMs);
    } catch {
      // AES-GCM sealing is randomized. If a writer wins the insert race, read
      // and authenticate that immutable envelope instead of re-sealing.
      existing = await dependencies.planRepository.getPlan(scope, plan.planId);
      assertActive(boundary, nowMs);
      if (existing === null) throw new Error("compute-optimizer-plan-persistence-failed");
      await verifyStoredPlan(dependencies, scope, reference.discoveryRunId, plan, existing);
    }
  }
  assertActive(boundary, nowMs);
  await dependencies.planSetRepository.recordPlanSet(scope, input.checkpoint.planSet!);
  assertActive(boundary, nowMs);
  await dependencies.activationRepository.stageReadyAndOutbox(scope, input);
}
