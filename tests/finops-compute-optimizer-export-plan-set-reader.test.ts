import assert from "node:assert/strict";
import test from "node:test";

import type { StoredComputeOptimizerExportPlan } from
  "../db/finops-compute-optimizer-export-plan-repository.ts";
import type { StoredComputeOptimizerExportPlanSet } from
  "../db/finops-compute-optimizer-export-plan-set-repository.ts";
import {
  ComputeOptimizerExportPlanEnvelope,
} from "../lib/finops-compute-optimizer-export-plan-envelope.ts";
import { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } from
  "../lib/finops-compute-optimizer-export-field-catalog.ts";
import {
  createComputeOptimizerExportPlanSet,
} from "../lib/finops-compute-optimizer-export-plan.ts";
import {
  ComputeOptimizerExportPlanSetReaderError,
  readComputeOptimizerExportPlanSet,
} from "../lib/finops-compute-optimizer-export-plan-set-reader.ts";

const SCOPE = {
  organizationId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
};
const ACCOUNT_ID = "111122223333";
const DISCOVERY_RUN_ID = `cor_${"b".repeat(64)}`;
const ROOT_KEY = new Uint8Array(32).fill(7);

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function fixture() {
  const planSet = await createComputeOptimizerExportPlanSet({
    scope: {
      orgId: SCOPE.organizationId,
      customerId: SCOPE.customerId,
      connectionId: SCOPE.connectionId,
    },
    requesterAccountId: ACCOUNT_ID,
    partition: "aws",
    regions: ["ap-south-1", "us-east-1"],
    exportFamilies: ["EC2_INSTANCE"],
    targets: ["ap-south-1", "us-east-1"].map((region) => ({
      region,
      exportFamily: "EC2_INSTANCE" as const,
      bucket: `sutra-co-${region}`,
      optionalPrefix: null,
      effectivePrefix: `compute-optimizer/${ACCOUNT_ID}/`,
      request: {
        operation: "ExportEC2InstanceRecommendations" as const,
        region,
        fileFormat: "Csv" as const,
        includeMemberAccounts: true as const,
        filters: [] as const,
        fieldsToExport: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE.minimumProjection,
        s3DestinationConfig: { bucket: `sutra-co-${region}`, keyPrefix: null },
      },
      expectedJob: {
        jobId: `job-${region}`,
        providerResourceType: "Ec2Instance" as const,
        bucket: `sutra-co-${region}`,
        objectKey: `compute-optimizer/${ACCOUNT_ID}/${region}-2026-08-02T000000Z-job-${region}.csv`,
        metadataKey: `compute-optimizer/${ACCOUNT_ID}/${region}-2026-08-02T000000Z-job-${region}-metadata.json`,
      },
    })),
  });
  const envelope = await ComputeOptimizerExportPlanEnvelope.fromRawRootKey({
    rootKey: ROOT_KEY,
    keyVersion: "test-v1",
  });
  const storedPlans = await Promise.all(planSet.plans.map(async (plan) => {
    const sealedEnvelope = await envelope.seal(plan, {
      orgId: SCOPE.organizationId,
      customerId: SCOPE.customerId,
      connectionId: SCOPE.connectionId,
      discoveryRunId: DISCOVERY_RUN_ID,
      planId: plan.planId,
      contentSha256: plan.contentSha256,
    });
    const sealedEnvelopeSha256 = await sha256(sealedEnvelope.ciphertext);
    const storedIdentity = {
      scope: SCOPE,
      discoveryRunId: DISCOVERY_RUN_ID,
      planId: plan.planId,
      contentSha256: plan.contentSha256,
      requesterAccountId: ACCOUNT_ID,
      partition: "aws" as const,
      region: plan.regions[0]!,
      regionCount: planSet.regions.length,
      exportFamilyCount: planSet.exportFamilies.length,
      targetCount: plan.targets.length,
    };
    return {
      ...storedIdentity,
      sealedEnvelope,
      sealedEnvelopeSha256,
      bindingSha256: await sha256(JSON.stringify({
        ...storedIdentity,
        sealedEnvelopeSha256,
        format: sealedEnvelope.format,
        keyVersion: sealedEnvelope.keyVersion,
      })),
      createdAtIso: "2026-08-02T00:00:00.000Z",
    } satisfies StoredComputeOptimizerExportPlan;
  }));
  const storedPlanSet: StoredComputeOptimizerExportPlanSet = {
    scope: SCOPE,
    planSetId: planSet.planSetId,
    contentSha256: planSet.contentSha256,
    requesterAccountId: ACCOUNT_ID,
    partition: "aws",
    regions: planSet.regions,
    exportFamilies: planSet.exportFamilies,
    planIds: planSet.planIds,
    bindingSha256: await sha256(JSON.stringify({
      scope: SCOPE,
      planSetId: planSet.planSetId,
      contentSha256: planSet.contentSha256,
      planIds: planSet.planIds,
    })),
    createdAtIso: "2026-08-02T00:00:00.000Z",
  };
  return { envelope, planSet, storedPlans, storedPlanSet };
}

