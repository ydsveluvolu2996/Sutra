import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import { runScadCur2RuntimeHandler, SCAD_CUR2_RUNTIME_JOB_KIND,
  type ScadCur2RuntimeResult } from "../lib/finops-scad-durable-runtime-binding.ts";
import { createScadCur2SignedProvider, ScadCur2SignedProviderError } from "../lib/finops-scad-signed-provider.ts";

const JOB = `job_${"a".repeat(32)}`; const CONNECTION = `conn_${"b".repeat(32)}`;
const WINDOW = "2026-08-02T00:00:00.000Z";
const job: RunnableJob = { id: JOB, orgId: "org_scad", customerId: "customer_scad",
  connectionId: CONNECTION, kind: SCAD_CUR2_RUNTIME_JOB_KIND, attempt: 2, maxAttempts: 5,
  payload: { scheduledWindow: WINDOW } };
const recovered: ScadCur2RuntimeResult = { schemaVersion: "sutra.scad-cur2-runtime-result.v1",
  sourceState: "READY", generationId: `scg_${"c".repeat(64)}`, contentSha256: "c".repeat(64),
  activeGenerationId: `fbg_${"d".repeat(64)}`, becameActive: true, failureCodes: [] };

test("orphaned persisted SCAD result completes by replay without provider or snapshot work", async () => {
  let completed = 0;
  const result = await runScadCur2RuntimeHandler(job, {
    loadBoundary: async () => { throw new Error("provider must not run"); },
    adapter: { collectGeneration: async () => { throw new Error("adapter must not run"); } },
    record: async () => { throw new Error("snapshot must not be written twice"); },
    replayStore: {
      claim: async () => ({ state: "ACQUIRED", leaseToken: "lease_recovered", recoveredResult: recovered }),
      checkpoint: async () => { throw new Error("checkpoint already exists"); },
      complete: async (input) => { completed += 1; assert.deepEqual(input.result, recovered); },
      fail: async () => { throw new Error("replay must not fail"); },
    },
  });
  assert.equal(result.disposition, "REPLAYED"); assert.deepEqual(result.result, recovered); assert.equal(completed, 1);
});

test("signed provider rejects a response not bound to the exact request body", async () => {
  const provider = createScadCur2SignedProvider({ jobId: JOB, scheduledWindow: WINDOW,
    transport: { invoke: async () => ({ verified: true, keyId: "broker-key-1",
      responseBodySha256: "e".repeat(64), body: { schemaVersion: "sutra.scad-cur2-provider-response.v1",
        requestId: `scr_${"f".repeat(64)}`, requestBodySha256: "0".repeat(64), payload: {} } }) } });
  const boundary = { schemaVersion: "sutra.scad-cur2-runtime-boundary.v1" as const,
    binding: "SERVER_RESOLVED_SCAD_CUR2_EXPORT" as const,
    scope: { orgId: "org_scad", customerId: "customer_scad", connectionId: CONNECTION,
      partition: "aws" as const, payerAccountIds: ["111111111111"], usageAccountIds: ["111111111111"],
      regions: ["us-east-1"] }, exportName: "sutra_scad",
    exportArn: "arn:aws:bcm-data-exports:us-east-1:111111111111:export/sutra_scad",
    bucket: "sutra-scad-111111111111", prefix: "exports/sutra_scad/",
    billingPeriodStartAt: "2026-08-01T00:00:00.000Z", billingPeriodEndAt: "2026-09-01T00:00:00.000Z",
    scadEnabledAt: "2026-08-01T00:00:00.000Z", firstDeliveryObservedAt: null,
    priorDeliverySequence: 0, lastAcceptedGenerationId: null,
    tableConfiguration: { tableName: "COST_AND_USAGE_REPORT" as const, timeGranularity: "HOURLY" as const,
      includeResources: "TRUE" as const, includeSplitCostAllocationData: "TRUE" as const } };
  await assert.rejects(provider.getManifest(boundary, new AbortController().signal),
    (error: unknown) => error instanceof ScadCur2SignedProviderError && error.code === "BROKER_RESPONSE_INVALID");
});
