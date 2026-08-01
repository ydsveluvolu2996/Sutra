import assert from "node:assert/strict";
import test from "node:test";

import type { RunnableJob } from "../lib/background-job-runner.ts";
import {
  normalizeAwsHealthOrganizationCapture,
  type AwsHealthOrganizationCapture,
  type AwsHealthOrganizationScope,
  type AwsHealthOrganizationSnapshot,
} from "../lib/finops-aws-health-organization.ts";
import {
  buildAwsHealthPlanningDashboard,
} from "../lib/finops-aws-health-dashboard.ts";
import {
  AWS_HEALTH_RUNTIME_ACTIVATION_REASON,
  AWS_HEALTH_RUNTIME_BINDING,
  AWS_HEALTH_RUNTIME_JOB_KIND,
  AWS_HEALTH_RUNTIME_MAX_ATTEMPTS,
  AwsHealthRuntimeBindingError,
  runAwsHealthOrganizationRuntimeHandler,
  scheduleAwsHealthOrganizationCollections,
  type AwsHealthAcceptedRuntimeAttempt,
  type AwsHealthRuntimeAdapterRequest,
  type AwsHealthRuntimeDependencies,
  type AwsHealthRuntimeFailureCode,
} from "../lib/finops-aws-health-runtime-binding.ts";
import type {
  AwsHealthPersistenceScope,
  StoredAwsHealthSnapshot,
} from "../db/finops-aws-health-repository.ts";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";
const SCOPE: AwsHealthPersistenceScope = {
  organizationId: "org_health_runtime",
  customerId: "customer_health_runtime",
  connectionId: `conn_${"a".repeat(32)}`,
};
const TRUSTED: AwsHealthOrganizationScope = {
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  accountId: "111122223333",
  partition: "aws",
  endpointRegion: "us-east-1",
};
const JOB: RunnableJob = {
  id: `job_${"1".repeat(32)}`,
  orgId: SCOPE.organizationId,
  customerId: SCOPE.customerId,
  connectionId: SCOPE.connectionId,
  kind: AWS_HEALTH_RUNTIME_JOB_KIND,
  payload: { scheduledWindow: WINDOW },
  attempt: 1,
  maxAttempts: AWS_HEALTH_RUNTIME_MAX_ATTEMPTS,
};

function capture(
  scope: AwsHealthOrganizationScope = TRUSTED,
): AwsHealthOrganizationCapture {
  return {
    schemaVersion: "sutra.aws-health-organization.v1",
    scope,
    captureId: `health_${"b".repeat(64)}`,
    startedAtIso: "2026-08-02T11:59:00.000Z",
    completedAtIso: "2026-08-02T12:00:00.000Z",
    execution: {
      concurrencyLimit: 4,
      eventDetailBatchSize: 10,
      observedPeakConcurrency: 1,
    },
    prerequisites: {
      organizationsAllFeaturesEnabled: true,
      organizationViewStatus: "ENABLED",
      organizationViewStatusEvidence: "management_status_api",
      supportPlan: "enterprise",
      apiEntitlementValidated: true,
      collectorAccountType: "management",
      delegatedAdministratorRegistered: false,
      readPermissionsValidated: true,
      initialLoadState: "COMPLETE",
    },
    events: {
      exhausted: true,
      pages: [{
        request: {
          filter: null,
          locale: "en",
          maxResults: 100,
          nextToken: null,
        },
        response: { events: [], nextToken: null },
      }],
    },
    affectedAccounts: [],
    affectedEntities: [],
    eventDetails: [],
  };
}

function stored(snapshot: AwsHealthOrganizationSnapshot): StoredAwsHealthSnapshot {
  return {
    scope: SCOPE,
    generationId: `hhg_${"c".repeat(64)}`,
    contentSha256: "c".repeat(64),
    snapshot,
    createdAtIso: snapshot.observedAtIso,
    committedAtIso: snapshot.collectionState === "complete"
      ? snapshot.observedAtIso
      : null,
  };
}

