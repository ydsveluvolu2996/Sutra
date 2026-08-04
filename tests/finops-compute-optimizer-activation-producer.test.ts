import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalJson } from "../lib/canonical-json.ts";
import {
  ComputeOptimizerActivationProducerError,
  createComputeOptimizerActivationProducer,
  type ComputeOptimizerActivationProducerDependencies,
  type ComputeOptimizerActivationProducerInput,
  type ComputeOptimizerActivationReadyPersistenceInput,
  type ComputeOptimizerActivationBlockedOutcome,
  type ComputeOptimizerDiscoveryRefreshRequiredOutcome,
} from "../lib/finops-compute-optimizer-activation-producer.ts";
import type {
  ComputeOptimizerExportLaunchAttempt,
  ComputeOptimizerExportLaunchExecution,
  ComputeOptimizerExportLaunchOutcome,
} from "../lib/finops-compute-optimizer-export-launch.ts";
import type {
  ComputeOptimizerExactDescribeRequest,
  ComputeOptimizerExactDescribeResponse,
} from "../services/aws-collector/src/compute-optimizer-export-exact-describe.ts";
import type {
  ComputeOptimizerMaterializationActivationManifest,
  ComputeOptimizerMaterializationActivationManifestRequest,
} from "../services/aws-collector/src/compute-optimizer-materialization-activation-manifest.ts";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const CONNECTION = `conn_${"a".repeat(32)}`;
const REGIONS = ["us-east-1", "us-west-2"] as const;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

async function waitForDependencyStart(
  started: () => boolean,
  controller: AbortController,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!started() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!started()) {
    controller.abort();
    assert.fail("dependency did not start before the test boundary");
  }
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function rawHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function input(overrides: Partial<ComputeOptimizerActivationProducerInput> = {}):
ComputeOptimizerActivationProducerInput {
  return {
    scope: {
      orgId: "org-producer",
      customerId: "tenant-producer",
      connectionId: CONNECTION,
    },
    requesterAccountId: "123456789012",
    partition: "aws",
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    sealedAtIso: "2026-08-02T00:01:00.000Z",
    attemptNumber: 1,
    enabledRegions: [...REGIONS].reverse(),
    requestId: "activation-request-1",
    jobId: "scheduled-job-1",
    deadlineAtMs: NOW + 60_000,
    ...overrides,
  };
}

function manifest(
  request: ComputeOptimizerMaterializationActivationManifestRequest,
): ComputeOptimizerMaterializationActivationManifest {
  return {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId: request.requestId,
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    accountId: request.accountId,
    partition: request.partition,
    permissionPackVersion: "standard-2026-08.5",
    regions: REGIONS.map((region, index) => ({
      region,
      describeContractId: `describe-${region}`,
      launchContractId: `launch-${region}`,
      objectReadContractId: `object-${region}`,
      bucket: `sutra-co-${index + 1}-123456789012`,
      basePrefix: "exports/",
      effectivePrefix: "exports/compute-optimizer/123456789012/",
    })),
  };
}

async function execution(
  attempt: ComputeOptimizerExportLaunchAttempt,
  partial = false,
): Promise<ComputeOptimizerExportLaunchExecution> {
  const outcomes: ComputeOptimizerExportLaunchOutcome[] = attempt.targets.map((target, index) => {
    if (partial && index === 0) {
      return {
        targetId: target.targetId,
        exportFamily: target.exportFamily,
        operation: target.operation,
        status: "FAILED",
        jobId: null,
        bucket: null,
        objectKey: null,
        metadataKey: null,
        errorCode: "RATE_LIMITED",
      };
    }
    if (partial) {
      return {
        targetId: target.targetId,
        exportFamily: target.exportFamily,
        operation: target.operation,
        status: "NOT_ATTEMPTED",
        jobId: null,
        bucket: null,
        objectKey: null,
        metadataKey: null,
        errorCode: "RATE_LIMITED",
      };
    }
    const jobId = `job-${attempt.region}-${index + 1}`;
    const objectKey = `${target.effectivePrefix}${target.region}-daily-${jobId}.csv`;
    return {
      targetId: target.targetId,
      exportFamily: target.exportFamily,
      operation: target.operation,
      status: "SUCCEEDED",
      jobId,
      bucket: target.bucket,
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
      errorCode: null,
    };
  });
  const body = {
    schemaVersion: "sutra.compute-optimizer-export-launch-execution.v1" as const,
    requestBatchId: attempt.requestBatchId,
    launchAttemptId: attempt.launchAttemptId,
    status: partial ? "PARTIAL" as const : "COMPLETE" as const,
    startedAtIso: "2026-08-02T00:02:00.000Z",
    finishedAtIso: "2026-08-02T00:03:00.000Z",
    outcomes,
  };
  const contentSha256 = await hash(body);
  return {
    ...body,
    executionId: `coele_${contentSha256}`,
    contentSha256,
  };
}

