import assert from "node:assert/strict";
import test from "node:test";

import {
  awsHealthOrganizationSourceEvidence,
  buildAwsHealthOrganizationDashboard,
  createAwsHealthOrganizationQueryService,
  AwsHealthOrganizationError,
  AwsHealthOrganizationQueryError,
  normalizeAwsHealthOrganizationCapture,
  type AwsHealthOrganizationBrokerRequest,
  type AwsHealthOrganizationCapture,
  type AwsHealthOrganizationScope,
} from "../lib/finops-aws-health-organization.ts";

const ACCOUNT_ID = "123456789012";
const AFFECTED_ACCOUNT_ID = "210987654321";
const EVENT_ARN =
  "arn:aws:health:us-east-1::event/EC2/AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED/AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED_ABC123";
const SCOPE: AwsHealthOrganizationScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: ACCOUNT_ID,
  partition: "aws",
  endpointRegion: "us-east-1",
};
const NOW = new Date("2026-07-31T12:00:00.000Z");

type DeepMutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object
    ? DeepMutable<T[Key]>
    : T[Key];
};

function capture(): DeepMutable<AwsHealthOrganizationCapture> {
  return {
    schemaVersion: "sutra.aws-health-organization.v1",
    scope: SCOPE,
    captureId: `health_${"b".repeat(64)}`,
    startedAtIso: "2026-07-31T11:55:00.000Z",
    completedAtIso: "2026-07-31T12:00:00.000Z",
    execution: {
      concurrencyLimit: 4,
      eventDetailBatchSize: 10,
      observedPeakConcurrency: 3,
    },
    prerequisites: {
      organizationsAllFeaturesEnabled: true,
      organizationViewStatus: "ENABLED",
      organizationViewStatusEvidence: "management_verified_delegation",
      supportPlan: "enterprise",
      apiEntitlementValidated: true,
      collectorAccountType: "delegated_administrator",
      delegatedAdministratorRegistered: true,
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
        response: {
          events: [{
            arn: EVENT_ARN,
            actionability: "ACTION_REQUIRED",
            eventScopeCode: "ACCOUNT_SPECIFIC",
            eventTypeCategory: "scheduledChange",
            eventTypeCode: "AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED",
            lastUpdatedTime: "2026-07-31T11:30:00.000Z",
            personas: ["OPERATIONS"],
            region: "us-east-1",
            service: "EC2",
            startTime: "2026-08-05T00:00:00.000Z",
            statusCode: "upcoming",
          }],
          nextToken: null,
        },
      }],
    },
    affectedAccounts: [{
      eventArn: EVENT_ARN,
      exhausted: true,
      pages: [{
        request: {
          eventArn: EVENT_ARN,
          maxResults: 100,
          nextToken: null,
        },
        response: {
          affectedAccounts: [AFFECTED_ACCOUNT_ID],
          eventScopeCode: "ACCOUNT_SPECIFIC",
          nextToken: null,
        },
      }],
    }],
    affectedEntities: [{
      eventArn: EVENT_ARN,
      awsAccountId: AFFECTED_ACCOUNT_ID,
      exhausted: true,
      pages: [{
        request: {
          locale: "en",
          maxResults: 100,
          nextToken: null,
          organizationEntityAccountFilters: null,
          organizationEntityFilters: [{
            eventArn: EVENT_ARN,
            awsAccountId: AFFECTED_ACCOUNT_ID,
          }],
        },
        response: {
          entities: [{
            awsAccountId: AFFECTED_ACCOUNT_ID,
            entityArn:
              `arn:aws:health:us-east-1:${AFFECTED_ACCOUNT_ID}:entity/entity-1`,
            entityMetadata: { availabilityZone: "us-east-1a" },
            entityValue: "i-0123456789abcdef0",
            eventArn: EVENT_ARN,
            lastUpdatedTime: "2026-07-31T11:30:00.000Z",
            statusCode: "PENDING",
          }],
          failedSet: [],
          nextToken: null,
        },
      }],
    }],
    eventDetails: [{
      eventArn: EVENT_ARN,
      awsAccountId: AFFECTED_ACCOUNT_ID,
      detail: {
        eventArn: EVENT_ARN,
        awsAccountId: AFFECTED_ACCOUNT_ID,
        description: "An EC2 instance retirement is scheduled.",
        metadata: { source: "AWS Health" },
      },
      failureCode: null,
    }],
  };
}

