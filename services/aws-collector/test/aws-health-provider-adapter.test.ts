import assert from "node:assert/strict";
import test from "node:test";
import {
  AWS_HEALTH_PROVIDER_BOUNDS,
  AwsHealthProviderAdapterError,
  collectAwsHealthProviderEvidence,
  type AwsHealthProviderReader,
  type AwsHealthProviderRequest,
} from "../src/aws-health-provider-adapter.js";
import {
  parseAwsHealthProviderRouteRequest,
  runAwsHealthProviderRoute,
} from "../src/aws-health-provider-route.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const MANAGEMENT = "111122223333";
const DELEGATE = "222233334444";
const CONNECTION = `conn_${"a".repeat(32)}`;
const DELEGATE_CONNECTION = `conn_${"b".repeat(32)}`;
const REQUEST_ID = `hrr_${"c".repeat(64)}`;
const EVENT = "arn:aws:health:us-east-1::event/EC2/AWS_EC2_EVENT/AWS_EC2_EVENT_ABC";

function request(overrides: Partial<AwsHealthProviderRequest> = {}): AwsHealthProviderRequest {
  return {
    schemaVersion: "sutra.aws-health-provider-request.v1", requestId: REQUEST_ID,
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    scope: { orgId: "org_health", customerId: "customer_health", connectionId: CONNECTION, accountId: MANAGEMENT, partition: "aws", endpointRegion: "us-east-1" },
    candidateAccounts: [{ accountId: MANAGEMENT, connectionId: CONNECTION }],
    enabledObservedSince: "2026-08-01T11:00:00.000Z",
    healthOperations: ["health:DescribeAffectedAccountsForOrganization", "health:DescribeAffectedEntitiesForOrganization", "health:DescribeEventDetailsForOrganization", "health:DescribeEventsForOrganization"],
    configurationOperation: "health:DescribeHealthServiceStatusForOrganization",
    prerequisiteOperations: ["organizations:DescribeOrganization", "organizations:ListDelegatedAdministrators"],
    bounds: AWS_HEALTH_PROVIDER_BOUNDS, locale: "en", unfilteredAvailableEvents: true,
    credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS", deadlineAtIso: "2026-08-02T12:15:00.000Z",
    ...overrides,
  };
}

function reader(options: { delegated?: boolean; subscription?: boolean; tokenReplay?: boolean } = {}): AwsHealthProviderReader {
  return {
    describeOrganization: async () => ({ organization: { Id: "o-example", FeatureSet: "ALL", ManagementAccountId: MANAGEMENT } }),
    listDelegatedAdministrators: async () => ({ DelegatedAdministrators: options.delegated ? [{ Id: DELEGATE }] : [] }),
    describeOrganizationViewStatus: async () => ({ healthServiceAccessStatusForOrganization: "ENABLED" }),
    describeEvents: async (_target, input) => {
      if (options.subscription) throw Object.assign(new Error("redacted"), { name: "SubscriptionRequiredException" });
      if (options.tokenReplay) return { events: [], nextToken: input.nextToken ?? "token1" };
      return { events: [{ arn: EVENT, eventScopeCode: "PUBLIC", eventTypeCategory: "issue", eventTypeCode: "AWS_EC2_EVENT", statusCode: "open", actionability: "ACTION_REQUIRED", personas: ["OPERATIONS"], region: "us-east-1", service: "EC2", startTime: new Date(NOW - 60_000), lastUpdatedTime: new Date(NOW - 30_000) }] };
    },
    describeAffectedAccounts: async () => ({ affectedAccounts: [], eventScopeCode: "PUBLIC" }),
    describeAffectedEntities: async () => ({ entities: [{ eventArn: EVENT, entityArn: "arn:aws:ec2:us-east-1::instance/i-1", entityValue: "i-1", statusCode: "IMPAIRED", lastUpdatedTime: new Date(NOW - 30_000), entityMetadata: { availabilityZone: "us-east-1a" } }], failedSet: [] }),
    describeEventDetails: async () => ({ successfulSet: [{ event: { arn: EVENT }, eventDescription: { latestDescription: "Action required" }, eventMetadata: { deprecated_versions: "1" } }], failedSet: [] }),
  };
}