function describeResponse(request: ComputeOptimizerExactDescribeRequest):
ComputeOptimizerExactDescribeResponse {
  return {
    schema: "sutra.compute-optimizer-export-exact-describe-response.v1",
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    collectionJobId: request.collectionJobId,
    contractId: request.contractId,
    accountId: request.accountId,
    partition: request.partition,
    region: request.region,
    observedAtIso: "2026-08-02T00:04:00.000Z",
    jobs: request.plannedJobs.map((job) => ({
      ...job,
      jobId: job.plannedJobId,
      status: "COMPLETE",
      creationTimestampIso: "2026-08-02T00:02:00.000Z",
      lastUpdatedTimestampIso: "2026-08-02T00:03:00.000Z",
      destination: {
        bucket: job.bucket,
        objectKey: job.objectKey,
        metadataKey: job.metadataKey,
      },
    })),
  };
}

interface Harness {
  readonly dependencies: ComputeOptimizerActivationProducerDependencies;
  readonly manifests: ComputeOptimizerMaterializationActivationManifestRequest[];
  readonly launches: Array<{
    readonly attempt: ComputeOptimizerExportLaunchAttempt;
    readonly context: Readonly<Record<string, unknown>>;
  }>;
  readonly describes: ComputeOptimizerExactDescribeRequest[];
  readonly discoveryLoads: Array<Readonly<Record<string, unknown>>>;
  readonly ready: ComputeOptimizerActivationReadyPersistenceInput[];
  readonly blocked: ComputeOptimizerActivationBlockedOutcome[];
  readonly refreshRequired: ComputeOptimizerDiscoveryRefreshRequiredOutcome[];
  readonly events: string[];
}

