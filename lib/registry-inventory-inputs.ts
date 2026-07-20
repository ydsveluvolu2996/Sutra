// Adapter: already-collected Kubernetes container-image references (the
// supply-chain evidence carried by KubernetesSupplyChainRepository) ->
// RegistryInventoryInput for the inventoryRegistry engine. Pure and
// deterministic; it only reshapes evidence Sutra has already collected and
// never invents a tag or a digest.
//
// SOURCE CHOICE — why observed Kubernetes images, not ECR repositories:
//   * ECR repositories DO appear as `aws.ecr.repository` CMDB resources, but the
//     inventory collector's DescribeRepositories call returns repository
//     metadata only (name, URI, tag-mutability) — it never enumerates the image
//     tag/digest catalog. Feeding those repos to the engine would mean either
//     fabricating a catalog or emitting false "stale-repository" findings for
//     repos we simply never read the manifests of. Neither is honest.
//   * Kubernetes supply-chain evidence is the real source that already carries a
//     repository together with an observed image tag AND a verified sha256
//     digest, which is exactly what the tag/digest policy engine reasons over.
//
// HONESTY (mirrors the engine's own coverage contract):
//   * When no image references were collected (no clusters, or no evidence), the
//     input is marked NOT reachable so the engine returns "unknown-coverage" —
//     the absence of observations is never reported as a clean registry.
//   * Observed images this app cannot faithfully represent as a tag/digest
//     policy observation (a digest-only deployment with no tag, or a
//     repository/tag that falls outside the engine's grammar) are counted and
//     surfaced as PARTIAL coverage (also "unknown-coverage") rather than being
//     silently dropped from an otherwise "complete" report.
//   * A digest is emitted only when the evidence carried a valid sha256 digest;
//     nothing is ever fabricated.
// This adapter does inventory + tag/digest policy only. Image CVE scanning stays
// on the separate, Trivy-gated track and is out of scope here.
import type { KubernetesSupplyChainEvidence } from "./kubernetes-supply-chain.ts";
import type {
  RegistryInventoryInput,
  RegistryRepositoryObservation,
  RegistryTagObservation,
} from "./registry-inventory.ts";

// These mirror the inventoryRegistry engine's own grammar exactly. The engine
// re-validates and throws on any non-conforming name/tag, so pre-filtering with
// the identical patterns keeps unrepresentable observations out of the
// "complete" path and accounts for them as partial coverage instead.
const REPOSITORY = /^[a-z0-9]+(?:(?:[._-]|\/)[a-z0-9]+)*$/u;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface ObservedContainerImage {
  readonly repository: string;
  readonly tag: string | null;
  readonly digest: string;
  readonly collectedAt: string;
}

// One stored supply-chain evidence record is one observed image reference. The
// evidence's own normalizer already guarantees a repository and a valid sha256
// digest; the tag is optional (a digest-only deployment leaves it null).
export function evidenceToObservedImage(evidence: KubernetesSupplyChainEvidence): ObservedContainerImage {
  return {
    repository: evidence.image.repository,
    tag: evidence.image.tag,
    digest: evidence.image.digest,
    collectedAt: evidence.collectedAt,
  };
}

export interface BuildRegistryInventoryOptions {
  // Whether the Kubernetes image-evidence source was actually available for this
  // connection (i.e. at least one active cluster was scanned). When false the
  // engine reports unknown-coverage instead of an empty "clean" registry.
  readonly sourceCollected: boolean;
  // Deterministic clock supplied by the caller; the adapter reads no clock.
  readonly fetchedAt: string;
}

export function buildRegistryInventoryInput(
  images: readonly ObservedContainerImage[],
  options: BuildRegistryInventoryOptions,
): RegistryInventoryInput {
  const tagsByRepository = new Map<string, RegistryTagObservation[]>();
  const seenPerRepository = new Map<string, Set<string>>();
  let unrepresentable = 0;

  for (const image of images) {
    const representable =
      image.tag !== null && REPOSITORY.test(image.repository) && TAG.test(image.tag);
    if (!representable) {
      unrepresentable += 1;
      continue;
    }
    const seen = seenPerRepository.get(image.repository) ?? new Set<string>();
    // A repository can be deployed at the same tag across many workloads; collapse
    // duplicate tag observations so the inventory is not double-counted.
    if (seen.has(image.tag)) continue;
    seen.add(image.tag);
    seenPerRepository.set(image.repository, seen);
    const tags = tagsByRepository.get(image.repository) ?? [];
    tags.push({
      tag: image.tag,
      digest: DIGEST.test(image.digest) ? image.digest : null,
      mediaType: null,
    });
    tagsByRepository.set(image.repository, tags);
  }

  const repositories: RegistryRepositoryObservation[] = [...tagsByRepository.entries()]
    .map(([name, tags]) => ({
      name,
      tags: tags.slice().sort((a, b) => a.tag.localeCompare(b.tag, "en-US")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en-US"));

  const reachable = options.sourceCollected && repositories.length > 0;
  const partial = reachable && unrepresentable > 0;
  const reason = !options.sourceCollected
    ? "kubernetes-image-evidence-unavailable"
    : repositories.length === 0
      ? (unrepresentable > 0 ? "observed-images-unrepresentable" : "no-image-observations-collected")
      : "some-observed-images-unrepresentable";

  return {
    repositories,
    fetchedAt: options.fetchedAt,
    coverage: { reachable, partial, reason },
  };
}
