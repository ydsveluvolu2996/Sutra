/**
 * Rehydrates a persisted Compute Optimizer plan set from authenticated regional
 * plan envelopes. Repository rows are treated as hostile until every stored
 * identity and the regenerated content-addressed plan set agree.
 */
import type {
  StoredComputeOptimizerExportPlan,
} from "../db/finops-compute-optimizer-export-plan-repository.ts";
import type {
  StoredComputeOptimizerExportPlanSet,
} from "../db/finops-compute-optimizer-export-plan-set-repository.ts";
import {
  ComputeOptimizerExportPlanEnvelope,
} from "./finops-compute-optimizer-export-plan-envelope.ts";
import {
  verifyComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlanSet,
} from "./finops-compute-optimizer-export-plan.ts";

export interface ComputeOptimizerExportPlanSetReaderScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export class ComputeOptimizerExportPlanSetReaderError extends Error {
  public constructor() {
    super("Compute Optimizer persisted plan set rejected");
    this.name = "ComputeOptimizerExportPlanSetReaderError";
  }
}

function reject(): never {
  throw new ComputeOptimizerExportPlanSetReaderError();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameScope(
  left: ComputeOptimizerExportPlanSetReaderScope,
  right: ComputeOptimizerExportPlanSetReaderScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function verifyStoredBindings(
  scope: ComputeOptimizerExportPlanSetReaderScope,
  planSet: StoredComputeOptimizerExportPlanSet,
  plans: readonly StoredComputeOptimizerExportPlan[],
): Promise<void> {
  const setBinding = JSON.stringify({
    scope,
    planSetId: planSet.planSetId,
    contentSha256: planSet.contentSha256,
    planIds: planSet.planIds,
  });
  if (await sha256(setBinding) !== planSet.bindingSha256) reject();
  for (const stored of plans) {
    const sealedEnvelopeSha256 = await sha256(stored.sealedEnvelope.ciphertext);
    if (sealedEnvelopeSha256 !== stored.sealedEnvelopeSha256) reject();
    const binding = JSON.stringify({
      scope,
      discoveryRunId: stored.discoveryRunId,
      planId: stored.planId,
      contentSha256: stored.contentSha256,
      requesterAccountId: stored.requesterAccountId,
      partition: stored.partition,
      region: stored.region,
      regionCount: stored.regionCount,
      exportFamilyCount: stored.exportFamilyCount,
      targetCount: stored.targetCount,
      sealedEnvelopeSha256,
      format: stored.sealedEnvelope.format,
      keyVersion: stored.sealedEnvelope.keyVersion,
    });
    if (await sha256(binding) !== stored.bindingSha256) reject();
  }
}

function storedPlanMatchesSet(
  scope: ComputeOptimizerExportPlanSetReaderScope,
  planSet: StoredComputeOptimizerExportPlanSet,
  stored: StoredComputeOptimizerExportPlan,
  expectedRegion: string,
): boolean {
  return sameScope(scope, stored.scope)
    && stored.requesterAccountId === planSet.requesterAccountId
    && stored.partition === planSet.partition
    && stored.region === expectedRegion
    && stored.regionCount === planSet.regions.length
    && stored.exportFamilyCount === planSet.exportFamilies.length
    && stored.targetCount === planSet.exportFamilies.length;
}

function openedPlanMatchesStored(
  plan: ComputeOptimizerExportPlan,
  stored: StoredComputeOptimizerExportPlan,
): boolean {
  return plan.planId === stored.planId
    && plan.contentSha256 === stored.contentSha256
    && plan.scope.orgId === stored.scope.organizationId
    && plan.scope.customerId === stored.scope.customerId
    && plan.scope.connectionId === stored.scope.connectionId
    && plan.requesterAccountId === stored.requesterAccountId
    && plan.partition === stored.partition
    && plan.regions.length === 1
    && plan.regions[0] === stored.region
    && plan.targets.length === stored.targetCount;
}

/**
 * Open and re-verify one immutable plan set. The caller obtains the rows through
 * same-tenant repositories and supplies the configured application envelope.
 */
export async function readComputeOptimizerExportPlanSet(input: {
  readonly scope: ComputeOptimizerExportPlanSetReaderScope;
  readonly storedPlanSet: StoredComputeOptimizerExportPlanSet;
  readonly storedPlans: readonly StoredComputeOptimizerExportPlan[];
  readonly envelope: ComputeOptimizerExportPlanEnvelope;
}): Promise<ComputeOptimizerExportPlanSet> {
  try {
    if (!sameScope(input.scope, input.storedPlanSet.scope)
      || input.storedPlans.length !== input.storedPlanSet.planIds.length
      || input.storedPlanSet.planIds.length !== input.storedPlanSet.regions.length) reject();
    await verifyStoredBindings(input.scope, input.storedPlanSet, input.storedPlans);
    const byId = new Map<string, StoredComputeOptimizerExportPlan>();
    for (const stored of input.storedPlans) {
      if (byId.has(stored.planId)) reject();
      byId.set(stored.planId, stored);
    }
    const plans: ComputeOptimizerExportPlan[] = [];
    for (let index = 0; index < input.storedPlanSet.planIds.length; index += 1) {
      const planId = input.storedPlanSet.planIds[index]!;
      const expectedRegion = input.storedPlanSet.regions[index]!;
      const stored = byId.get(planId);
      if (stored === undefined || !storedPlanMatchesSet(
        input.scope,
        input.storedPlanSet,
        stored,
        expectedRegion,
      )) reject();
      const plan = await input.envelope.open(stored.sealedEnvelope, {
        orgId: input.scope.organizationId,
        customerId: input.scope.customerId,
        connectionId: input.scope.connectionId,
        discoveryRunId: stored.discoveryRunId,
        planId: stored.planId,
        contentSha256: stored.contentSha256,
      });
      if (!openedPlanMatchesStored(plan, stored)
        || !sameStrings(plan.exportFamilies, input.storedPlanSet.exportFamilies)) reject();
      plans.push(plan);
    }
    const verified = await verifyComputeOptimizerExportPlanSet({
      schemaVersion: "sutra.compute-optimizer-export-plan-set.v1",
      planSetId: input.storedPlanSet.planSetId,
      contentSha256: input.storedPlanSet.contentSha256,
      scope: {
        orgId: input.scope.organizationId,
        customerId: input.scope.customerId,
        connectionId: input.scope.connectionId,
      },
      requesterAccountId: input.storedPlanSet.requesterAccountId,
      partition: input.storedPlanSet.partition,
      regions: input.storedPlanSet.regions,
      exportFamilies: input.storedPlanSet.exportFamilies,
      planIds: input.storedPlanSet.planIds,
      plans,
    });
    if (verified.planSetId !== input.storedPlanSet.planSetId
      || verified.contentSha256 !== input.storedPlanSet.contentSha256) reject();
    return verified;
  } catch (error) {
    if (error instanceof ComputeOptimizerExportPlanSetReaderError) throw error;
    reject();
  }
}
