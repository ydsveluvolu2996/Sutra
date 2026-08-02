import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  EXTENDED_SUPPORT_PROVIDER_OPERATIONS,
  EXTENDED_SUPPORT_PROVIDER_SESSION_ACTIONS,
  ExtendedSupportProviderAdapterError,
  collectExtendedSupportProviderEvidence,
  type ExtendedSupportAwsReader,
  type ExtendedSupportProviderBoundary,
  type ExtendedSupportProviderRegionCoverage,
} from "../src/extended-support-provider-adapter.js";
import {
  parseExtendedSupportProviderRouteRequest,
  runExtendedSupportProviderRoute,
} from "../src/extended-support-provider-route.js";
import { extendedSupportProviderSessionPolicy } from "../src/role-broker.js";
import {
  createLocalCollectorServer,
  type CollectorConnectionRegistry,
} from "../src/local-server.js";
import type { ValidatedRoleSession } from "../src/types.js";

const CONNECTION = `conn_${"a".repeat(32)}`;
const JOB = `job_${"b".repeat(32)}`;
const WINDOW = "2026-08-02T00:00:00.000Z";
const NOW = Date.parse(WINDOW);
const BOUNDARY: ExtendedSupportProviderBoundary = Object.freeze({
  scope: Object.freeze({
    orgId: "org_extended",
    customerId: "customer_extended",
    connectionId: CONNECTION,
  }),
  managementAccountId: "111122223333",
  partition: "aws",
  accountIds: Object.freeze(["111122223333", "222233334444"]),
  regions: Object.freeze(["us-east-1", "us-west-2"]),
});
const COVERAGE: readonly ExtendedSupportProviderRegionCoverage[] = Object.freeze([
  { service: "EKS", status: "SUCCEEDED", readPermissionsValidated: true, errorCode: null },
  { service: "RDS", status: "SUCCEEDED", readPermissionsValidated: true, errorCode: null },
  { service: "AURORA", status: "SUCCEEDED", readPermissionsValidated: true, errorCode: null },
  { service: "OPENSEARCH", status: "SUCCEEDED", readPermissionsValidated: true, errorCode: null },
  { service: "ELASTICACHE", status: "SUCCEEDED", readPermissionsValidated: true, errorCode: null },
]);

function reader(options: {
  finalPage?: boolean;
  wrongAccount?: boolean;
  extraPage?: boolean;
  supplementScope?: ExtendedSupportProviderBoundary["scope"];
  session?: (accountId: string, signal: AbortSignal) => Promise<unknown>;
} = {}): ExtendedSupportAwsReader {
  return {
    collectRegion: async ({ accountId, region, signal }) => {
      await options.session?.(accountId, signal);
      return {
        pages: (async function* () {
          yield {
            schemaVersion: "sutra.extended-support-provider-page.v1" as const,
            accountId: options.wrongAccount ? "999988887777" : accountId,
            region,
            pageNumber: 1,
            finalPage: options.finalPage ?? !options.extraPage,
            observations: [{
              service: "EKS", engine: "kubernetes", supportVersionKey: "1.31",
              accountId, region,
            }],
            calendars: [],
            rates: [],
          };
          if (options.extraPage) yield {
            schemaVersion: "sutra.extended-support-provider-page.v1" as const,
            accountId,
            region,
            pageNumber: 2,
            finalPage: true,
            observations: [],
            calendars: [],
            rates: [],
          };
        })(),
        coverage: Promise.resolve(COVERAGE),
      };
    },
    collectSupplement: async () => ({
      schemaVersion: "sutra.extended-support-provider-supplement.v1",
      scope: options.supplementScope ?? BOUNDARY.scope,
      calendars: [],
      rates: [],
      observedCharges: [],
    }),
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "sutra.extended-support-collector-request.v1",
    jobId: JOB,
    scheduledWindow: WINDOW,
    boundary: BOUNDARY,
    operations: EXTENDED_SUPPORT_PROVIDER_OPERATIONS,
    bounds: {
      maximumCaptureBytes: 32 * 1_024 * 1_024,
      maximumOutputBytes: 8 * 1_024 * 1_024,
      maximumDurationMs: 15 * 60 * 1_000,
      maximumAccounts: 1_000,
      maximumRegions: 50,
      maximumObservations: 50_000,
      maximumHistoryPerResource: 24,
      maximumHistoryAgeDays: 400,
      maximumCurrentObservationAgeHours: 48,
      maximumAuthoritativeEvidenceAgeHours: 31 * 24,
      maximumCalendarEntries: 2_000,
      maximumRates: 10_000,
      maximumObservedCharges: 100_000,
      maximumResourcesInResponse: 5_000,
      maximumTextLength: 512,
      maximumUnitsPerHour: 100_000,
    },
    inventoryScope: "SERVER_PINNED_ACCOUNT_REGION_FANOUT",
    lifecycleSource: "AUTHORITATIVE_AWS_API_OR_DOCUMENTATION",
    pricingSource: "AWS_PRICE_LIST_OR_PUBLIC_PRICING",
    actualCostSource: "ACTIVE_RECONCILED_CUR2_GENERATION",
    deadlineAtIso: "2026-08-02T00:15:00.000Z",
    ...overrides,
  };
}

