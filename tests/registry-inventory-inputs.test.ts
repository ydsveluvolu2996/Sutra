import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesSupplyChainEvidence } from "../lib/kubernetes-supply-chain.ts";
import {
  buildRegistryInventoryInput,
  evidenceToObservedImage,
  type ObservedContainerImage,
} from "../lib/registry-inventory-inputs.ts";
import { inventoryRegistry } from "../lib/registry-inventory.ts";

const NOW = "2026-07-19T12:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function image(over: Partial<ObservedContainerImage> = {}): ObservedContainerImage {
  return { repository: "acme/app", tag: "v1", digest: DIGEST, collectedAt: NOW, ...over };
}

describe("registry inventory adapter", () => {
  it("projects observed images into repositories and drives the engine's policy findings", () => {
    const input = buildRegistryInventoryInput(
      [
        image({ repository: "acme/app", tag: "v1", digest: DIGEST }),
        image({ repository: "acme/app", tag: "latest", digest: DIGEST }),
      ],
      { sourceCollected: true, fetchedAt: NOW },
    );
    assert.deepEqual(input.coverage, { reachable: true, partial: false, reason: "some-observed-images-unrepresentable" });
    const result = inventoryRegistry(input);
    assert.equal(result.coverage, "complete");
    assert.equal(result.digests.length, 2);
    assert.ok(result.findings.some((finding) => finding.kind === "latest-tag-in-use" && finding.repository === "acme/app"));
  });

  it("collapses duplicate tag observations across workloads without double-counting", () => {
    const input = buildRegistryInventoryInput(
      [image({ tag: "v1" }), image({ tag: "v1" }), image({ tag: "v1" })],
      { sourceCollected: true, fetchedAt: NOW },
    );
    assert.equal(input.repositories.length, 1);
    assert.equal(input.repositories[0]?.tags.length, 1);
  });

  it("emits digest:null (a real unpinned-tag finding) rather than fabricating a digest", () => {
    const input = buildRegistryInventoryInput(
      [image({ tag: "edge", digest: "not-a-digest" })],
      { sourceCollected: true, fetchedAt: NOW },
    );
    assert.equal(input.repositories[0]?.tags[0]?.digest, null);
    const result = inventoryRegistry(input);
    assert.equal(result.coverage, "complete");
    assert.ok(result.findings.some((finding) => finding.kind === "unpinned-tag"));
  });

  it("reports unknown-coverage when the image-evidence source was never collected", () => {
    const input = buildRegistryInventoryInput([], { sourceCollected: false, fetchedAt: NOW });
    assert.deepEqual(input.coverage, { reachable: false, partial: false, reason: "kubernetes-image-evidence-unavailable" });
    const result = inventoryRegistry(input);
    assert.equal(result.coverage, "unknown-coverage");
    assert.equal(result.findings.length, 0);
    assert.match(result.disclaimer, /must not be interpreted as a clean registry/u);
  });

  it("reports unknown-coverage (no observations) when a collected source yielded no images", () => {
    const input = buildRegistryInventoryInput([], { sourceCollected: true, fetchedAt: NOW });
    assert.deepEqual(input.coverage, { reachable: false, partial: false, reason: "no-image-observations-collected" });
    assert.equal(inventoryRegistry(input).coverage, "unknown-coverage");
  });

  it("surfaces partial (unknown) coverage when some observed images cannot be represented", () => {
    const input = buildRegistryInventoryInput(
      [image({ repository: "acme/app", tag: "v1" }), image({ repository: "acme/app", tag: null })],
      { sourceCollected: true, fetchedAt: NOW },
    );
    assert.deepEqual(input.coverage, { reachable: true, partial: true, reason: "some-observed-images-unrepresentable" });
    assert.equal(inventoryRegistry(input).coverage, "unknown-coverage");
  });

  it("faithfully maps a stored supply-chain evidence record to an observed image", () => {
    const evidence = {
      collectedAt: NOW,
      image: { repository: "acme/app", digest: DIGEST, tag: "v1" },
    } as KubernetesSupplyChainEvidence;
    assert.deepEqual(evidenceToObservedImage(evidence), {
      repository: "acme/app",
      tag: "v1",
      digest: DIGEST,
      collectedAt: NOW,
    });
  });
});