test("normalizes complete tenant-pinned event, account, detail, and resource evidence", () => {
  const snapshot = normalizeAwsHealthOrganizationCapture(
    capture(),
    SCOPE,
    NOW.getTime(),
  );
  assert.equal(snapshot.configurationState, "ready");
  assert.equal(snapshot.collectionState, "complete");
  assert.equal(snapshot.coverage.eventCount, 1);
  assert.equal(snapshot.coverage.affectedAccountCount, 1);
  assert.equal(snapshot.coverage.affectedEntityCount, 1);
  assert.equal(snapshot.events[0]?.status, "upcoming");
  assert.equal(snapshot.events[0]?.service, "EC2");
  assert.equal(snapshot.events[0]?.region, "us-east-1");
  assert.equal(snapshot.events[0]?.startAt, "2026-08-05T00:00:00.000Z");
  assert.equal(snapshot.events[0]?.endAt, null);
  assert.equal(
    snapshot.events[0]?.lastUpdatedAt,
    "2026-07-31T11:30:00.000Z",
  );
  assert.deepEqual(snapshot.events[0]?.affectedAccounts, [
    AFFECTED_ACCOUNT_ID,
  ]);
  assert.equal(
    snapshot.events[0]?.affectedEntities[0]?.entityValue,
    "i-0123456789abcdef0",
  );
  assert.match(
    snapshot.evidence.limitations.join(" "),
    /not a real-time event stream/u,
  );

  const source = awsHealthOrganizationSourceEvidence(snapshot);
  assert.equal(source.coverage.assessment, "complete");
  assert.equal(source.lastAttemptOutcome, "succeeded");
  assert.equal(source.dataThroughAt, null);
  assert.equal(source.lastSuccessAt, snapshot.observedAtIso);
});

test("rejects tenant, connection, account, partition, or endpoint substitution", () => {
  const replacements: AwsHealthOrganizationScope[] = [
    { ...SCOPE, orgId: "org_attacker" },
    { ...SCOPE, connectionId: `conn_${"c".repeat(32)}` },
    { ...SCOPE, accountId: "999988887777" },
    {
      ...SCOPE,
      partition: "aws-us-gov",
      endpointRegion: "us-gov-west-1",
    },
    { ...SCOPE, endpointRegion: "us-gov-west-1" as "us-east-1" },
  ];
  for (const expected of replacements) {
    assert.throws(
      () => normalizeAwsHealthOrganizationCapture(
        capture(),
        expected,
        NOW.getTime(),
      ),
      (error) => error instanceof AwsHealthOrganizationError,
    );
  }
});

test("rejects pagination replay and concurrency above the contract", () => {
  const paginationReplay = capture();
  const firstPage = paginationReplay.events.pages[0]!;
  paginationReplay.events = {
    exhausted: false,
    pages: [{
      ...firstPage,
      response: { ...firstPage.response, nextToken: "same-token" },
    }, {
      request: {
        ...firstPage.request,
        nextToken: "same-token",
      },
      response: {
        ...firstPage.response,
        nextToken: "same-token",
      },
    }],
  };
  assert.throws(
    () => normalizeAwsHealthOrganizationCapture(
      paginationReplay,
      SCOPE,
      NOW.getTime(),
    ),
    (error) =>
      error instanceof AwsHealthOrganizationError
      && error.code === "INVALID_PAGINATION",
  );

  const excessiveConcurrency = capture();
  excessiveConcurrency.execution = {
    concurrencyLimit: 4,
    eventDetailBatchSize: 10,
    observedPeakConcurrency: 5,
  };
  assert.throws(
    () => normalizeAwsHealthOrganizationCapture(
      excessiveConcurrency,
      SCOPE,
      NOW.getTime(),
    ),
    (error) => error instanceof AwsHealthOrganizationError,
  );
});