function context(input?: {
  readonly adapter?: AwsHealthRuntimeDependencies["adapter"];
  readonly trusted?: AwsHealthOrganizationScope;
}) {
  const accepted = new Map<string, AwsHealthAcceptedRuntimeAttempt>();
  const requests: AwsHealthRuntimeAdapterRequest[] = [];
  const failures: AwsHealthRuntimeFailureCode[] = [];
  let commits = 0;
  const dependencies: AwsHealthRuntimeDependencies = {
    now: () => NOW,
    loadScope: async () => input?.trusted ?? TRUSTED,
    adapter: input?.adapter === undefined ? {
      collect: async (request, signal) => {
        assert.equal(signal.aborted, false);
        requests.push(request);
        return capture();
      },
    } : input.adapter,
    handoff: {
      getAccepted: async (_scope, requestId) => accepted.get(requestId) ?? null,
      commit: async (commit) => {
        commits += 1;
        const attempt: AwsHealthAcceptedRuntimeAttempt = {
          scope: SCOPE,
          requestId: commit.requestId,
          scheduledWindow: commit.scheduledWindow,
          snapshot: stored(commit.normalizedSnapshot),
        };
        accepted.set(commit.requestId, attempt);
        return { accepted: attempt, becameActive: true };
      },
      recordFailure: async ({ code }) => { failures.push(code); },
    },
  };
  return {
    accepted,
    commits: () => commits,
    dependencies,
    failures,
    requests,
  };
}

function expectCode(code: AwsHealthRuntimeBindingError["code"]) {
  return (error: unknown): boolean =>
    error instanceof AwsHealthRuntimeBindingError
    && error.code === code
    && error.message === "AWS Health runtime collection failed";
}

test("daily scheduler emits only tenant identity and a deterministic window", async () => {
  const queued: unknown[] = [];
  const result = await scheduleAwsHealthOrganizationCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE],
    queue: { enqueue: async (value) => { queued.push(value); } },
  });
  assert.deepEqual(result, { scheduledWindow: WINDOW, enqueued: 1 });
  assert.deepEqual(queued, [{
    orgId: SCOPE.organizationId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    kind: AWS_HEALTH_RUNTIME_JOB_KIND,
    payload: { scheduledWindow: WINDOW },
    maxAttempts: 5,
    idempotencyKey: [
      "aws-health-organization",
      SCOPE.organizationId,
      SCOPE.customerId,
      SCOPE.connectionId,
      WINDOW,
    ].map(encodeURIComponent).join(":"),
  }]);
  assert.equal(JSON.stringify(queued).includes(TRUSTED.accountId), false);
  let duplicateEnqueued = false;
  await assert.rejects(scheduleAwsHealthOrganizationCollections({
    scheduledWindow: WINDOW,
    loadEligibleScopes: async () => [SCOPE, SCOPE],
    queue: { enqueue: async () => { duplicateEnqueued = true; } },
  }), expectCode("SCOPE_REJECTED"));
  assert.equal(duplicateEnqueued, false);
});

test("runtime pins endpoint, operations, pagination, bounds, and server credentials", async () => {
  const state = context();
  const result = await runAwsHealthOrganizationRuntimeHandler(
    JOB,
    state.dependencies,
  );
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.replayed, false);
  assert.equal(result.becameActive, true);
  assert.equal(state.commits(), 1);
  const request = state.requests[0];
  assert.ok(request);
  assert.deepEqual(request.scope, TRUSTED);
  assert.equal(request.credentials, "SERVER_OWNED_TRUST_ROLE_SESSION");
  assert.equal(request.unfilteredAvailableEvents, true);
  assert.equal(request.operations.length, 4);
  assert.ok(request.operations.includes(
    "health:DescribeAffectedEntitiesForOrganization",
  ));
  assert.equal(
    request.configurationOperation,
    "health:DescribeHealthServiceStatusForOrganization",
  );
  assert.deepEqual(request.pagination, {
    pageSize: 100,
    detailBatchSize: 10,
    rejectTokenReplay: true,
    requireExhaustionEvidence: true,
  });
  assert.equal(request.bounds.maximumConcurrency, 4);
  assert.equal(request.bounds.maximumEvents, 10_000);
  assert.equal(JSON.stringify(request).includes("roleArn"), false);
});

