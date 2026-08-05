/** Immutable `.8.10` permission contract for ADV-12. */
import { DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION } from "./types.js";
import { DCF_PROVIDER_ACTIONS } from "./dcf-step-functions-provider-adapter.js";

export const DCF_STEP_FUNCTIONS_PERMISSION_POLICY_NAME =
  "SutraFinopsDcfStepFunctionsReadV1" as const;
export const DCF_STEP_FUNCTIONS_PERMISSION_ACTIONS = DCF_PROVIDER_ACTIONS;
const MACHINE = /^arn:(aws|aws-us-gov|aws-cn):states:([a-z0-9-]+):(\d{12}):stateMachine:([A-Za-z0-9._+-]{1,80})$/u;

export function dcfExecutionArnForStateMachine(stateMachineArn: string): string {
  const match = MACHINE.exec(stateMachineArn);
  if (match === null) throw new Error("DCF_STEP_FUNCTIONS_RESOURCE_INVALID");
  return `arn:${match[1]}:states:${match[2]}:${match[3]}:execution:${match[4]}:*`;
}

export function exactDcfPermissionResources(stateMachineArns: readonly string[]): readonly string[] {
  if (stateMachineArns.length < 1 || stateMachineArns.length > 10
    || new Set(stateMachineArns).size !== stateMachineArns.length
    || JSON.stringify(stateMachineArns) !== JSON.stringify([...stateMachineArns].sort())) {
    throw new Error("DCF_STEP_FUNCTIONS_RESOURCE_INVALID");
  }
  return Object.freeze([
    ...stateMachineArns,
    ...stateMachineArns.map(dcfExecutionArnForStateMachine),
  ]);
}

export const DCF_STEP_FUNCTIONS_PERMISSION_CONTRACT = Object.freeze({
  permissionPackVersion: DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION,
  policyName: DCF_STEP_FUNCTIONS_PERMISSION_POLICY_NAME,
  actions: DCF_STEP_FUNCTIONS_PERMISSION_ACTIONS,
  mutableActions: Object.freeze([] as const),
  maximumStateMachines: 10,
});
