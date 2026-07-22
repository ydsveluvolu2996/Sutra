import { CUSTOMER_ROLE_METADATA_ACTIONS } from "./aws-customer-role-artifacts.ts";

const DECLARED_CAPABILITY_ACTIONS = new Set<string>(CUSTOMER_ROLE_METADATA_ACTIONS);

/**
 * The collector reports a partition of the reviewed inline-policy actions:
 * every declared action must appear exactly once in either granted or missing.
 * This is policy-declaration evidence, not an IAM authorization simulation.
 */
export function isExactDeclaredAwsCapabilityPartition(
  grantedActions: readonly string[],
  missingActions: readonly string[],
): boolean {
  const combined = [...grantedActions, ...missingActions];
  return combined.length === DECLARED_CAPABILITY_ACTIONS.size &&
    new Set(combined).size === combined.length &&
    combined.every((action) => DECLARED_CAPABILITY_ACTIONS.has(action));
}
