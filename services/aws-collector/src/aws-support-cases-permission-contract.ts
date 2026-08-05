/** Immutable least-privilege permission contract for ADV-09. */
export { AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION } from "./types.js";
import { AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION } from "./types.js";
export const AWS_SUPPORT_CASES_PERMISSION_POLICY_NAME =
  "SutraFinopsSupportCasesReadV1" as const;
export const AWS_SUPPORT_CASES_PERMISSION_SOURCE_ID =
  "aws_support_cases_organization" as const;
export const AWS_SUPPORT_CASES_PERMISSION_ACTIONS = Object.freeze([
  "support:DescribeCases",
  "support:DescribeCommunications",
] as const);

export interface AwsSupportCasesPermissionContract {
  readonly permissionPackVersion: typeof AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION;
  readonly policyName: typeof AWS_SUPPORT_CASES_PERMISSION_POLICY_NAME;
  readonly sourceId: typeof AWS_SUPPORT_CASES_PERMISSION_SOURCE_ID;
  readonly effect: "Allow";
  readonly actions: typeof AWS_SUPPORT_CASES_PERMISSION_ACTIONS;
  readonly resources: readonly ["*"];
  readonly mutableActions: readonly [];
}

export const AWS_SUPPORT_CASES_PERMISSION_CONTRACT: AwsSupportCasesPermissionContract =
  Object.freeze({
    permissionPackVersion: AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION,
    policyName: AWS_SUPPORT_CASES_PERMISSION_POLICY_NAME,
    sourceId: AWS_SUPPORT_CASES_PERMISSION_SOURCE_ID,
    effect: "Allow",
    actions: AWS_SUPPORT_CASES_PERMISSION_ACTIONS,
    resources: Object.freeze(["*"] as const),
    mutableActions: Object.freeze([] as const),
  });

/** Fail closed if an attested policy adds, removes, duplicates, or reorders an action. */
export function assertAwsSupportCasesPermissionContract(input: {
  readonly permissionPackVersion: string;
  readonly policyName: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}): void {
  if (input.permissionPackVersion !== AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION
    || input.policyName !== AWS_SUPPORT_CASES_PERMISSION_POLICY_NAME
    || JSON.stringify(input.actions) !== JSON.stringify(AWS_SUPPORT_CASES_PERMISSION_ACTIONS)
    || JSON.stringify(input.resources) !== JSON.stringify(["*"])) {
    throw new Error("AWS_SUPPORT_CASES_PERMISSION_CONTRACT_REJECTED");
  }
}