describe("Extended Support credential-owning provider boundary", () => {
  it("uses an exact, mutation-free STS session policy", () => {
    const policy = JSON.parse(extendedSupportProviderSessionPolicy()) as {
      readonly Version: string;
      readonly Statement: readonly [{
        readonly Effect: string;
        readonly Action: readonly string[];
        readonly Resource: string;
      }];
    };
    assert.equal(policy.Version, "2012-10-17");
    assert.equal(policy.Statement.length, 1);
    assert.equal(policy.Statement[0].Effect, "Allow");
    assert.equal(policy.Statement[0].Resource, "*");
    assert.deepEqual(policy.Statement[0].Action, EXTENDED_SUPPORT_PROVIDER_SESSION_ACTIONS);
    assert.equal(policy.Statement[0].Action.some((action) =>
      /create|delete|modify|put|update/iu.test(action)), false);
  });

  it("fans out every pinned account/Region and emits a deterministic bounded capture", async () => {
    const calls: string[] = [];
    const capture = await collectExtendedSupportProviderEvidence({
      boundary: BOUNDARY,
      reader: reader({ session: async (accountId) => { calls.push(accountId); } }),
      signal: new AbortController().signal,
      now: () => NOW,
    });
    assert.equal(calls.length, 4);
    assert.deepEqual([...new Set(calls)].sort(), BOUNDARY.accountIds);
    assert.equal(capture.observations.length, 4);
    assert.match(capture.collectionId, /^esp_[a-f0-9]{64}$/u);
    assert.equal(capture.coverage.length, 5);
    assert.ok(capture.coverage.every((entry) => entry.status === "SUCCEEDED"
      && entry.readPermissionsValidated && entry.accountIds.length === 2
      && entry.regions.length === 2));
  });

  it("fails closed on incomplete pagination, substituted scope and abort", async () => {
    await assert.rejects(collectExtendedSupportProviderEvidence({
      boundary: BOUNDARY,
      reader: reader({ finalPage: false }),
      signal: new AbortController().signal,
      now: () => NOW,
    }), (error) => error instanceof ExtendedSupportProviderAdapterError
      && error.code === "PROVIDER_RESPONSE_INVALID");
    await assert.rejects(collectExtendedSupportProviderEvidence({
      boundary: BOUNDARY,
      reader: reader({ wrongAccount: true }),
      signal: new AbortController().signal,
      now: () => NOW,
    }), (error) => error instanceof ExtendedSupportProviderAdapterError
      && error.code === "PROVIDER_RESPONSE_INVALID");
    await assert.rejects(collectExtendedSupportProviderEvidence({
      boundary: BOUNDARY,
      reader: reader({ supplementScope: { ...BOUNDARY.scope, customerId: "attacker" } }),
      signal: new AbortController().signal,
      now: () => NOW,
    }), (error) => error instanceof ExtendedSupportProviderAdapterError
      && error.code === "PROVIDER_RESPONSE_INVALID" && !error.message.includes("attacker"));
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(collectExtendedSupportProviderEvidence({
      boundary: BOUNDARY,
      reader: reader(),
      signal: aborted.signal,
    }), (error) => error instanceof ExtendedSupportProviderAdapterError
      && error.code === "INVALID_REQUEST");
  });

  it("parses exact requests and rejects extra or changed authority", () => {
    assert.deepEqual(parseExtendedSupportProviderRouteRequest(JSON.stringify(request())).boundary, BOUNDARY);
    for (const body of [
      request({ accountId: "999988887777" }),
      request({ operations: [...EXTENDED_SUPPORT_PROVIDER_OPERATIONS].reverse() }),
      request({ inventoryScope: "CALLER_SUPPLIED" }),
      request({ bounds: { maximumCaptureBytes: 1 } }),
    ]) assert.throws(() => parseExtendedSupportProviderRouteRequest(JSON.stringify(body)),
      (error) => error instanceof ExtendedSupportProviderAdapterError);
  });

  it("attests every exact account session, binds headers and discards credentials", async () => {
    const sessions: unknown[] = [];
    const body = JSON.stringify(request());
    const result = await runExtendedSupportProviderRoute({
      body,
      headers: {
        tenantId: BOUNDARY.scope.orgId,
        customerId: BOUNDARY.scope.customerId,
        connectionId: BOUNDARY.scope.connectionId,
        jobId: JOB,
      },
      signal: new AbortController().signal,
    }, {
      assumeReadOnlySession: async (value) => {
        sessions.push(value);
        return {
          accountId: value.expectedAccountId,
          partition: value.partition,
          credentials: {
            accessKeyId: "ASIAEXAMPLE",
            secretAccessKey: "never-returned",
            sessionToken: "never-returned",
            expiration: new Date(NOW + 900_000),
          },
        };
      },
      readerFactory: ({ sessionForAccount }) => reader({ session: sessionForAccount }),
      now: () => NOW,
    });
    assert.equal(sessions.length, 4);
    assert.ok(sessions.every((value) => JSON.stringify(value).includes("sts:GetCallerIdentity")));
    assert.equal(result.schemaVersion, "sutra.extended-support-provider-response.v1");
    assert.equal(result.jobId, JOB);
    assert.match(result.requestBodySha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(result), /ASIAEXAMPLE|never-returned/u);

    await assert.rejects(runExtendedSupportProviderRoute({
      body,
      headers: {
        tenantId: BOUNDARY.scope.orgId,
        customerId: "attacker",
        connectionId: BOUNDARY.scope.connectionId,
        jobId: JOB,
      },
      signal: new AbortController().signal,
    }, {
      assumeReadOnlySession: async () => { throw new Error("must not run"); },
      readerFactory: () => reader(),
    }), (error) => error instanceof ExtendedSupportProviderAdapterError
      && error.code === "INVALID_REQUEST" && !error.message.includes("attacker"));
  });

  it("serves the authenticated local collector route and rejects header substitution", async () => {
    let assumed = 0;
    const server = createLocalCollectorServer({
      mode: "live",
      allowLiveAws: true,
      hostedRuntime: true,
      principalArn: "arn:aws:iam::999900001111:role/SutraHostedBroker",
      now: () => new Date(NOW),
      registry: {} as CollectorConnectionRegistry,
      authenticator: {
        verify: async () => ({ nonce: "test-nonce", timestamp: NOW }),
        responseSignature: async () => "test-signature",
      },
      extendedSupportReaderFactory: ({ sessionForAccount }) =>
        reader({ session: sessionForAccount }),
      extendedSupportRoleBrokerFactory: () => ({
        assumeValidatedExtendedSupportSession: async (scope, connectionId, jobId, input) => {
          assumed += 1;
          assert.equal(scope.tenantId, BOUNDARY.scope.orgId);
          assert.equal(connectionId, BOUNDARY.scope.connectionId);
          assert.equal(jobId, JOB);
          assert.deepEqual(input.sessionActions, EXTENDED_SUPPORT_PROVIDER_SESSION_ACTIONS);
          return {
            connectionId,
            accountId: input.expectedAccountId,
            partition: "aws",
            roleArn: `arn:aws:iam::${input.expectedAccountId}:role/SutraCollectorRole`,
            roleSessionName: "sutra-extended-test",
            callerIdentityArn:
              `arn:aws:sts::${input.expectedAccountId}:assumed-role/SutraCollectorRole/sutra-extended-test`,
            expiresAt: new Date(NOW + 900_000),
            credentials: {
              accessKeyId: "server-access-key",
              secretAccessKey: "server-secret-key",
              sessionToken: "server-session-token",
              expiration: new Date(NOW + 900_000),
            },
          } satisfies ValidatedRoleSession;
        },
      }),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (tenantId: string) => fetch(
      `${base}/v1/finops/extended-support/collect`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sutra-tenant-id": tenantId,
          "x-sutra-customer-id": BOUNDARY.scope.customerId,
          "x-sutra-connection-id": BOUNDARY.scope.connectionId,
          "x-sutra-job-id": JOB,
        },
        body: JSON.stringify(request()),
      },
    );
    try {
      const accepted = await post(BOUNDARY.scope.orgId);
      assert.equal(accepted.status, 200);
      const value = await accepted.json() as Record<string, unknown>;
      assert.equal(value.jobId, JOB);
      assert.doesNotMatch(JSON.stringify(value), /server-secret-key|server-session-token/u);
      assert.equal(assumed, 4);

      const substituted = await post("org_foreign");
      assert.equal(substituted.status, 400);
      assert.deepEqual(await substituted.json(), {
        code: "INVALID_REQUEST",
        message: "The bounded Extended Support provider collection did not complete",
      });
      assert.equal(assumed, 4, "header substitution must fail before role assumption");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
