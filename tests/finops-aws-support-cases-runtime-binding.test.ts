import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AwsSupportCasesSignedBrokerError,
  createAwsSupportCasesSignedBroker,
} from "../lib/finops-aws-support-cases-signed-broker.ts";
import {
  AWS_SUPPORT_CASES_RUNTIME_JOB_KIND,
  scheduleAwsSupportCasesCollections,
} from "../lib/finops-aws-support-cases-runtime-binding.ts";
import type { AwsSupportCasesBrokerRequest } from
  "../lib/finops-aws-support-cases-radar.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const scope = {
  organizationId: "org_support",
  customerId: "customer_support",
  parentConnectionId: CONNECTION,
  partition: "aws" as const,
};
const window = {
  mode: "INCREMENTAL" as const,
  afterTime: "2026-07-30T00:00:00.000Z",
  beforeTime: "2026-08-01T00:00:00.000Z",
  priorWatermark: "2026-07-31T00:00:00.000Z",
  nextWatermark: "2026-08-01T00:00:00.000Z",
};

function base64Url(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64url");
}

async function signingConfiguration() {
  const client = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const broker = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return {
    clientKeyId: "support-client-v1",
    clientPrivateKey: base64Url(await crypto.subtle.exportKey("pkcs8", client.privateKey)),
    brokerKeyId: "support-broker-v1",
    brokerPublicKey: base64Url(await crypto.subtle.exportKey("spki", broker.publicKey)),
  };
}

test("Support scheduler accepts only server-resolved scopes and identity-only windows", async () => {
  const calls: unknown[] = [];
  const result = await scheduleAwsSupportCasesCollections({
    loadEligibleScopes: async () => [scope],
    resolveWindow: async () => window,
    queue: { enqueue: async (value) => { calls.push(value); } },
  });
  assert.equal(result.enqueued, 1);
  assert.deepEqual(calls, [{
    orgId: scope.organizationId,
    customerId: scope.customerId,
    connectionId: scope.parentConnectionId,
    kind: AWS_SUPPORT_CASES_RUNTIME_JOB_KIND,
    payload: { window },
    maxAttempts: 5,
    idempotencyKey: `aws-support-cases:${CONNECTION}:${window.nextWatermark}`,
  }]);
  await assert.rejects(scheduleAwsSupportCasesCollections({
    loadEligibleScopes: async () => [scope, scope],
    resolveWindow: async () => window,
    queue: { enqueue: async () => { throw new Error("must not enqueue"); } },
  }));

  let enqueuedBeforeWindowValidation = false;
  await assert.rejects(scheduleAwsSupportCasesCollections({
    loadEligibleScopes: async () => [
      scope,
      { ...scope, parentConnectionId: `conn_${"b".repeat(32)}` },
    ],
    resolveWindow: async (candidate) => candidate.parentConnectionId === CONNECTION
      ? window
      : { ...window, beforeTime: "2026-09-15T00:00:00.000Z", nextWatermark: "2026-09-15T00:00:00.000Z" },
    queue: { enqueue: async () => { enqueuedBeforeWindowValidation = true; } },
  }));
  assert.equal(enqueuedBeforeWindowValidation, false);
});

test("Support broker signs the exact privacy-minimized request and rejects unsigned output", async () => {
  const observed: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const broker = createAwsSupportCasesSignedBroker({
    configuration: {
      brokerOrigin: "https://support-broker.internal.example",
      signing: await signingConfiguration(),
    },
    now: () => Date.parse("2026-08-01T01:00:00.000Z"),
    nonce: () => "supportBrokerNonce000001",
    fetcher: async (url, init) => {
      observed.push({ url: String(url), init });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const request: AwsSupportCasesBrokerRequest = {
    tenantId: "org_support",
    customerId: "customer_support",
    parentConnectionId: CONNECTION,
    partition: "aws",
    endpointRegion: "us-east-1",
    jobId: `supportjob_${"b".repeat(32)}`,
    window,
    intendedAccounts: [{ accountId: "111122223333", connectionId: CONNECTION }],
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
      casePageSize: 100,
      communicationPageSize: 100,
      maximumRequestsPerSecondPerAccount: 4,
      maximumConcurrency: 2,
      maximumDurationMs: 900_000,
      maximumBytes: 67_108_864,
      maximumCasePages: 10_000,
      maximumCommunicationPages: 50_000,
      maximumCases: 50_000,
      maximumCommunications: 250_000,
    },
  };
  await assert.rejects(
    broker.collect(request),
    (error) => error instanceof AwsSupportCasesSignedBrokerError
      && error.code === "BROKER_AUTHENTICATION_FAILED",
  );
  const call = observed[0];
  assert.ok(call);
  assert.equal(call.url, "https://support-broker.internal.example/v1/finops/aws-support-cases/collect");
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("x-sutra-tenant-id"), request.tenantId);
  assert.equal(headers.get("x-sutra-customer-id"), request.customerId);
  assert.equal(headers.get("x-sutra-connection-id"), request.parentConnectionId);
  assert.match(headers.get("x-sutra-signature") ?? "", /^[A-Za-z0-9_-]{86}$/u);
  const sent = JSON.parse(call.init?.body as string) as AwsSupportCasesBrokerRequest;
  assert.equal(sent.includeRawCommunications, false);
  assert.equal(sent.includeContactIdentifiers, false);
  assert.equal(sent.entitlementProbe, "DESCRIBE_CASES_AUTHORIZATION_OUTCOME");
});

test("Support runtime contract pins entitlement probing and remains honestly unregistered", async () => {
  const [engine, runtime, broker] = await Promise.all([
    readFile(new URL("../lib/finops-aws-support-cases-radar.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/finops-aws-support-cases-runtime-binding.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/finops-aws-support-cases-signed-broker.ts", import.meta.url), "utf8"),
  ]);
  assert.match(engine, /entitlementProbe: "DESCRIBE_CASES_AUTHORIZATION_OUTCOME"/u);
  assert.match(engine, /credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS"/u);
  assert.match(runtime, /loadScope/u);
  assert.match(runtime, /job\.maxAttempts !== 5/u);
  assert.match(runtime, /maximumIncrementalWindowDays/u);
  assert.match(runtime, /targets: dependencies\.targets/u);
  assert.match(runtime, /registeredInSharedRuntime: false/u);
  assert.match(broker, /verifyHostedBrokerResponse/u);
  assert.match(broker, /maximumCaptureBytes/u);
  assert.doesNotMatch(broker, /provider secret|raw correspondence/iu);
});
