export const ALL_ENABLED_AWS_REGIONS = "all-enabled" as const;

export type LocalAwsPartition = "aws" | "aws-us-gov" | "aws-cn";
export type AwsRegionSelection = readonly string[];

export function isAllEnabledAwsRegionSelection(
  selection: readonly string[],
): boolean {
  return selection.length === 1 && selection[0] === ALL_ENABLED_AWS_REGIONS;
}

export function isAwsRegionForPartition(
  region: string,
  partition: LocalAwsPartition,
): boolean {
  if (partition === "aws-us-gov") {
    return /^us-gov-(?:east|west)-[1-9]\d?$/u.test(region);
  }
  if (partition === "aws-cn") {
    return /^cn-(?:north|northwest)-[1-9]\d?$/u.test(region);
  }
  return /^[a-z]{2}-[a-z0-9-]+-[1-9]\d?$/u.test(region) &&
    !region.startsWith("cn-") &&
    !region.startsWith("us-gov-");
}

/** Strict registration/persistence boundary for selection intent. */
export function isValidAwsRegionSelection(
  value: unknown,
  partition: LocalAwsPartition,
): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  if (isAllEnabledAwsRegionSelection(value)) return true;
  if (value.includes(ALL_ENABLED_AWS_REGIONS)) return false;
  return value.every((region) =>
    typeof region === "string" && isAwsRegionForPartition(region, partition)
  ) && new Set(value).size === value.length;
}