function harness(options: {
  readonly partialRegion?: string;
  readonly manifestValue?: (request: ComputeOptimizerMaterializationActivationManifestRequest) => unknown;
  readonly launchValue?: (attempt: ComputeOptimizerExportLaunchAttempt) => Promise<unknown>;
  readonly describeValue?: (request: ComputeOptimizerExactDescribeRequest) => unknown;
  readonly discoveryValue?: (input: Readonly<Record<string, unknown>>) => unknown;
  readonly persist?: (input: ComputeOptimizerActivationReadyPersistenceInput) => Promise<unknown>;
  readonly blockedSink?: (outcome: ComputeOptimizerActivationBlockedOutcome) => Promise<unknown>;
  readonly refreshSink?: (outcome: ComputeOptimizerDiscoveryRefreshRequiredOutcome) => Promise<unknown>;
} = {}): Harness {
  const manifests: ComputeOptimizerMaterializationActivationManifestRequest[] = [];
  const launches: Harness["launches"] extends readonly (infer T)[] ? T[] : never = [];
  const describes: ComputeOptimizerExactDescribeRequest[] = [];
  const discoveryLoads: Array<Readonly<Record<string, unknown>>> = [];
  const ready: ComputeOptimizerActivationReadyPersistenceInput[] = [];
  const blocked: ComputeOptimizerActivationBlockedOutcome[] = [];
  const refreshRequired: ComputeOptimizerDiscoveryRefreshRequiredOutcome[] = [];
  const events: string[] = [];
  return {
    manifests,
    launches,
    describes,
    discoveryLoads,
    ready,
    blocked,
    refreshRequired,
    events,
    dependencies: {
      now: () => NOW,
      manifestTransport: {
        readActivationManifest: async (request) => {
          events.push("manifest");
          manifests.push(structuredClone(request));
          return options.manifestValue?.(request) ?? manifest(request);
        },
      },
      launchTransport: {
        launchExact: async (attempt, context) => {
          events.push(`launch:${attempt.region}`);
          launches.push({
            attempt: structuredClone(attempt),
            context: structuredClone(context as unknown as Readonly<Record<string, unknown>>),
          });
          return await (options.launchValue?.(attempt)
            ?? execution(attempt, attempt.region === options.partialRegion));
        },
      },
      describeTransport: {
        describeExact: async (request) => {
          events.push(`describe:${request.region}`);
          describes.push(structuredClone(request));
          return options.describeValue?.(request) ?? describeResponse(request);
        },
      },
      loadMatchingFinalizedDiscoveryEvidenceReference: async (value) => {
        events.push(`discovery:${value.region}`);
        const exact = structuredClone(value) as unknown as Readonly<Record<string, unknown>>;
        discoveryLoads.push(exact);
        const region = value.region;
        const regionIndex = REGIONS.indexOf(region as typeof REGIONS[number]);
        if (options.discoveryValue !== undefined) return await options.discoveryValue(exact);
        return {
          schemaVersion: "sutra.compute-optimizer-finalized-discovery-reference.v1",
          scope: {
            organizationId: value.organizationId,
            customerId: value.customerId,
            connectionId: value.connectionId,
          },
          region,
          discoveryRunId: `cor_${String(regionIndex + 1).repeat(64)}`,
          contentSha256: String(regionIndex + 3).repeat(64),
          accountId: value.requesterAccountId,
          partition: value.partition,
          finalizedAtIso: "2026-08-02T00:05:00.000Z",
          expectedJobSetContentSha256: value.expectedJobSet.contentSha256,
        };
      },
      persistReadyAndStageEnqueue: async (value) => {
        events.push("persist");
        ready.push(structuredClone(value));
        return await (options.persist?.(value) ?? Promise.resolve());
      },
      recordBlockedOutcome: async (value) => {
        events.push("blocked");
        blocked.push(structuredClone(value));
        return await (options.blockedSink?.(value) ?? Promise.resolve());
      },
      recordDiscoveryRefreshRequired: async (value) => {
        events.push("refresh-required");
        refreshRequired.push(structuredClone(value));
        return await (options.refreshSink?.(value) ?? Promise.resolve());
      },
    },
  };
}

function code(expected: ComputeOptimizerActivationProducerError["code"]):
(error: unknown) => boolean {
  return (error) => error instanceof ComputeOptimizerActivationProducerError
    && error.code === expected;
}

function matchingDiscoveryReference(
  value: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const expectedJobSet = value.expectedJobSet as Readonly<Record<string, unknown>>;
  const regionIndex = REGIONS.indexOf(value.region as typeof REGIONS[number]);
  return {
    schemaVersion: "sutra.compute-optimizer-finalized-discovery-reference.v1",
    scope: {
      organizationId: value.organizationId,
      customerId: value.customerId,
      connectionId: value.connectionId,
    },
    region: value.region,
    discoveryRunId: `cor_${String(regionIndex + 1).repeat(64)}`,
    contentSha256: String(regionIndex + 3).repeat(64),
    accountId: value.requesterAccountId,
    partition: value.partition,
    finalizedAtIso: "2026-08-02T00:05:00.000Z",
    expectedJobSetContentSha256: expectedJobSet.contentSha256,
    ...overrides,
  };
}