test("a durable accepted request replays without recollection or another commit", async () => {
  const state = context();
  const first = await runAwsHealthOrganizationRuntimeHandler(
    JOB,
    state.dependencies,
  );
  const replay = await runAwsHealthOrganizationRuntimeHandler(
    { ...JOB, attempt: 2 },
    state.dependencies,
  );
  assert.equal(first.status, "accepted");
  assert.equal(replay.status, "accepted");
  if (first.status !== "accepted" || replay.status !== "accepted") return;
  assert.equal(first.requestId, replay.requestId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.becameActive, false);
  assert.equal(state.requests.length, 1);
  assert.equal(state.commits(), 1);
});

test("replay rejects a substituted AWS account, partition, or endpoint", async () => {
  const state = context();
  const first = await runAwsHealthOrganizationRuntimeHandler(
    JOB,
    state.dependencies,
  );
  assert.equal(first.status, "accepted");
  if (first.status !== "accepted") return;
  const accepted = state.accepted.get(first.requestId);
  assert.ok(accepted);
  state.accepted.set(first.requestId, {
    ...accepted,
    snapshot: {
      ...accepted.snapshot,
      snapshot: {
        ...accepted.snapshot.snapshot,
        scope: {
          ...accepted.snapshot.snapshot.scope,
          accountId: "999988887777",
        },
      },
    },
  });
  await assert.rejects(runAwsHealthOrganizationRuntimeHandler(
    { ...JOB, attempt: 2 },
    state.dependencies,
  ), expectCode("PERSISTENCE_REJECTED"));
  assert.equal(state.requests.length, 1);
});

test("an absent broker adapter is explicit and performs no evidence writes", async () => {
  const state = context({ adapter: null });
  const result = await runAwsHealthOrganizationRuntimeHandler(
    JOB,
    state.dependencies,
  );
  assert.deepEqual(result, {
    status: "unavailable",
    reason: AWS_HEALTH_RUNTIME_ACTIVATION_REASON,
  });
  assert.equal(state.commits(), 0);
  assert.deepEqual(state.failures, []);
  assert.equal(AWS_HEALTH_RUNTIME_BINDING.registeredInSharedRuntime, false);
});

test("job payload and trusted scope substitutions fail closed", async () => {
  await assert.rejects(runAwsHealthOrganizationRuntimeHandler({
    ...JOB,
    payload: { scheduledWindow: WINDOW, accountId: "999988887777" },
  }, context().dependencies), expectCode("INVALID_JOB"));
  await assert.rejects(runAwsHealthOrganizationRuntimeHandler({
    ...JOB,
    attempt: 6,
  }, context().dependencies), expectCode("INVALID_JOB"));
  await assert.rejects(runAwsHealthOrganizationRuntimeHandler({
    ...JOB,
    maxAttempts: 4,
  }, context().dependencies), expectCode("INVALID_JOB"));
  await assert.rejects(runAwsHealthOrganizationRuntimeHandler({
    ...JOB,
    payload: { scheduledWindow: "2026-99-02T00:00:00.000Z" },
  }, context().dependencies), expectCode("INVALID_JOB"));
  await assert.rejects(runAwsHealthOrganizationRuntimeHandler(
    JOB,
    context({ trusted: { ...TRUSTED, orgId: "org_attacker" } }).dependencies,
  ), expectCode("SCOPE_REJECTED"));
  await assert.rejects(runAwsHealthOrganizationRuntimeHandler(
    JOB,
    context({
      trusted: {
        ...TRUSTED,
        partition: "aws-us-gov",
        endpointRegion: "us-east-1",
      } as AwsHealthOrganizationScope,
    }).dependencies,
  ), expectCode("SCOPE_REJECTED"));
});

