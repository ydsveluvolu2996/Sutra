export const MIN_RESOURCE_RETIREMENT_COMPLETE_MISSES = 2;
export const MAX_RESOURCE_RETIREMENT_COMPLETE_MISSES = 30;
export const DEFAULT_RESOURCE_RETIREMENT_COMPLETE_MISSES = 2;

/**
 * A resource may be retired only after this many consecutive, authoritative
 * complete runs omit it. Invalid operator configuration fails closed instead
 * of silently weakening the grace period.
 */
export function resolveResourceRetirementCompleteMisses(value: string | undefined): number {
  const configured = value?.trim();
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_RESOURCE_RETIREMENT_COMPLETE_MISSES;
  }
  if (!/^[0-9]+$/u.test(configured)) {
    throw new Error("SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES must be an integer");
  }
  const misses = Number(configured);
  if (
    !Number.isSafeInteger(misses) ||
    misses < MIN_RESOURCE_RETIREMENT_COMPLETE_MISSES ||
    misses > MAX_RESOURCE_RETIREMENT_COMPLETE_MISSES
  ) {
    throw new Error(
      `SUTRA_RESOURCE_RETIREMENT_COMPLETE_MISSES must be between ${MIN_RESOURCE_RETIREMENT_COMPLETE_MISSES} and ${MAX_RESOURCE_RETIREMENT_COMPLETE_MISSES}`,
    );
  }
  return misses;
}