test("signed manifest drives sorted exact launches, one Describe per region, and one durable outbox stage", async () => {
  const run = harness();
  const outcome = await createComputeOptimizerActivationProducer(run.dependencies)(input());
  assert.equal(outcome.status, "PLAN_SET_READY");
  assert.deepEqual(outcome.regions, REGIONS);
  assert.equal(run.manifests.length, 1);
  assert.deepEqual(run.manifests[0], {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
    requestId: "activation-request-1",
    tenantId: "org-producer",
    connectionId: CONNECTION,
    accountId: "123456789012",
    partition: "aws",
    requiredPermissionPackVersion: "standard-2026-08.5",
  });
  assert.deepEqual(run.launches.map(({ attempt }) => attempt.region), REGIONS);
  assert.deepEqual(run.discoveryLoads.map(({ region }) => region), REGIONS);
  assert.equal(run.discoveryLoads[0]?.organizationId, "org-producer");
  assert.equal(run.discoveryLoads[0]?.customerId, "tenant-producer");
  const secretFreeProof = JSON.stringify(run.discoveryLoads[0]);
  assert.doesNotMatch(secretFreeProof, /sutra-co-|exports\/|\.csv|metadata\.json/iu);
  const expectedJobSet = run.discoveryLoads[0]?.expectedJobSet as Readonly<Record<string, unknown>>;
  const expectedJobs = expectedJobSet.jobs as readonly Readonly<Record<string, unknown>>[];
  assert.equal(expectedJobSet.contentSha256, await hash({
    schemaVersion: expectedJobSet.schemaVersion,
    region: expectedJobSet.region,
    jobs: expectedJobs,
  }));
  assert.equal(
    expectedJobs[0]?.bucketSha256,
    await rawHash("sutra-co-1-123456789012"),
  );
  assert.ok(run.launches.every(({ attempt }) => attempt.targets.length === 8));
  assert.deepEqual(run.launches.map(({ context }) => context.launchContractId), [
    "launch-us-east-1", "launch-us-west-2",
  ]);
  assert.equal(run.describes.length, 2);
  assert.ok(run.describes.every(({ tenantId }) => tenantId === "org-producer"));
  assert.deepEqual(run.describes.map(({ contractId }) => contractId), [
    "describe-us-east-1", "describe-us-west-2",
  ]);
  assert.ok(run.describes.every(({ plannedJobs }) => plannedJobs.length === 8));
  assert.ok(run.events.indexOf("discovery:us-east-1")
    > run.events.lastIndexOf("describe:us-west-2"));
  assert.ok(run.events.indexOf("persist") > run.events.lastIndexOf("discovery:us-west-2"));
  assert.equal(run.ready.length, 1);
  assert.equal(run.blocked.length, 0);
  const persisted = run.ready[0]!;
  assert.equal(persisted.regionalPlans.length, 2);
  assert.deepEqual(persisted.regionalPlanDiscoveryReferences.map(({ region, discoveryRunId }) => ({
    region, discoveryRunId,
  })), [
    { region: "us-east-1", discoveryRunId: `cor_${"1".repeat(64)}` },
    { region: "us-west-2", discoveryRunId: `cor_${"2".repeat(64)}` },
  ]);
  assert.deepEqual(persisted.regionContracts, [
    {
      region: "us-east-1",
      describeContractId: "describe-us-east-1",
      objectContractId: "object-us-east-1",
    },
    {
      region: "us-west-2",
      describeContractId: "describe-us-west-2",
      objectContractId: "object-us-west-2",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(persisted.regionContracts), /bucket|prefix|credential|roleArn|sutra-co-/iu);
});

test("same trusted input is a deterministic replay with identical sealed persistence identities", async () => {
  const run = harness();
  const producer = createComputeOptimizerActivationProducer(run.dependencies);
  const first = await producer(input());
  const replay = await producer(input());
  assert.deepEqual(replay, first);
  assert.equal(run.ready.length, 2);
  assert.deepEqual(run.ready[1], run.ready[0]);
  assert.equal(run.launches[2]?.attempt.launchAttemptId, run.launches[0]?.attempt.launchAttemptId);
  assert.equal(run.describes[2]?.collectionJobId, run.describes[0]?.collectionJobId);
});

test("manifest and launch substitutions are rejected before persistence", async () => {
  const wrongManifest = harness({
    manifestValue: (request) => ({ ...manifest(request), accountId: "999999999999" }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(wrongManifest.dependencies)(input()),
    code("DEPENDENCY_FAILED"),
  );
  assert.equal(wrongManifest.launches.length, 0);
  assert.equal(wrongManifest.ready.length, 0);

  const wrongLaunch = harness({
    launchValue: async (attempt) => ({
      ...(await execution(attempt)),
      requestBatchId: `coelb_${"f".repeat(64)}`,
    }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(wrongLaunch.dependencies)(input()),
    code("LAUNCH_RESPONSE_INVALID"),
  );
  assert.equal(wrongLaunch.describes.length, 0);
  assert.equal(wrongLaunch.ready.length, 0);
});

test("matching finalized discovery references are exact, unique, fresh, and loaded only after Describe", async () => {
  const wrongScope = harness({
    discoveryValue: (value) => matchingDiscoveryReference(value, {
      scope: {
        organizationId: "neighbor-org",
        customerId: value.customerId,
        connectionId: value.connectionId,
      },
    }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(wrongScope.dependencies)(input()),
    code("DISCOVERY_EVIDENCE_INVALID"),
  );
  assert.equal(wrongScope.launches.length, 2);
  assert.equal(wrongScope.describes.length, 2);

  const duplicated = harness({
    discoveryValue: (value) => matchingDiscoveryReference(value, {
      discoveryRunId: `cor_${"7".repeat(64)}`,
    }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(duplicated.dependencies)(input()),
    code("DISCOVERY_EVIDENCE_INVALID"),
  );
  assert.equal(duplicated.discoveryLoads.length, 2);
  assert.equal(duplicated.launches.length, 2);

  const stale = harness({
    discoveryValue: (value) => matchingDiscoveryReference(value, {
      finalizedAtIso: "2026-08-02T00:00:30.000Z",
    }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(stale.dependencies)(input()),
    code("DISCOVERY_EVIDENCE_INVALID"),
  );
  const future = harness({
    discoveryValue: (value) => matchingDiscoveryReference(value, {
      finalizedAtIso: "2026-08-02T13:00:00.000Z",
    }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(future.dependencies)(input()),
    code("DISCOVERY_EVIDENCE_INVALID"),
  );
  const substitutedProof = harness({
    discoveryValue: (value) => matchingDiscoveryReference(value, {
      expectedJobSetContentSha256: "f".repeat(64),
    }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(substitutedProof.dependencies)(input()),
    code("DISCOVERY_EVIDENCE_INVALID"),
  );
  const lagged = harness({
    discoveryValue: (value) => matchingDiscoveryReference(value, {
      finalizedAtIso: "2026-08-02T01:00:00.000Z",
    }),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(lagged.dependencies)(input({
      scheduledWindow: "2026-08-01T00:00:00.000Z",
      sealedAtIso: "2026-08-01T00:01:00.000Z",
    })),
    code("DISCOVERY_EVIDENCE_INVALID"),
  );
});

test("first run with no matching discovery records refresh-required proof and never persists or enqueues", async () => {
  const run = harness({ discoveryValue: () => null });
  await assert.rejects(
    createComputeOptimizerActivationProducer(run.dependencies)(input()),
    code("DISCOVERY_REFRESH_REQUIRED"),
  );
  assert.equal(run.launches.length, 2);
  assert.equal(run.describes.length, 2);
  assert.equal(run.discoveryLoads.length, 2);
  assert.equal(run.ready.length, 0);
  assert.equal(run.blocked.length, 0);
  assert.equal(run.refreshRequired.length, 1);
  assert.equal(run.events.at(-1), "refresh-required");
  assert.deepEqual(run.refreshRequired[0]?.regions.map(({ region }) => region), REGIONS);
  const durable = JSON.stringify(run.refreshRequired[0]);
  assert.match(durable, /DISCOVERY_REFRESH_REQUIRED/u);
  assert.doesNotMatch(durable, /sutra-co-|exports\/|\.csv|metadata\.json|bucket|prefix/iu);
});

test("launch and durable boundaries preserve sanitized ABORTED and DEADLINE errors", async () => {
  for (const expected of ["ABORTED", "DEADLINE_EXCEEDED"] as const) {
    const launch = harness({
      launchValue: async () => {
        throw Object.assign(new Error("credential-bearing transport detail"), { code: expected });
      },
    });
    await assert.rejects(
      createComputeOptimizerActivationProducer(launch.dependencies)(input()),
      (error: unknown) => code(expected)(error)
        && !String((error as Error).message).includes("credential-bearing"),
    );

    const durable = harness({
      persist: async () => {
        throw Object.assign(new Error("database topology detail"), { code: expected });
      },
    });
    await assert.rejects(
      createComputeOptimizerActivationProducer(durable.dependencies)(input()),
      (error: unknown) => code(expected)(error)
        && !String((error as Error).message).includes("database topology"),
    );
  }
});

test("Describe scope, job, and destination substitutions never become completedJobs", async () => {
  const variants: Array<(request: ComputeOptimizerExactDescribeRequest) => unknown> = [
    (request) => ({ ...describeResponse(request), contractId: "neighbor-contract" }),
    (request) => ({
      ...describeResponse(request),
      jobs: describeResponse(request).jobs.map((job, index) => index === 0
        ? { ...job, jobId: "neighbor-job" }
        : job),
    }),
    (request) => ({
      ...describeResponse(request),
      jobs: describeResponse(request).jobs.map((job, index) => index === 0
        ? { ...job, destination: { ...job.destination, bucket: "neighbor-bucket" } }
        : job),
    }),
  ];
  for (const describeValue of variants) {
    const run = harness({ describeValue });
    await assert.rejects(
      createComputeOptimizerActivationProducer(run.dependencies)(input()),
      code("DESCRIBE_RESPONSE_INVALID"),
    );
    assert.equal(run.ready.length, 0);
    assert.equal(run.blocked.length, 0);
  }
});

test("a partial region is durably sanitized, retried, and never enqueued", async () => {
  const run = harness({ partialRegion: "us-east-1" });
  await assert.rejects(
    createComputeOptimizerActivationProducer(run.dependencies)(input()),
    code("PLAN_SET_BLOCKED"),
  );
  assert.equal(run.ready.length, 0);
  assert.equal(run.blocked.length, 1);
  assert.deepEqual(run.describes.map(({ region }) => region), ["us-west-2"]);
  assert.deepEqual(run.blocked[0]?.regions[0], {
    region: "us-east-1",
    state: "LAUNCH_BLOCKED",
    errorCodes: ["LAUNCH_PARTIAL", "RATE_LIMITED"],
  });
  assert.doesNotMatch(JSON.stringify(run.blocked[0]), /bucket|prefix|credential|sutra-co-/iu);
});

test("one absolute deadline covers stuck manifest, blocked telemetry, and ready persistence", async () => {
  const stuckManifest = harness({ manifestValue: () => new Promise(() => undefined) });
  await assert.rejects(
    createComputeOptimizerActivationProducer(stuckManifest.dependencies)(input({
      deadlineAtMs: NOW + 15,
    })),
    code("DEADLINE_EXCEEDED"),
  );

  const stuckDiscovery = harness({
    discoveryValue: () => new Promise(() => undefined),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(stuckDiscovery.dependencies)(input({
      deadlineAtMs: NOW + 100,
    })),
    code("DEADLINE_EXCEEDED"),
  );
  assert.equal(stuckDiscovery.launches.length, 2);
  assert.equal(stuckDiscovery.describes.length, 2);
  assert.equal(stuckDiscovery.ready.length, 0);

  const stuckRefresh = harness({
    discoveryValue: () => null,
    refreshSink: async () => await new Promise(() => undefined),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(stuckRefresh.dependencies)(input({
      deadlineAtMs: NOW + 100,
    })),
    code("DEADLINE_EXCEEDED"),
  );
  assert.equal(stuckRefresh.refreshRequired.length, 1);
  assert.equal(stuckRefresh.ready.length, 0);

  const stuckBlocked = harness({
    partialRegion: "us-east-1",
    blockedSink: async () => await new Promise(() => undefined),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(stuckBlocked.dependencies)(input({
      deadlineAtMs: NOW + 100,
    })),
    code("DEADLINE_EXCEEDED"),
  );
  assert.equal(stuckBlocked.blocked.length, 1);

  const stuckPersist = harness({
    persist: async () => await new Promise(() => undefined),
  });
  await assert.rejects(
    createComputeOptimizerActivationProducer(stuckPersist.dependencies)(input({
      deadlineAtMs: NOW + 100,
    })),
    code("DEADLINE_EXCEEDED"),
  );
  assert.equal(stuckPersist.ready.length, 1);
});

test("a dependency resolving after terminal cannot start any later external side effect", async () => {
  const lateManifest = deferred<ComputeOptimizerMaterializationActivationManifest>();
  const manifestController = new AbortController();
  let manifestRequest: ComputeOptimizerMaterializationActivationManifestRequest | undefined;
  const manifestRun = harness({
    manifestValue: (request) => {
      manifestRequest = request;
      return lateManifest.promise;
    },
  });
  const manifestPending = createComputeOptimizerActivationProducer(
    manifestRun.dependencies,
  )(input({ signal: manifestController.signal }));
  await waitForDependencyStart(() => manifestRequest !== undefined, manifestController);
  assert.ok(manifestRequest !== undefined);
  manifestController.abort();
  await assert.rejects(manifestPending, code("ABORTED"));
  lateManifest.resolve(manifest(manifestRequest));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manifestRun.discoveryLoads.length, 0);
  assert.equal(manifestRun.launches.length, 0);

  const lateDiscovery = deferred<unknown>();
  const discoveryController = new AbortController();
  const discoveryRun = harness({ discoveryValue: () => lateDiscovery.promise });
  const discoveryPending = createComputeOptimizerActivationProducer(
    discoveryRun.dependencies,
  )(input({ signal: discoveryController.signal }));
  await waitForDependencyStart(
    () => discoveryRun.discoveryLoads.length === 1,
    discoveryController,
  );
  assert.equal(discoveryRun.discoveryLoads.length, 1);
  discoveryController.abort();
  await assert.rejects(discoveryPending, code("ABORTED"));
  lateDiscovery.resolve({
    schemaVersion: "sutra.compute-optimizer-finalized-discovery-reference.v1",
    scope: {
      organizationId: "org-producer",
      customerId: "tenant-producer",
      connectionId: CONNECTION,
    },
    region: "us-east-1",
    discoveryRunId: `cor_${"1".repeat(64)}`,
    contentSha256: "3".repeat(64),
    accountId: "123456789012",
    partition: "aws",
    finalizedAtIso: "2026-08-02T00:05:00.000Z",
    expectedJobSetContentSha256: "f".repeat(64),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discoveryRun.launches.length, 2);
  assert.equal(discoveryRun.describes.length, 2);
  assert.equal(discoveryRun.ready.length, 0);

  const lateLaunch = deferred<unknown>();
  const launchController = new AbortController();
  let attempted: ComputeOptimizerExportLaunchAttempt | undefined;
  const launchRun = harness({
    launchValue: async (attempt) => {
      attempted = attempt;
      return await lateLaunch.promise;
    },
  });
  const launchPending = createComputeOptimizerActivationProducer(
    launchRun.dependencies,
  )(input({ signal: launchController.signal }));
  await waitForDependencyStart(() => attempted !== undefined, launchController);
  assert.ok(attempted !== undefined);
  launchController.abort();
  await assert.rejects(launchPending, code("ABORTED"));
  lateLaunch.resolve(await execution(attempted));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launchRun.launches.length, 1);
  assert.equal(launchRun.describes.length, 0);
  assert.equal(launchRun.ready.length, 0);
});

test("external abort cuts off an uncooperative launch and preserves the stable error", async () => {
  const controller = new AbortController();
  let launchSignal: AbortSignal | undefined;
  // Signal arrival rather than spinning a fixed number of microtask turns. The producer awaits real
  // work before it reaches launchExact, so a bounded spin raced it and failed under CPU contention.
  let launchReached: () => void;
  const launched = new Promise<void>((resolve) => { launchReached = resolve; });
  const run = harness({
    launchValue: async () => await new Promise(() => undefined),
  });
  const original = run.dependencies.launchTransport.launchExact;
  const dependencies: ComputeOptimizerActivationProducerDependencies = {
    ...run.dependencies,
    launchTransport: {
      launchExact: async (attempt, context) => {
        launchSignal = context.signal;
        launchReached();
        return await original(attempt, context);
      },
    },
  };
  const pending = createComputeOptimizerActivationProducer(dependencies)(input({
    signal: controller.signal,
  }));
  await launched;
  assert.ok(launchSignal !== undefined);
  controller.abort();
  await assert.rejects(pending, code("ABORTED"));
  assert.equal(launchSignal?.aborted, true);
  assert.equal(run.ready.length, 0);
});

test("exact trusted input rejects region widening, browser fields, and invalid deadlines", async () => {
  const run = harness();
  const producer = createComputeOptimizerActivationProducer(run.dependencies);
  await assert.rejects(
    producer({ ...input(), enabledRegions: ["us-east-1", "us-east-1"] }),
    code("INVALID_INPUT"),
  );
  await assert.rejects(
    producer({ ...input(), deadlineAtMs: NOW + 330_001 }),
    code("INVALID_INPUT"),
  );
  await assert.rejects(
    producer({ ...input(), bucket: "browser-controlled" } as unknown as ComputeOptimizerActivationProducerInput),
    code("INVALID_INPUT"),
  );
  assert.equal(run.manifests.length, 0);
});
