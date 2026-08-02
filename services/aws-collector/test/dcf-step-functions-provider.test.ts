import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  DCF_PROVIDER_ACTIONS,
  DCF_PROVIDER_BOUNDS,
  DcfProviderAdapterError,
  collectDcfProviderEvidence,
  type DcfProviderRequest,
} from "../src/dcf-step-functions-provider-adapter.js";
import {
  parseDcfProviderRouteRequest,
  runDcfProviderRoute,
} from "../src/dcf-step-functions-provider-route.js";
import { createLocalCollectorServer, type CollectorConnectionRegistry } from
  "../src/local-server.js";
import type { ValidatedRoleSession } from "../src/types.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const MACHINE = "arn:aws:states:us-east-1:111122223333:stateMachine:CID-DataCollection";
const EXECUTION = "arn:aws:states:us-east-1:111122223333:execution:CID-DataCollection:run-1";
const request: DcfProviderRequest = {
  schemaVersion: "sutra.dcf-step-functions-provider-request.v1",
  boundary: {
    schemaVersion: "sutra.dcf-step-functions-boundary.v1",
    boundaryId: `dcfb_${"b".repeat(64)}`,
    binding: "SERVER_RESOLVED_DCF_STACK",
    scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: `conn_${"a".repeat(32)}`, managementAccountId: "111122223333", partition: "aws", region: "us-east-1" },
    schedulerRegistered: true,
    modules: [{ moduleId: "cur", moduleName: "CUR collector", sourceId: "aws_cur2_data_export", enabled: true, expectedCadenceMinutes: 60, stateMachineArn: MACHINE }],
  },
  operations: DCF_PROVIDER_ACTIONS,
  bounds: DCF_PROVIDER_BOUNDS,
  credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
  includeRawInput: false,
  includeRawOutput: false,
  includeRawProviderErrors: false,
  includeRawPaginationTokens: false,
  deadlineAtIso: new Date(NOW + DCF_PROVIDER_BOUNDS.maximumDurationMs).toISOString(),
};
const credentials = { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date(NOW + 3_600_000) };