test("rehydrates authenticated regional envelopes in immutable plan-set order", async () => {
  const value = await fixture();
  const result = await readComputeOptimizerExportPlanSet({
    scope: SCOPE,
    storedPlanSet: value.storedPlanSet,
    storedPlans: [...value.storedPlans].reverse(),
    envelope: value.envelope,
  });
  assert.equal(result.planSetId, value.planSet.planSetId);
  assert.deepEqual(result.planIds, value.planSet.planIds);
  assert.deepEqual(result.plans.map((plan) => plan.regions[0]), value.planSet.regions);
});

test("rejects stored region, scope and plan-set identity substitution", async () => {
  const value = await fixture();
  const expectRejected = async (input: Parameters<typeof readComputeOptimizerExportPlanSet>[0]) =>
    assert.rejects(readComputeOptimizerExportPlanSet(input),
      (error: unknown) => error instanceof ComputeOptimizerExportPlanSetReaderError);
  await expectRejected({
    scope: SCOPE,
    storedPlanSet: value.storedPlanSet,
    storedPlans: [{ ...value.storedPlans[0]!, region: "eu-west-1" }, value.storedPlans[1]!],
    envelope: value.envelope,
  });
  await expectRejected({
    scope: { ...SCOPE, organizationId: "org_other" },
    storedPlanSet: value.storedPlanSet,
    storedPlans: value.storedPlans,
    envelope: value.envelope,
  });
  await expectRejected({
    scope: SCOPE,
    storedPlanSet: { ...value.storedPlanSet, contentSha256: "f".repeat(64) },
    storedPlans: value.storedPlans,
    envelope: value.envelope,
  });
});

test("rejects missing, duplicate and ciphertext-substituted regional plans", async () => {
  const value = await fixture();
  const expectRejected = async (storedPlans: readonly StoredComputeOptimizerExportPlan[]) =>
    assert.rejects(readComputeOptimizerExportPlanSet({
      scope: SCOPE,
      storedPlanSet: value.storedPlanSet,
      storedPlans,
      envelope: value.envelope,
    }), (error: unknown) => error instanceof ComputeOptimizerExportPlanSetReaderError);
  await expectRejected(value.storedPlans.slice(0, 1));
  await expectRejected([value.storedPlans[0]!, value.storedPlans[0]!]);
  const first = value.storedPlans[0]!;
  const changed = first.sealedEnvelope.ciphertext.endsWith("A") ? "B" : "A";
  await expectRejected([{
    ...first,
    sealedEnvelope: {
      ...first.sealedEnvelope,
      ciphertext: `${first.sealedEnvelope.ciphertext.slice(0, -1)}${changed}`,
    },
  }, value.storedPlans[1]!]);
  await expectRejected([{ ...first, sealedEnvelopeSha256: "f".repeat(64) }, value.storedPlans[1]!]);
  await expectRejected([{ ...first, bindingSha256: "f".repeat(64) }, value.storedPlans[1]!]);
  await assert.rejects(readComputeOptimizerExportPlanSet({
    scope: SCOPE,
    storedPlanSet: { ...value.storedPlanSet, bindingSha256: "f".repeat(64) },
    storedPlans: value.storedPlans,
    envelope: value.envelope,
  }), (error: unknown) => error instanceof ComputeOptimizerExportPlanSetReaderError);
});
