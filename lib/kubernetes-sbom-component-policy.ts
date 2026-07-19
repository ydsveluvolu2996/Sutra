// SBOM component policy: a governance gate over the observed component
// inventory. It flags components that match a banned list (by name, optionally
// narrowed by package URL and/or version) and, when required, components that
// lack a package URL (unidentifiable provenance). Pure and fail-closed: a
// component that matches a ban is a violation; a clean inventory passes; there
// is no clock and no inference beyond the reported SBOM metadata. Report-level
// freshness (max age) is intentionally out of scope here because Trivy SBOM
// components carry no per-package timestamp — that check belongs at the report
// layer, not this component engine.

const POLICY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{1,126}[A-Za-z0-9]$/u;
const COMPONENT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.@/_:+-]{0,254}$/u;

export const MAX_BANNED_COMPONENTS = 500;

export interface BannedComponent {
  readonly name: string;
  readonly packageUrl: string | null;
  readonly version: string | null;
}

export interface SbomComponentPolicy {
  readonly name: string;
  readonly bannedComponents: readonly BannedComponent[];
  readonly requirePackageUrl: boolean;
}

export interface SbomComponentPolicyEvaluation {
  readonly status: "pass" | "fail" | "not_evaluated";
  readonly componentsEvaluated: number;
  readonly compliantComponents: number;
  readonly violations: readonly {
    readonly componentFingerprint: string;
    readonly componentName: string;
    readonly componentVersion: string | null;
    readonly packageUrl: string | null;
    readonly reason: "BANNED_COMPONENT" | "MISSING_PACKAGE_URL";
    readonly matchedRule: string | null;
  }[];
  readonly truncated: boolean;
  readonly claimBoundary: "OBSERVED_SBOM_COMPONENT_METADATA_ONLY";
}

export class SbomComponentPolicyError extends Error {
  public readonly code = "INVALID_COMPONENT_POLICY";

  public constructor() {
    super("SBOM component policy was rejected");
    this.name = "SbomComponentPolicyError";
  }
}

function invalid(): never {
  throw new SbomComponentPolicyError();
}

function token(value: unknown, { optional = false } = {}): string | null {
  if (value === undefined || value === null) {
    if (optional) return null;
    invalid();
  }
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 255 || !COMPONENT_TOKEN.test(normalized)) invalid();
  return normalized;
}

function bannedComponent(value: unknown): BannedComponent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["name", "packageUrl", "version"].includes(key)) || !("name" in record)) invalid();
  return {
    name: token(record.name) as string,
    packageUrl: token(record.packageUrl, { optional: true }),
    version: token(record.version, { optional: true }),
  };
}

export function normalizeSbomComponentPolicy(value: unknown): SbomComponentPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const keys = ["name", "bannedComponents", "requirePackageUrl"];
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record.name !== "string" ||
    !POLICY_NAME.test(record.name) ||
    typeof record.requirePackageUrl !== "boolean" ||
    !Array.isArray(record.bannedComponents) ||
    record.bannedComponents.length > MAX_BANNED_COMPONENTS
  ) invalid();
  return {
    name: record.name,
    bannedComponents: record.bannedComponents.map(bannedComponent),
    requirePackageUrl: record.requirePackageUrl,
  };
}

function ruleLabel(rule: BannedComponent): string {
  return [rule.name, rule.version, rule.packageUrl].filter((part) => part !== null).join("@");
}

// A banned rule matches when the name matches (case-insensitive) and every
// specified narrower (packageUrl, version) also matches. A rule with only a
// name bans every version of that component.
function matches(rule: BannedComponent, component: { name: string; version: string | null; packageUrl: string | null }): boolean {
  if (rule.name.toLocaleLowerCase("en-US") !== component.name.toLocaleLowerCase("en-US")) return false;
  if (rule.version !== null && rule.version !== component.version) return false;
  if (rule.packageUrl !== null && rule.packageUrl !== component.packageUrl) return false;
  return true;
}

export function evaluateSbomComponentPolicy(
  policy: SbomComponentPolicy,
  components: readonly {
    readonly fingerprint: string;
    readonly name: string;
    readonly version: string | null;
    readonly packageUrl: string | null;
  }[],
  limit = 2_000,
): SbomComponentPolicyEvaluation {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) invalid();
  const bounded = components.slice(0, limit);
  const violations: SbomComponentPolicyEvaluation["violations"][number][] = [];
  let compliantComponents = 0;
  for (const component of bounded) {
    const banned = policy.bannedComponents.find((rule) => matches(rule, component));
    if (banned !== undefined) {
      violations.push({
        componentFingerprint: component.fingerprint,
        componentName: component.name,
        componentVersion: component.version,
        packageUrl: component.packageUrl,
        reason: "BANNED_COMPONENT",
        matchedRule: ruleLabel(banned),
      });
      continue;
    }
    if (policy.requirePackageUrl && (component.packageUrl === null || component.packageUrl.trim().length === 0)) {
      violations.push({
        componentFingerprint: component.fingerprint,
        componentName: component.name,
        componentVersion: component.version,
        packageUrl: component.packageUrl,
        reason: "MISSING_PACKAGE_URL",
        matchedRule: null,
      });
      continue;
    }
    compliantComponents += 1;
  }
  return {
    status: violations.length === 0 && components.length <= limit ? "pass" : "fail",
    componentsEvaluated: bounded.length,
    compliantComponents,
    violations,
    truncated: components.length > limit,
    claimBoundary: "OBSERVED_SBOM_COMPONENT_METADATA_ONLY",
  };
}
