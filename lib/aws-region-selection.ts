/**
 * Durable marker for onboarding every Region that the customer account has
 * enabled. It is a selection instruction, never an AWS Region name and must
 * never appear in collector coverage or normalized inventory.
 */
export const ALL_ENABLED_AWS_REGIONS = "all-enabled" as const;

export type AwsRegionSelectionMode = typeof ALL_ENABLED_AWS_REGIONS | "explicit";
export type AwsRegionSelection = readonly string[];

export function isAllEnabledAwsRegionSelection(
  selection: readonly string[],
): boolean {
  return selection.length === 1 && selection[0] === ALL_ENABLED_AWS_REGIONS;
}

export function awsRegionSelectionMode(
  selection: readonly string[],
): AwsRegionSelectionMode {
  return isAllEnabledAwsRegionSelection(selection)
    ? ALL_ENABLED_AWS_REGIONS
    : "explicit";
}