test("credential route pins scope/actions and returns sanitized execution evidence", async () => {
  const calls: string[] = []; let assumed = false;
  const body = JSON.stringify(request);
  const response = await runDcfProviderRoute({ body, headers: {
    tenantId: request.boundary.scope.orgId, customerId: request.boundary.scope.customerId,
    connectionId: request.boundary.scope.connectionId, boundaryId: request.boundary.boundaryId,
  }, signal: new AbortController().signal }, {
    now: () => NOW,
    async assumeReadOnlySession(value) {
      assumed = true;
      assert.deepEqual(value.sessionActions, DCF_PROVIDER_ACTIONS);
      assert.deepEqual(value.stateMachineArns, [MACHINE]);
      return { accountId: "111122223333", partition: "aws", credentials };
    },
    readerFactory() { return {
      async describeStateMachine(input) { calls.push(`machine:${input.includedData}`); return { stateMachineArn: MACHINE, status: "ACTIVE", type: "STANDARD", definition: "must-not-cross" }; },
      async listExecutions(input) { calls.push(`list:${String(input.nextToken)}`); return { executions: [{ executionArn: EXECUTION, stateMachineArn: MACHINE, status: "FAILED", startDate: new Date(NOW - 120_000), stopDate: new Date(NOW - 60_000) }], nextToken: null }; },
      async describeExecution(input) { calls.push(`execution:${input.includedData}`); return { executionArn: EXECUTION, stateMachineArn: MACHINE, status: "FAILED", startDate: new Date(NOW - 120_000), stopDate: new Date(NOW - 60_000), redriveCount: 2, input: "{\"credential\":\"private\"}", inputDetails: { included: true }, output: "private-output", error: "States.Timeout", cause: "secret cause" }; },
    }; },
  });
  assert.equal(assumed, true);
  assert.deepEqual(calls, ["machine:METADATA_ONLY", "list:null", "execution:METADATA_ONLY"]);
  assert.equal(response.requestBodySha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(response.result.sourceState, "READY");
  const execution = response.result.capture.modules[0]?.executions[0];
  assert.equal(execution?.attempt, 3);
  assert.equal(execution?.errorCode, "TIMEOUT");
  assert.equal(execution?.inputSha256, createHash("sha256").update("{\"credential\":\"private\"}").digest("hex"));
  assert.equal(execution?.acceptedRecords, null);
  const serialized = JSON.stringify(response);
  for (const secret of ["credential", "private-output", "secret cause", "States.Timeout"]) assert.equal(serialized.includes(secret), false);
});

test("route rejects substitutions before assuming a role and partial metadata never claims ready", async () => {
  const hostile = JSON.stringify({ ...request, boundary: { ...request.boundary, scope: { ...request.boundary.scope, managementAccountId: "999988887777" } } });
  assert.throws(() => parseDcfProviderRouteRequest(hostile), (error) => error instanceof DcfProviderAdapterError && error.code === "INVALID_REQUEST");
  let assumed = false;
  await assert.rejects(runDcfProviderRoute({ body: JSON.stringify(request), headers: {
    tenantId: "attacker", customerId: request.boundary.scope.customerId,
    connectionId: request.boundary.scope.connectionId, boundaryId: request.boundary.boundaryId,
  }, signal: new AbortController().signal }, {
    now: () => NOW,
    async assumeReadOnlySession() { assumed = true; return { accountId: "111122223333", partition: "aws", credentials }; },
    readerFactory() { throw new Error("must not run"); },
  }), (error) => error instanceof DcfProviderAdapterError && error.code === "INVALID_REQUEST");
  assert.equal(assumed, false);

  const partial = await collectDcfProviderEvidence({ request, now: () => NOW, signal: new AbortController().signal, reader: {
    async describeStateMachine() { return { stateMachineArn: MACHINE, status: "ACTIVE", type: "STANDARD" }; },
    async listExecutions() { return { executions: [{ executionArn: EXECUTION, stateMachineArn: MACHINE, status: "SUCCEEDED" }], nextToken: null }; },
    async describeExecution() { throw new Error("must not run for invalid summary"); },
  } });
  assert.equal(partial.sourceState, "PARTIAL");
  assert.equal(partial.capture.pagesExhausted, false);
  assert.deepEqual(partial.failureCodes, ["SCHEMA_MISMATCH"]);
  assert.equal(partial.capture.modules[0]?.executions.length, 0);
});

test("metadata-only omission remains null instead of inventing an input digest or coverage", async () => {
  const result = await collectDcfProviderEvidence({ request, now: () => NOW, signal: new AbortController().signal, reader: {
    async describeStateMachine() { return { stateMachineArn: MACHINE, status: "ACTIVE", type: "STANDARD" }; },
    async listExecutions() { return { executions: [{ executionArn: EXECUTION, stateMachineArn: MACHINE, status: "SUCCEEDED", startDate: NOW - 120_000, stopDate: NOW - 60_000 }], nextToken: null }; },
    async describeExecution() { return { executionArn: EXECUTION, stateMachineArn: MACHINE, status: "SUCCEEDED", startDate: NOW - 120_000, stopDate: NOW - 60_000, redriveCount: 0, inputDetails: { included: false } }; },
  } });
  const evidence = result.capture.modules[0]?.executions[0];
  assert.equal(evidence?.inputSha256, null);
  assert.deepEqual([evidence?.acceptedRecords, evidence?.rejectedRecords, evidence?.expectedRecords, evidence?.processedBytes], [null, null, null, null]);
});

test("hosted collector route owns the exact DCF session and rejects header substitution", async () => {
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
    dcfStepFunctionsReaderFactory: () => ({
      async describeStateMachine() {
        return { stateMachineArn: MACHINE, status: "ACTIVE", type: "STANDARD" };
      },
      async listExecutions() { return { executions: [], nextToken: null }; },
      async describeExecution() { throw new Error("no execution should be described"); },
    }),
    dcfStepFunctionsRoleBrokerFactory: () => ({
      assumeValidatedDcfStepFunctionsSession: async (scope, connectionId, boundaryId, input) => {
        assumed += 1;
        assert.equal(scope.tenantId, request.boundary.scope.orgId);
        assert.equal(connectionId, request.boundary.scope.connectionId);
        assert.equal(boundaryId, request.boundary.boundaryId);
        assert.deepEqual(input.stateMachineArns, [MACHINE]);
        assert.deepEqual(input.sessionActions, DCF_PROVIDER_ACTIONS);
        return {
          connectionId,
          accountId: request.boundary.scope.managementAccountId,
          partition: "aws",
          roleArn: `arn:aws:iam::${request.boundary.scope.managementAccountId}:role/sutra/SutraCollectorRole`,
          roleSessionName: "sutra-dcf-test",
          callerIdentityArn: `arn:aws:sts::${request.boundary.scope.managementAccountId}:assumed-role/SutraCollectorRole/sutra-dcf-test`,
          expiresAt: new Date(NOW + 60_000),
          credentials,
        } satisfies ValidatedRoleSession;
      },
    }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (tenantId: string) => fetch(`${base}/v1/finops/dcf-step-functions/collect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sutra-tenant-id": tenantId,
      "x-sutra-customer-id": request.boundary.scope.customerId,
      "x-sutra-connection-id": request.boundary.scope.connectionId,
      "x-sutra-boundary-id": request.boundary.boundaryId,
    },
    body: JSON.stringify(request),
  });
  try {
    const accepted = await post(request.boundary.scope.orgId);
    assert.equal(accepted.status, 200);
    assert.equal(JSON.stringify(await accepted.json()).includes("secret"), false);
    assert.equal(assumed, 1);
    const substituted = await post("org_foreign");
    assert.equal(substituted.status, 400);
    assert.equal(assumed, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