test("provider exhausts the complete organization graph and proves aged initial load", async () => {
  const capture = await collectAwsHealthProviderEvidence({ request: request(), reader: reader(), signal: new AbortController().signal, now: () => NOW });
  assert.equal(capture.prerequisites.collectorAccountType, "management");
  assert.equal(capture.prerequisites.initialLoadState, "COMPLETE");
  assert.equal(capture.prerequisites.apiEntitlementValidated, true);
  assert.equal(capture.events.pages.length, 1);
  assert.equal(capture.affectedEntities[0]?.pages[0]?.response.entities.length, 1);
  assert.equal(capture.eventDetails[0]?.detail?.description, "Action required");
});

test("delegated administrator is accepted only with management-account proof", async () => {
  const delegated = request({
    scope: { orgId: "org_health", customerId: "customer_health", connectionId: DELEGATE_CONNECTION, accountId: DELEGATE, partition: "aws", endpointRegion: "us-east-1" },
    candidateAccounts: [{ accountId: MANAGEMENT, connectionId: CONNECTION }, { accountId: DELEGATE, connectionId: DELEGATE_CONNECTION }],
  });
  const capture = await collectAwsHealthProviderEvidence({ request: delegated, reader: reader({ delegated: true }), signal: new AbortController().signal, now: () => NOW });
  assert.equal(capture.prerequisites.collectorAccountType, "delegated_administrator");
  assert.equal(capture.prerequisites.delegatedAdministratorRegistered, true);
  assert.equal(capture.prerequisites.organizationViewStatusEvidence, "management_verified_delegation");
  const unavailable = await collectAwsHealthProviderEvidence({ request: delegated, reader: reader(), signal: new AbortController().signal, now: () => NOW });
  assert.equal(unavailable.prerequisites.collectorAccountType, "member");
  assert.equal(unavailable.events.pages[0]?.response.events.length, 0);
});

test("subscription denial becomes durable unavailable evidence without provider text", async () => {
  const capture = await collectAwsHealthProviderEvidence({ request: request(), reader: reader({ subscription: true }), signal: new AbortController().signal, now: () => NOW });
  assert.equal(capture.prerequisites.supportPlan, "not_qualifying");
  assert.equal(capture.prerequisites.apiEntitlementValidated, false);
  assert.doesNotMatch(JSON.stringify(capture), /redacted/u);
});

test("pagination token replay is rejected", async () => {
  await assert.rejects(
    collectAwsHealthProviderEvidence({ request: request(), reader: reader({ tokenReplay: true }), signal: new AbortController().signal, now: () => NOW }),
    (error: unknown) => error instanceof AwsHealthProviderAdapterError && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("strict route binds signed headers and exact per-account sessions", async () => {
  const body = JSON.stringify(request());
  assert.deepEqual(parseAwsHealthProviderRouteRequest(body), request());
  const assumed: string[] = [];
  const result = await runAwsHealthProviderRoute({ body, headers: { tenantId: "org_health", customerId: "customer_health", connectionId: CONNECTION, requestId: REQUEST_ID }, signal: new AbortController().signal }, {
    assumeReadOnlySession: async (input) => { assumed.push(input.expectedAccountId); return { accountId: input.expectedAccountId, partition: input.partition, credentials: { accessKeyId: "SUTRATESTACCESSKEY000", secretAccessKey: "test-secret-placeholder".repeat(2), sessionToken: "test-session-token", expiration: new Date(NOW + 3_600_000) } }; },
    readerFactory: ({ sessionForTarget }) => {
      const base = reader();
      return { ...base, describeOrganization: async (target, signal) => {
        await sessionForTarget(target, signal);
        return base.describeOrganization(target, signal);
      } };
    }, now: () => NOW,
  });
  assert.equal(result.capture.scope.connectionId, CONNECTION);
  assert.equal(result.requestBodySha256.length, 64);
  assert.deepEqual(assumed, [MANAGEMENT]);
  await assert.rejects(runAwsHealthProviderRoute({ body, headers: { tenantId: "other", customerId: "customer_health", connectionId: CONNECTION, requestId: REQUEST_ID }, signal: new AbortController().signal }, {
    assumeReadOnlySession: async () => { throw new Error("must not run"); }, readerFactory: () => reader(), now: () => NOW,
  }), /provider collection did not complete/u);
});
