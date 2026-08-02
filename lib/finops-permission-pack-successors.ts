/** Explicit immutable successor chains for app-side FinOps runtime eligibility. */
export const EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS = Object.freeze([
  "standard-2026-08.6",
  "standard-2026-08.7",
  "standard-2026-08.8",
  "standard-2026-08.9",
  "standard-2026-08.10",
] as const);

export const AWS_SUPPORT_CASES_RUNTIME_PERMISSION_PACKS = Object.freeze(
  EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS.slice(1),
);
export const AWS_HEALTH_RUNTIME_PERMISSION_PACKS = Object.freeze(
  EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS.slice(2),
);
export const RESILIENCE_VUE_RUNTIME_PERMISSION_PACKS = Object.freeze(
  EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS.slice(3),
);

function accepts(allowed: readonly string[], value: string): boolean {
  return allowed.includes(value);
}

export function isExtendedSupportRuntimePermissionPack(value: string): boolean {
  return accepts(EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS, value);
}
export function isAwsSupportCasesRuntimePermissionPack(value: string): boolean {
  return accepts(AWS_SUPPORT_CASES_RUNTIME_PERMISSION_PACKS, value);
}
export function isAwsHealthRuntimePermissionPack(value: string): boolean {
  return accepts(AWS_HEALTH_RUNTIME_PERMISSION_PACKS, value);
}
export function isResilienceVueRuntimePermissionPack(value: string): boolean {
  return accepts(RESILIENCE_VUE_RUNTIME_PERMISSION_PACKS, value);
}

function sqlList(values: readonly string[]): string {
  if (values.some((value) => !/^standard-2026-08\.\d{1,2}$/u.test(value))) {
    throw new Error("FINOPS_PERMISSION_PACK_CATALOG_INVALID");
  }
  return values.map((value) => `'${value}'`).join(",");
}

export const EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACK_SQL =
  sqlList(EXTENDED_SUPPORT_RUNTIME_PERMISSION_PACKS);
export const AWS_SUPPORT_CASES_RUNTIME_PERMISSION_PACK_SQL =
  sqlList(AWS_SUPPORT_CASES_RUNTIME_PERMISSION_PACKS);
export const AWS_HEALTH_RUNTIME_PERMISSION_PACK_SQL =
  sqlList(AWS_HEALTH_RUNTIME_PERMISSION_PACKS);
export const RESILIENCE_VUE_RUNTIME_PERMISSION_PACK_SQL =
  sqlList(RESILIENCE_VUE_RUNTIME_PERMISSION_PACKS);
