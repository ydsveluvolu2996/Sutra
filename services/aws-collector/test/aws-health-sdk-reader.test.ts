import assert from "node:assert/strict";
import test from "node:test";
import type { AwsHealthProviderRequest } from
  "../src/aws-health-provider-adapter.js";
import { AWS_HEALTH_PROVIDER_BOUNDS } from
  "../src/aws-health-provider-adapter.js";
import { createAwsHealthSdkReader } from
  "../src/aws-health-sdk-reader.js";

const TARGET = {
  accountId: "111122223333",
  connectionId: `conn_${"a".repeat(32)}`,
};
const REQUEST: AwsHealthProviderRequest = {
  schemaVersion: "sutra.aws-health-provider-request.v1",
  requestId: `hrr_${"b".repeat(64)}`,
  scheduledWindow: "2026-08-02T00:00:00.000Z",
  scope: {
    orgId: "org_health", customerId: "customer_health",
    connectionId: TARGET.connectionId, accountId: TARGET.accountId,
    partition: "aws", endpointRegion: "us-east-1",
  },
  candidateAccounts: [TARGET], enabledObservedSince: null,
  healthOperations: [
    "health:DescribeAffectedAccountsForOrganization",
    "health:DescribeAffectedEntitiesForOrganization",
    "health:DescribeEventDetailsForOrganization",
    "health:DescribeEventsForOrganization",
  ],
  configurationOperation: "health:DescribeHealthServiceStatusForOrganization",
  prerequisiteOperations: [
    "organizations:DescribeOrganization",
    "organizations:ListDelegatedAdministrators",
  ],
  bounds: AWS_HEALTH_PROVIDER_BOUNDS, locale: "en",
  unfilteredAvailableEvents: true,
  credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS",
  deadlineAtIso: "2026-08-02T00:15:00.000Z",
};

test("SDK reader pins exact commands, inputs, abort signal and one request-local session", async () => {
  const sent: { readonly name: string; readonly input: unknown }[] = [];
  let sessions = 0;
  const signal = new AbortController().signal;
  const client = {
    send: async (command: unknown, options: { readonly abortSignal: AbortSignal }) => {
      assert.equal(options.abortSignal, signal);
      const item = command as { readonly constructor: { readonly name: string }; readonly input: unknown };
      sent.push({ name: item.constructor.name, input: item.input });
      return {};
    },
  };
  const reader = createAwsHealthSdkReader({
    request: REQUEST,
    sessionForTarget: async () => {
      sessions += 1;
      return {
        accessKeyId: "SUTRATESTACCESSKEY000",
        secretAccessKey: "test-secret-placeholder".repeat(2),
        sessionToken: "test-session-token",
        expiration: new Date("2026-08-02T01:00:00.000Z"),
      };
    },
    clientFactory: () => ({ health: client, organizations: client }),
  });
  await reader.describeOrganization(TARGET, signal);
  await reader.listDelegatedAdministrators(
    TARGET,
    { servicePrincipal: "health.amazonaws.com", nextToken: "token1" },
    signal,
  );
  await reader.describeOrganizationViewStatus(TARGET, signal);
  await reader.describeEvents(
    TARGET,
    { filter: null, locale: "en", maxResults: 100, nextToken: null },
    signal,
  );
  await reader.describeAffectedAccounts(
    TARGET,
    { eventArn: "event", maxResults: 100, nextToken: null },
    signal,
  );
  await reader.describeAffectedEntities(TARGET, {
    locale: "en", maxResults: 100, nextToken: null,
    organizationEntityAccountFilters: null,
    organizationEntityFilters: [{ eventArn: "event", awsAccountId: null }],
  }, signal);
  await reader.describeEventDetails(TARGET, {
    locale: "en",
    organizationEventDetailFilters: [{
      eventArn: "event", awsAccountId: "222233334444",
    }],
  }, signal);
  assert.equal(sessions, 1);
  assert.deepEqual(sent.map((item) => item.name), [
    "DescribeOrganizationCommand",
    "ListDelegatedAdministratorsCommand",
    "DescribeHealthServiceStatusForOrganizationCommand",
    "DescribeEventsForOrganizationCommand",
    "DescribeAffectedAccountsForOrganizationCommand",
    "DescribeAffectedEntitiesForOrganizationCommand",
    "DescribeEventDetailsForOrganizationCommand",
  ]);
  assert.deepEqual(sent[1]?.input, {
    ServicePrincipal: "health.amazonaws.com", MaxResults: 20,
    NextToken: "token1",
  });
  assert.deepEqual(sent[3]?.input, { locale: "en", maxResults: 100 });
  assert.deepEqual(sent[5]?.input, {
    locale: "en", maxResults: 100,
    organizationEntityFilters: [{ eventArn: "event" }],
  });
  assert.deepEqual(sent[6]?.input, {
    locale: "en",
    organizationEventDetailFilters: [{
      eventArn: "event", awsAccountId: "222233334444",
    }],
  });
});

test("SDK reader rejects targets outside the signed candidate catalog", async () => {
  const reader = createAwsHealthSdkReader({
    request: REQUEST,
    sessionForTarget: async () => {
      throw new Error("must not assume");
    },
    clientFactory: () => {
      throw new Error("must not create");
    },
  });
  await assert.rejects(reader.describeOrganization({
    accountId: "999988887777",
    connectionId: `conn_${"f".repeat(32)}`,
  }, new AbortController().signal), /AWS_HEALTH_SDK_TARGET_REJECTED/u);
});
