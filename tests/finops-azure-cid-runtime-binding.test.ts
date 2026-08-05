import assert from "node:assert/strict";
import test from "node:test";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  AZURE_CID_RUNTIME_ACTIVATION_REASON,
  AZURE_CID_RUNTIME_BINDING,
  AZURE_CID_RUNTIME_JOB_KIND,
  AzureCidRuntimeBindingError,
  azureCidCollectionWindow,
  createAzureCidRuntimeHandler,
  runAzureCidRuntimeJob,
  scheduleAzureCidCollections,
  type AzureCidRuntimeDependencies,
  type AzureCidRuntimeResult,
} from "../lib/finops-azure-cid-runtime-binding.ts";

const SOURCE = `azsrc_${"a".repeat(32)}`;
const WINDOW = "2026-08-01T00:00:00.000Z";
const SCOPE = { organizationId: "org_azure", customerId: "customer_azure", sourceId: SOURCE };
const BOUNDARY = {
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  sourceId: SCOPE.sourceId,
  azureTenantId: "123e4567-e89b-42d3-a456-426614174000",
  billingScopeKind: "BILLING_ACCOUNT" as const,
  billingScopeHash: "b".repeat(64),
};
const RESULT: AzureCidRuntimeResult = {
  generationId: `azcg_${"c".repeat(64)}`,
  sourceGenerationId: `azcid_${"d".repeat(64)}`,
  state: "READY",
  becameActive: true,
};

function job(overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: `job_${"1".repeat(32)}`,
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: null,
    kind: AZURE_CID_RUNTIME_JOB_KIND,
    payload: { sourceId: SOURCE, scheduledWindow: WINDOW },
    attempt: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function dependencies(overrides: Partial<AzureCidRuntimeDependencies> = {}): AzureCidRuntimeDependencies {
  return {
    loadScope: async () => BOUNDARY,
    broker: { collect: async () => { throw new Error("must not collect during replay"); } },
    store: { recordCapture: async () => { throw new Error("must not persist during replay"); } },
    replayStore: {
      claim: async () => ({ state: "COMPLETED", result: RESULT, resultSha256: await digest(RESULT) }),
      complete: async () => undefined,
      fail: async () => undefined,
    },
    now: () => Date.parse("2026-08-01T01:00:00.000Z"),
    ...overrides,
  };
}

test("Azure CID daily scheduler prevalidates sources and emits identity-only jobs", async () => {
  const second = `azsrc_${"b".repeat(32)}`;
  const queued: unknown[] = [];
  assert.equal(azureCidCollectionWindow(Date.parse("2026-08-01T18:00:00.000Z")), WINDOW);
  const count = await scheduleAzureCidCollections({
    scheduledWindow: WINDOW,
    loadEligibleSources: async () => [{ ...SCOPE, sourceId: second }, SCOPE],
    queue: { enqueue: async (value) => { queued.push(value); } },
  });
  assert.equal(count, 2);
  assert.deepEqual((queued[0] as { payload: unknown }).payload, { sourceId: SOURCE, scheduledWindow: WINDOW });
  assert.equal((queued[0] as { maxAttempts: number }).maxAttempts, 5);
  assert.equal(JSON.stringify(queued).includes(BOUNDARY.azureTenantId), false);

  let enqueued = false;
  await assert.rejects(scheduleAzureCidCollections({
    scheduledWindow: WINDOW,
    loadEligibleSources: async () => [SCOPE, SCOPE],
    queue: { enqueue: async () => { enqueued = true; } },
  }), (error) => error instanceof AzureCidRuntimeBindingError && error.code === "SCOPE_REJECTED");
  assert.equal(enqueued, false);
});

test("Azure CID runtime replays a hash-verified result without provider or persistence access", async () => {
  const replay = await runAzureCidRuntimeJob(job(), dependencies());
  assert.deepEqual(replay, { disposition: "REPLAYED", result: RESULT });
  await assert.rejects(runAzureCidRuntimeJob(job(), dependencies({
    replayStore: {
      claim: async () => ({ state: "COMPLETED", result: RESULT, resultSha256: "e".repeat(64) }),
      complete: async () => undefined,
      fail: async () => undefined,
    },
  })), (error) => error instanceof AzureCidRuntimeBindingError && error.code === "COLLECTION_FAILED");
});

test("Azure CID runtime reports a missing adapter without claiming activation", async () => {
  let claimed = false;
  const result = await runAzureCidRuntimeJob(job(), dependencies({
    broker: null,
    replayStore: {
      claim: async () => { claimed = true; return { state: "IN_PROGRESS" }; },
      complete: async () => undefined,
      fail: async () => undefined,
    },
  }));
  assert.deepEqual(result, {
    disposition: "CONFIGURATION_REQUIRED",
    result: null,
    reason: AZURE_CID_RUNTIME_ACTIVATION_REASON,
  });
  assert.equal(claimed, false);
  assert.equal(AZURE_CID_RUNTIME_BINDING.registeredInSharedRuntime, false);
});

test("Azure CID runtime rejects lease and source substitution before provider access", async () => {
  for (const malformed of [
    job({ maxAttempts: 4 }),
    job({ attempt: 6 }),
    job({ connectionId: `conn_${"f".repeat(32)}` }),
    job({ payload: { sourceId: SOURCE, scheduledWindow: "2026-99-01T00:00:00.000Z" } }),
  ]) await assert.rejects(runAzureCidRuntimeJob(malformed, dependencies()),
    (error) => error instanceof AzureCidRuntimeBindingError && error.code === "INVALID_JOB");

  await assert.rejects(runAzureCidRuntimeJob(job(), dependencies({
    loadScope: async () => ({ ...BOUNDARY, customerId: "customer_attacker" }),
  })), (error) => error instanceof AzureCidRuntimeBindingError
    && error.code === "SCOPE_REJECTED" && !error.message.includes("attacker"));
});

test("Azure CID shared handler retries an in-progress durable claim", async () => {
  const handler = createAzureCidRuntimeHandler(dependencies({
    replayStore: {
      claim: async () => ({ state: "IN_PROGRESS" }),
      complete: async () => undefined,
      fail: async () => undefined,
    },
  }));
  await assert.rejects(handler(job()),
    (error) => error instanceof AzureCidRuntimeBindingError && error.code === "COLLECTION_FAILED");
});