test("invalid provider captures produce only a generic persisted failure code", async () => {
  const state = context({
    adapter: {
      collect: async () => capture({ ...TRUSTED, orgId: "org_attacker" }),
    },
  });
  await assert.rejects(
    runAwsHealthOrganizationRuntimeHandler(JOB, state.dependencies),
    expectCode("CAPTURE_REJECTED"),
  );
  assert.deepEqual(state.failures, ["CAPTURE_REJECTED"]);
  assert.equal(state.commits(), 0);
  assert.doesNotMatch(JSON.stringify(state.failures), /attacker|capture/u);
});

test("planning UI data exposes a dated impact timeline and only explicit deprecations", () => {
  const eventArn =
    "arn:aws:health:us-east-1::event/RDS/AWS_RDS_DEPRECATION/AWS_RDS_DEPRECATION_ABC";
  const base = capture();
  const raw: AwsHealthOrganizationCapture = {
    ...base,
    events: {
      exhausted: true,
      pages: [{
        request: {
          filter: null,
          locale: "en",
          maxResults: 100,
          nextToken: null,
        },
        response: {
          events: [{
            arn: eventArn,
            actionability: "ACTION_REQUIRED",
            eventScopeCode: "PUBLIC",
            eventTypeCategory: "scheduledChange",
            eventTypeCode: "AWS_RDS_DEPRECATION",
            lastUpdatedTime: "2026-08-02T11:45:00.000Z",
            personas: ["OPERATIONS"],
            region: "us-east-1",
            service: "RDS",
            startTime: "2026-10-01T00:00:00.000Z",
            statusCode: "upcoming",
          }],
          nextToken: null,
        },
      }],
    },
    affectedAccounts: [{
      eventArn,
      exhausted: true,
      pages: [{
        request: { eventArn, maxResults: 100, nextToken: null },
        response: {
          affectedAccounts: [],
          eventScopeCode: "PUBLIC",
          nextToken: null,
        },
      }],
    }],
    affectedEntities: [{
      eventArn,
      awsAccountId: null,
      exhausted: true,
      pages: [{
        request: {
          locale: "en",
          maxResults: 100,
          nextToken: null,
          organizationEntityAccountFilters: null,
          organizationEntityFilters: [{ eventArn, awsAccountId: null }],
        },
        response: { entities: [], failedSet: [], nextToken: null },
      }],
    }],
    eventDetails: [{
      eventArn,
      awsAccountId: null,
      detail: {
        eventArn,
        awsAccountId: null,
        description: "A provider-supplied lifecycle notice.",
        metadata: { deprecated_versions: "Aurora MySQL 2" },
      },
      failureCode: null,
    }],
  };
  const snapshot = normalizeAwsHealthOrganizationCapture(raw, TRUSTED, NOW);
  const dashboard = buildAwsHealthPlanningDashboard([{
    generationId: `hhg_${"d".repeat(64)}`,
    contentSha256: "d".repeat(64),
    snapshot,
  }], {
    status: null,
    category: null,
    service: null,
    accountId: null,
    region: null,
    actionability: null,
    search: null,
  }, NOW);
  assert.equal(dashboard.upcomingTimeline.length, 1);
  assert.equal(dashboard.upcomingTimeline[0]?.startAt,
    "2026-10-01T00:00:00.000Z");
  assert.equal(dashboard.deprecatingVersions.status, "available");
  assert.equal(
    dashboard.deprecatingVersions.items[0]?.deprecatedVersions,
    "Aurora MySQL 2",
  );

  const absent = buildAwsHealthPlanningDashboard([], {
    status: null,
    category: null,
    service: null,
    accountId: null,
    region: null,
    actionability: null,
    search: null,
  }, NOW);
  assert.equal(absent.deprecatingVersions.status, "unavailable");
  assert.equal(
    absent.deprecatingVersions.unavailableReason,
    "EXPLICIT_DEPRECATED_VERSIONS_METADATA_NOT_RETURNED",
  );
});
