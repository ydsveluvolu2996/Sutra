export interface RegistryTagObservation {
  readonly tag: string;
  readonly digest: string | null;
  readonly mediaType: string | null;
}

export interface RegistryRepositoryObservation {
  readonly name: string;
  readonly tags: readonly RegistryTagObservation[];
}

export interface RegistryInventoryInput {
  readonly repositories: readonly RegistryRepositoryObservation[];
  readonly fetchedAt: string;
  readonly coverage?: {
    readonly reachable: boolean;
    readonly partial: boolean;
    readonly reason?: string;
  };
}

export type RegistryFindingKind = "latest-tag-in-use" | "unpinned-tag" | "stale-repository";

export interface RegistryPolicyFinding {
  readonly kind: RegistryFindingKind;
  readonly repository: string;
  readonly tag: string | null;
  readonly severity: "medium" | "low";
  readonly evidence: string;
}

export interface RegistryDigestInventory {
  readonly repository: string;
  readonly tag: string;
  readonly digest: string;
  readonly mediaType: string | null;
}

export type RegistryInventoryResult =
  | {
    readonly coverage: "unknown-coverage";
    readonly fetchedAt: string;
    readonly reason: string;
    readonly repositoriesObserved: number;
    readonly findings: readonly [];
    readonly digests: readonly [];
    readonly disclaimer: string;
  }
  | {
    readonly coverage: "complete";
    readonly fetchedAt: string;
    readonly repositoriesObserved: number;
    readonly findings: readonly RegistryPolicyFinding[];
    readonly digests: readonly RegistryDigestInventory[];
    readonly disclaimer: string;
  };

const REPOSITORY = /^[a-z0-9]+(?:(?:[._-]|\/)[a-z0-9]+)*$/u;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function inventoryRegistry(input: RegistryInventoryInput): RegistryInventoryResult {
  const fetchedAtMs = Date.parse(input.fetchedAt);
  if (!Number.isFinite(fetchedAtMs) || new Date(fetchedAtMs).toISOString() !== input.fetchedAt) {
    throw Object.assign(new Error("The registry observation timestamp is invalid"), { code: "INVALID_INPUT" });
  }
  const coverage = input.coverage ?? { reachable: true, partial: false };
  if (!coverage.reachable || coverage.partial) {
    return {
      coverage: "unknown-coverage",
      fetchedAt: input.fetchedAt,
      reason: coverage.reason?.trim() || (!coverage.reachable ? "registry-unreachable" : "registry-response-partial"),
      repositoriesObserved: input.repositories.length,
      findings: [],
      digests: [],
      disclaimer: "Registry coverage is unknown; absence of findings must not be interpreted as a clean registry.",
    };
  }
  const findings: RegistryPolicyFinding[] = [];
  const digests: RegistryDigestInventory[] = [];
  for (const repository of input.repositories) {
    if (!REPOSITORY.test(repository.name)) {
      throw Object.assign(new Error("The registry repository name is invalid"), { code: "INVALID_INPUT" });
    }
    if (repository.tags.length === 0) {
      findings.push({
        kind: "stale-repository", repository: repository.name, tag: null, severity: "low",
        evidence: "The repository returned no tags at collection time.",
      });
      continue;
    }
    for (const observation of repository.tags) {
      if (!TAG.test(observation.tag)) {
        throw Object.assign(new Error("The registry tag is invalid"), { code: "INVALID_INPUT" });
      }
      if (observation.tag === "latest") {
        findings.push({
          kind: "latest-tag-in-use", repository: repository.name, tag: observation.tag, severity: "medium",
          evidence: "The mutable 'latest' tag exists; deployment references should use an immutable digest.",
        });
      }
      if (observation.digest === null || !DIGEST.test(observation.digest)) {
        findings.push({
          kind: "unpinned-tag", repository: repository.name, tag: observation.tag, severity: "medium",
          evidence: "No valid manifest digest was captured for this tag.",
        });
      } else {
        digests.push({
          repository: repository.name, tag: observation.tag,
          digest: observation.digest, mediaType: observation.mediaType,
        });
      }
    }
  }
  return {
    coverage: "complete",
    fetchedAt: input.fetchedAt,
    repositoriesObserved: input.repositories.length,
    findings,
    digests,
    disclaimer: "This validates registry inventory and tag/digest policy only. Image CVE scanning remains gated on a verified Trivy runtime.",
  };
}
