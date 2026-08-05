import assert from "node:assert/strict";
import test from "node:test";

import {
  DCF_STEP_FUNCTIONS_PERMISSION_ACTIONS,
  DCF_STEP_FUNCTIONS_PERMISSION_CONTRACT,
  dcfExecutionArnForStateMachine,
  exactDcfPermissionResources,
} from "../src/dcf-step-functions-permission-contract.js";
import { dcfStepFunctionsSessionPolicy } from
  "../src/dcf-step-functions-session-policy.js";
import { createDcfStepFunctionsSdkReader } from
  "../src/dcf-step-functions-sdk-reader.js";

const MACHINES = Object.freeze([
  "arn:aws:states:us-east-1:111122223333:stateMachine:CID-Cost-Collector",
  "arn:aws:states:us-east-1:111122223333:stateMachine:CID-Inventory-Collector",
]);

test(".8.10 contract derives exact state-machine and execution resources", () => {
  assert.equal(
    DCF_STEP_FUNCTIONS_PERMISSION_CONTRACT.permissionPackVersion,
    "standard-2026-08.10",
  );
  assert.deepEqual(DCF_STEP_FUNCTIONS_PERMISSION_ACTIONS, [
    "states:ListExecutions",
    "states:DescribeExecution",
    "states:DescribeStateMachine",
  ]);
  assert.deepEqual(exactDcfPermissionResources(MACHINES), [
    ...MACHINES,
    ...MACHINES.map(dcfExecutionArnForStateMachine),
  ]);
  assert.throws(
    () => exactDcfPermissionResources([...MACHINES].reverse()),
    /DCF_STEP_FUNCTIONS_RESOURCE_INVALID/u,
  );
  assert.throws(
    () => exactDcfPermissionResources([
      "arn:aws:states:us-east-1:111122223333:stateMachine:qualified:alias",
    ]),
    /DCF_STEP_FUNCTIONS_RESOURCE_INVALID/u,
  );
});

test("session policy is a bounded least-privilege intersection", () => {
  const serialized = dcfStepFunctionsSessionPolicy({ stateMachineArns: MACHINES });
  assert.ok(Buffer.byteLength(serialized, "utf8") <= 2_048);
  const policy = JSON.parse(serialized) as {
    readonly Statement: readonly { readonly Sid: string; readonly Action: readonly string[]; readonly Resource: string | readonly string[] }[];
  };
  assert.deepEqual(policy.Statement.map(({ Sid }) => Sid), [
    "VerifyDcfIdentity",
    "ReadExactDcfStateMachines",
    "ReadExactDcfExecutions",
  ]);
  assert.deepEqual(policy.Statement[1]?.Resource, MACHINES);
  assert.deepEqual(
    policy.Statement[2]?.Resource,
    MACHINES.map(dcfExecutionArnForStateMachine),
  );
  assert.equal(serialized.includes('"Resource":"*"'), true);
  assert.equal(serialized.includes("states:StartExecution"), false);
});

test("default SDK reader rejects partition/Region substitution before client use", () => {
  const credentials = {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "token",
    expiration: new Date("2026-08-02T13:00:00.000Z"),
  };
  assert.throws(
    () => createDcfStepFunctionsSdkReader({
      credentials,
      partition: "aws-cn",
      region: "us-east-1",
    }),
    /DCF_STEP_FUNCTIONS_SDK_SCOPE_INVALID/u,
  );
});
