import assert from "node:assert/strict";
import test from "node:test";
import { DescribeCasesCommand, DescribeCommunicationsCommand } from "@aws-sdk/client-support";
import {
  collectAwsSupportCasesProviderEvidence,
  type AwsSupportCasesProviderClient,
  type AwsSupportCasesProviderRequest,
} from "../src/aws-support-cases-provider-adapter.js";
import {
  parseAwsSupportCasesProviderRouteRequest,
  runAwsSupportCasesProviderRoute,
} from "../src/aws-support-cases-provider-route.js";

const CONNECTION = `conn_${"a".repeat(32)}`;
const JOB = `supportjob_${"b".repeat(32)}`;
const ACCOUNT = "111122223333";
const request: AwsSupportCasesProviderRequest = {
  tenantId: "org_support_provider",
  customerId: "customer_support_provider",
  parentConnectionId: CONNECTION,
  partition: "aws",
  endpointRegion: "us-east-1",
  jobId: JOB,
  window: {
    mode: "INITIAL",
    afterTime: "2024-08-02T00:00:00.000Z",
    beforeTime: "2026-08-02T00:00:00.000Z",
    priorWatermark: null,
    nextWatermark: "2026-08-02T00:00:00.000Z",
  },
  intendedAccounts: [{ accountId: ACCOUNT, connectionId: CONNECTION }],
};

function routeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...request,
    readOperations: ["support:DescribeCases", "support:DescribeCommunications"],
    entitlementProbe: "DESCRIBE_CASES_AUTHORIZATION_OUTCOME",
    credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS",
    sanitizeBeforeBroker: true,
    includeRawSubjects: false,
    includeRawCommunications: false,
    includeContactIdentifiers: false,
    includeAttachmentMetadata: false,
    includeProviderMessages: false,
    includeRawPaginationTokens: false,
    limits: {
      casePageSize: 100, communicationPageSize: 100,
      maximumRequestsPerSecondPerAccount: 4, maximumConcurrency: 2,
      maximumDurationMs: 900_000, maximumBytes: 67_108_864,
      maximumCasePages: 10_000, maximumCommunicationPages: 50_000,
      maximumCases: 50_000, maximumCommunications: 250_000,
    },
    ...overrides,
  });
}

function client(): AwsSupportCasesProviderClient {
  return {
    async send(command) {
      if (command instanceof DescribeCasesCommand) return {
        cases: [{
          caseId: "case-123456789012-2026-deadbeef",
          displayId: "1000000001",
          subject: "production database contains customer PII",
          status: "pending-customer-action",
          serviceCode: "amazon-rds",
          categoryCode: "performance",
          severityCode: "high",
          submittedBy: "AdminRole (Role) <private@example.com>",
          timeCreated: "2026-08-01T00:00:00.000Z",
          ccEmailAddresses: ["another-private@example.com"],
          language: "en",
        }],
      };
      if (command instanceof DescribeCommunicationsCommand) return {
        communications: [{
          caseId: "case-123456789012-2026-deadbeef",
          body: "raw support correspondence must never cross the boundary",
          submittedBy: "Amazon Web Services",
          timeCreated: "2026-08-01T01:00:00.000Z",
          attachmentSet: [{ attachmentId: "private-attachment-id", fileName: "customer-list.csv" }],
        }],
      };
      throw new Error("unexpected command");
    },
  };
}

test("provider converts every sensitive Support field to keyed evidence before returning", async () => {
  let clock = Date.parse("2026-08-02T00:01:00.000Z");
  const capture = await collectAwsSupportCasesProviderEvidence({
    request,
    evidenceKey: new Uint8Array(32).fill(7),
    signal: new AbortController().signal,
    clientForAccount: async () => client(),
    now: () => clock++,
  });
  const serialized = JSON.stringify(capture);
  for (const secret of [
    "production database contains customer PII", "private@example.com",
    "another-private@example.com", "raw support correspondence",
    "private-attachment-id", "customer-list.csv",
  ]) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /hmac-sha256:[a-f0-9]{64}/u);
  assert.equal(capture.accounts[0]?.supportPlan, "qualifying_plan_unclassified");
  assert.equal(capture.accounts[0]?.entitlementState, "QUALIFYING");
  assert.equal(capture.accounts[0]?.status, "SUCCEEDED");
});

test("provider route pins exact privacy flags, headers, account session and request digest", async () => {
  const body = routeBody();
  const parsed = parseAwsSupportCasesProviderRouteRequest(body);
  assert.deepEqual(parsed, request);
  let assumed = 0;
  let clock = Date.parse("2026-08-02T00:01:00.000Z");
  const response = await runAwsSupportCasesProviderRoute({
    body,
    headers: { tenantId: request.tenantId, customerId: request.customerId, connectionId: CONNECTION, jobId: JOB },
    signal: new AbortController().signal,
  }, {
    evidenceKey: new Uint8Array(32).fill(9),
    assumeReadOnlySession: async (input) => {
      assumed += 1;
      assert.equal(input.connectionId, CONNECTION);
      assert.deepEqual(input.sessionActions, [
        "sts:GetCallerIdentity", "support:DescribeCases", "support:DescribeCommunications",
      ]);
      return {
        accountId: ACCOUNT, partition: "aws",
        credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "secret", sessionToken: "token", expiration: new Date(clock + 60_000) },
      };
    },
    clientFactory: () => client(),
    now: () => clock++,
  });
  assert.equal(assumed, 1);
  assert.equal(response.requestBodySha256.length, 64);
  assert.equal(response.jobId, JOB);

  assert.throws(() => parseAwsSupportCasesProviderRouteRequest(routeBody({ includeRawSubjects: true })));
  await assert.rejects(runAwsSupportCasesProviderRoute({
    body,
    headers: { tenantId: "other_org", customerId: request.customerId, connectionId: CONNECTION, jobId: JOB },
    signal: new AbortController().signal,
  }, {
    evidenceKey: new Uint8Array(32).fill(9),
    assumeReadOnlySession: async () => { throw new Error("must not assume"); },
  }));
});

test("subscription and access failures are allowlisted without provider diagnostics", async () => {
  let clock = Date.parse("2026-08-02T00:01:00.000Z");
  const capture = await collectAwsSupportCasesProviderEvidence({
    request,
    evidenceKey: new Uint8Array(32).fill(3),
    signal: new AbortController().signal,
    clientForAccount: async () => ({
      async send() { throw Object.assign(new Error("secret provider diagnostic"), { name: "SubscriptionRequiredException" }); },
    }),
    now: () => clock++,
  });
  assert.equal(capture.accounts[0]?.failureCode, "SUBSCRIPTION_REQUIRED");
  assert.equal(capture.accounts[0]?.supportPlan, "not_qualifying");
  assert.equal(JSON.stringify(capture).includes("secret provider diagnostic"), false);
});