test("marks pending, partial, and stale states without inventing completeness", () => {
  const pending = capture();
  pending.prerequisites = {
    ...pending.prerequisites,
    organizationViewStatus: "PENDING",
    initialLoadState: "PENDING",
  };
  const snapshot = normalizeAwsHealthOrganizationCapture(
    pending,
    SCOPE,
    NOW.getTime(),
  );
  assert.equal(snapshot.configurationState, "pending");
  assert.equal(snapshot.collectionState, "partial");
  assert.equal(
    awsHealthOrganizationSourceEvidence(snapshot).lastSuccessAt,
    null,
  );

  const dashboard = buildAwsHealthOrganizationDashboard({
    snapshot,
    expectedScope: SCOPE,
    nowMs: Date.parse("2026-08-04T13:00:00.000Z"),
  });
  assert.equal(dashboard.source.freshness, "stale");
  assert.equal(dashboard.source.configurationState, "pending");

  const unavailable = capture();
  unavailable.prerequisites = {
    ...unavailable.prerequisites,
    organizationViewStatus: "DISABLED",
  };
  const unavailableSnapshot = normalizeAwsHealthOrganizationCapture(
    unavailable,
    SCOPE,
    NOW.getTime(),
  );
  const unavailableEvidence =
    awsHealthOrganizationSourceEvidence(unavailableSnapshot);
  assert.equal(unavailableSnapshot.collectionState, "unavailable");
  assert.equal(unavailableEvidence.lastAttemptOutcome, "failed");
  assert.equal(
    unavailableEvidence.lastError?.code,
    "CONFIGURATION_UNAVAILABLE",
  );
});

test("preserves generic provider failures and never requires provider messages", () => {
  const partial = capture();
  partial.affectedEntities[0]!.pages[0]!.response.failedSet = [{
    eventArn: EVENT_ARN,
    awsAccountId: AFFECTED_ACCOUNT_ID,
    code: "THROTTLED",
  }];
  partial.eventDetails[0] = {
    eventArn: EVENT_ARN,
    awsAccountId: AFFECTED_ACCOUNT_ID,
    detail: null,
    failureCode: "THROTTLED",
  };
  const snapshot = normalizeAwsHealthOrganizationCapture(
    partial,
    SCOPE,
    NOW.getTime(),
  );
  assert.equal(snapshot.collectionState, "partial");
  assert.equal(snapshot.coverage.providerFailureCount, 2);
  assert.deepEqual(snapshot.events[0]?.evidence.providerFailures, [
    "THROTTLED",
  ]);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /provider said|exception message|stack trace/u,
  );
});

test("rejects unobserved account drilldowns instead of accepting injected data", () => {
  const injected = capture();
  const unexpectedAccountId = "999988887777";
  const originalEntitySequence = injected.affectedEntities[0]!;
  injected.affectedEntities.push({
    ...structuredClone(originalEntitySequence),
    awsAccountId: unexpectedAccountId,
    pages: [{
      ...structuredClone(originalEntitySequence.pages[0]!),
      request: {
        ...structuredClone(originalEntitySequence.pages[0]!.request),
        organizationEntityFilters: [{
          eventArn: EVENT_ARN,
          awsAccountId: unexpectedAccountId,
        }],
      },
      response: {
        entities: [],
        failedSet: [],
        nextToken: null,
      },
    }],
  });
  injected.eventDetails.push({
    eventArn: EVENT_ARN,
    awsAccountId: unexpectedAccountId,
    detail: {
      eventArn: EVENT_ARN,
      awsAccountId: unexpectedAccountId,
      description: "Injected account detail",
      metadata: {},
    },
    failureCode: null,
  });
  assert.throws(
    () => normalizeAwsHealthOrganizationCapture(
      injected,
      SCOPE,
      NOW.getTime(),
    ),
    (error) =>
      error instanceof AwsHealthOrganizationError
      && error.code === "SCOPE_MISMATCH",
  );
});

