/** Immutable least-privilege permission successor for ADV-06 AWS Health. */
export { AWS_HEALTH_PERMISSION_PACK_VERSION } from "./types.js";
import { AWS_HEALTH_PERMISSION_PACK_VERSION } from "./types.js";
export const AWS_HEALTH_PERMISSION_POLICY_NAME = "SutraFinopsHealthOrganizationReadV1" as const;
export const AWS_HEALTH_PERMISSION_SOURCE_ID = "aws_health_organization" as const;
export const AWS_HEALTH_PERMISSION_ACTIONS = Object.freeze([
  "health:DescribeAffectedAccountsForOrganization",
  "health:DescribeAffectedEntitiesForOrganization",
  "health:DescribeEventDetailsForOrganization",
  "health:DescribeEventsForOrganization",
  "health:DescribeHealthServiceStatusForOrganization",
  "organizations:DescribeOrganization",
  "organizations:ListDelegatedAdministrators",
] as const);
export const AWS_HEALTH_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  ...AWS_HEALTH_PERMISSION_ACTIONS,
] as const);
export const AWS_HEALTH_PERMISSION_CONTRACT = Object.freeze({
  permissionPackVersion: AWS_HEALTH_PERMISSION_PACK_VERSION,
  policyName: AWS_HEALTH_PERMISSION_POLICY_NAME,
  sourceId: AWS_HEALTH_PERMISSION_SOURCE_ID,
  effect: "Allow" as const,
  actions: AWS_HEALTH_PERMISSION_ACTIONS,
  resources: Object.freeze(["*"] as const),
  mutableActions: Object.freeze([] as const),
});
export function assertAwsHealthPermissionContract(input: {
  readonly permissionPackVersion: string;
  readonly policyName: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}): void {
  if (input.permissionPackVersion !== AWS_HEALTH_PERMISSION_PACK_VERSION
    || input.policyName !== AWS_HEALTH_PERMISSION_POLICY_NAME
    || JSON.stringify(input.actions) !== JSON.stringify(AWS_HEALTH_PERMISSION_ACTIONS)
    || JSON.stringify(input.resources) !== JSON.stringify(["*"])) {
    throw new Error("AWS_HEALTH_PERMISSION_CONTRACT_REJECTED");
  }
}
