/** Exact read-only STS intersection for server-resolved DCF state machines. */
import {
  DCF_STEP_FUNCTIONS_PERMISSION_ACTIONS,
  dcfExecutionArnForStateMachine,
  exactDcfPermissionResources,
} from "./dcf-step-functions-permission-contract.js";

export function dcfStepFunctionsSessionPolicy(input: {
  readonly stateMachineArns: readonly string[];
}): string {
  exactDcfPermissionResources(input.stateMachineArns);
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [
    { Sid: "VerifyDcfIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    { Sid: "ReadExactDcfStateMachines", Effect: "Allow",
      Action: DCF_STEP_FUNCTIONS_PERMISSION_ACTIONS.filter((action) => action !== "states:DescribeExecution"),
      Resource: input.stateMachineArns },
    { Sid: "ReadExactDcfExecutions", Effect: "Allow", Action: ["states:DescribeExecution"],
      Resource: input.stateMachineArns.map(dcfExecutionArnForStateMachine) },
  ] });
  if (Buffer.byteLength(policy, "utf8") > 2_048) {
    throw new Error("DCF_STEP_FUNCTIONS_SESSION_POLICY_TOO_LARGE");
  }
  return policy;
}