test("dashboard projects bounded status, category, service, and drilldowns", () => {
  const snapshot = normalizeAwsHealthOrganizationCapture(
    capture(),
    SCOPE,
    NOW.getTime(),
  );
  const dashboard = buildAwsHealthOrganizationDashboard({
    snapshot,
    expectedScope: SCOPE,
    options: {
      accountId: AFFECTED_ACCOUNT_ID,
      category: "scheduledChange",
      service: "EC2",
      status: "upcoming",
      eventLimit: 1,
    },
    nowMs: NOW.getTime(),
  });
  assert.equal(dashboard.summary.eventCount, 1);
  assert.equal(dashboard.summary.upcomingCount, 1);
  assert.equal(dashboard.summary.actionRequiredCount, 1);
  assert.equal(dashboard.summary.affectedAccountCount, 1);
  assert.equal(dashboard.summary.affectedEntityCount, 1);
  assert.deepEqual(dashboard.summary.serviceCounts, [{
    service: "EC2",
    eventCount: 1,
  }]);
  assert.equal(dashboard.eventsTruncated, false);
  assert.match(dashboard.disclosure, /not a real-time incident feed/u);
});

test("query service derives scope and bounds server-side and rejects client tenancy", async () => {
  const requests: AwsHealthOrganizationBrokerRequest[] = [];
  const service = createAwsHealthOrganizationQueryService(
    SCOPE,
    {
      async collect(request) {
        requests.push(request);
        return capture();
      },
    },
    {
      now: () => NOW,
      createJobId: () => `healthjob_${"d".repeat(32)}`,
    },
  );
  const snapshot = await service.query({});
  assert.equal(snapshot.scope.orgId, SCOPE.orgId);
  assert.deepEqual(requests.map((request) => ({
    tenantId: request.tenantId,
    customerId: request.customerId,
    connectionId: request.connectionId,
    accountId: request.accountId,
    partition: request.partition,
    endpointRegion: request.endpointRegion,
    locale: request.locale,
    unfilteredAvailableEvents: request.unfilteredAvailableEvents,
    concurrency: request.limits.concurrency,
  })), [{
    tenantId: SCOPE.orgId,
    customerId: SCOPE.customerId,
    connectionId: SCOPE.connectionId,
    accountId: ACCOUNT_ID,
    partition: "aws",
    endpointRegion: "us-east-1",
    locale: "en",
    unfilteredAvailableEvents: true,
    concurrency: 4,
  }]);
  await assert.rejects(
    service.query({ tenantId: "org_attacker" } as never),
    (error) =>
      error instanceof AwsHealthOrganizationQueryError
      && error.code === "INVALID_QUERY",
  );
});

test("query service maps transport and evidence failures to generic errors", async () => {
  const transportFailure = createAwsHealthOrganizationQueryService(
    SCOPE,
    {
      async collect() {
        throw new Error("sensitive provider exception");
      },
    },
    {
      now: () => NOW,
      createJobId: () => `healthjob_${"e".repeat(32)}`,
    },
  );
  await assert.rejects(
    transportFailure.query(),
    (error) =>
      error instanceof AwsHealthOrganizationQueryError
      && error.code === "COLLECTION_FAILED"
      && !error.message.includes("sensitive"),
  );

  const invalidEvidence = createAwsHealthOrganizationQueryService(
    SCOPE,
    { async collect() { return { unexpected: true }; } },
    {
      now: () => NOW,
      createJobId: () => `healthjob_${"f".repeat(32)}`,
    },
  );
  await assert.rejects(
    invalidEvidence.query(),
    (error) =>
      error instanceof AwsHealthOrganizationQueryError
      && error.code === "INVALID_EVIDENCE",
  );
});
