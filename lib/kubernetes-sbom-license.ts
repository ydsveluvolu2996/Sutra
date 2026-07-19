const LICENSE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.+():\- ]{0,126}[A-Za-z0-9)]$/u;
const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{1,126}[A-Za-z0-9]$/u;

export const MAX_SBOM_COMPONENT_LICENSES = 16;
export const MAX_LICENSE_POLICY_IDENTIFIERS = 200;

export interface SbomComponentLicenseEvidence {
  readonly id: string;
}

export interface SbomLicensePolicy {
  readonly name: string;
  readonly deniedLicenses: readonly string[];
  readonly allowedLicenses: readonly string[];
  readonly requireIdentifiedLicense: boolean;
}

export interface SbomLicenseEvaluation {
  readonly status: "pass" | "fail" | "not_evaluated";
  readonly componentsEvaluated: number;
  readonly compliantComponents: number;
  readonly violations: readonly {
    readonly componentFingerprint: string;
    readonly componentName: string;
    readonly componentVersion: string | null;
    readonly reason: "DENIED_LICENSE" | "UNIDENTIFIED_LICENSE" | "NOT_IN_ALLOWLIST";
    readonly observedLicenses: readonly string[];
  }[];
  readonly truncated: boolean;
  readonly claimBoundary: "OBSERVED_SBOM_LICENSE_METADATA_ONLY";
}

export class SbomLicensePolicyError extends Error {
  public readonly code = "INVALID_LICENSE_POLICY";

  public constructor() {
    super("SBOM license policy was rejected");
    this.name = "SbomLicensePolicyError";
  }
}

function invalid(): never {
  throw new SbomLicensePolicyError();
}

function normalizedLicense(value: unknown): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (
    normalized.length < 2 ||
    normalized.length > 128 ||
    !LICENSE_TOKEN.test(normalized) ||
    /(?:\bAND\b|\bOR\b|\bWITH\b)/iu.test(normalized)
  ) invalid();
  return normalized;
}

export function normalizeObservedLicenses(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_SBOM_COMPONENT_LICENSES) invalid();
  return [...new Set(value.map((item) => {
    if (typeof item === "string") return normalizedLicense(item);
    if (typeof item !== "object" || item === null || Array.isArray(item)) invalid();
    const record = item as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !("id" in record)) invalid();
    return normalizedLicense(record.id);
  }))].sort((left, right) => left.localeCompare(right));
}

function licenseSet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LICENSE_POLICY_IDENTIFIERS) invalid();
  return [...new Set(value.map(normalizedLicense))].sort((left, right) => left.localeCompare(right));
}

export function normalizeSbomLicensePolicy(value: unknown): SbomLicensePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = ["name", "deniedLicenses", "allowedLicenses", "requireIdentifiedLicense"];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record.name !== "string" ||
    !POLICY_NAME.test(record.name) ||
    typeof record.requireIdentifiedLicense !== "boolean"
  ) invalid();
  const deniedLicenses = licenseSet(record.deniedLicenses);
  const allowedLicenses = licenseSet(record.allowedLicenses);
  const denied = new Set(deniedLicenses.map((item) => item.toLocaleLowerCase("en-US")));
  if (allowedLicenses.some((item) => denied.has(item.toLocaleLowerCase("en-US")))) invalid();
  return {
    name: record.name,
    deniedLicenses,
    allowedLicenses,
    requireIdentifiedLicense: record.requireIdentifiedLicense,
  };
}

export function evaluateSbomLicensePolicy(
  policy: SbomLicensePolicy,
  components: readonly {
    readonly fingerprint: string;
    readonly name: string;
    readonly version: string | null;
    readonly licenses: readonly string[];
  }[],
  limit = 2_000,
): SbomLicenseEvaluation {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalid();
  const denied = new Set(policy.deniedLicenses.map((item) => item.toLocaleLowerCase("en-US")));
  const allowed = new Set(policy.allowedLicenses.map((item) => item.toLocaleLowerCase("en-US")));
  const violations: SbomLicenseEvaluation["violations"][number][] = [];
  const bounded = components.slice(0, limit);
  let compliantComponents = 0;
  for (const component of bounded) {
    const observed = [...new Set(component.licenses)].sort((left, right) => left.localeCompare(right));
    const normalized = observed.map((item) => item.toLocaleLowerCase("en-US"));
    let reason: SbomLicenseEvaluation["violations"][number]["reason"] | null = null;
    if (normalized.some((item) => denied.has(item))) reason = "DENIED_LICENSE";
    else if (observed.length === 0 && policy.requireIdentifiedLicense) reason = "UNIDENTIFIED_LICENSE";
    else if (allowed.size > 0 && (observed.length === 0 || normalized.some((item) => !allowed.has(item)))) {
      reason = "NOT_IN_ALLOWLIST";
    }
    if (reason === null) {
      compliantComponents += 1;
      continue;
    }
    violations.push({
      componentFingerprint: component.fingerprint,
      componentName: component.name,
      componentVersion: component.version,
      reason,
      observedLicenses: observed,
    });
  }
  return {
    status: violations.length === 0 && components.length <= limit ? "pass" : "fail",
    componentsEvaluated: bounded.length,
    compliantComponents,
    violations,
    truncated: components.length > limit,
    claimBoundary: "OBSERVED_SBOM_LICENSE_METADATA_ONLY",
  };
}
