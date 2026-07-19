import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inventoryRegistry } from "../lib/registry-inventory.ts";

const NOW = "2026-07-19T12:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("registry inventory policy", () => {
  it("inventories digests and flags latest, unpinned, and empty repositories", () => {
    const result = inventoryRegistry({
      fetchedAt: NOW,
      repositories: [
        { name: "demo/app", tags: [
          { tag: "v1", digest: DIGEST, mediaType: "application/vnd.oci.image.manifest.v1+json" },
          { tag: "latest", digest: DIGEST, mediaType: null },
          { tag: "edge", digest: null, mediaType: null },
        ] },
        { name: "empty", tags: [] },
      ],
    });
    assert.equal(result.coverage, "complete");
    assert.equal(result.digests.length, 2);
    assert.deepEqual(result.findings.map((finding) => finding.kind).sort(), [
      "latest-tag-in-use", "stale-repository", "unpinned-tag",
    ]);
  });

  it("returns unknown coverage for unreachable or partial registries", () => {
    for (const coverage of [
      { reachable: false, partial: false, reason: "connection-refused" },
      { reachable: true, partial: true, reason: "catalog-page-failed" },
    ]) {
      const result = inventoryRegistry({ fetchedAt: NOW, repositories: [], coverage });
      assert.equal(result.coverage, "unknown-coverage");
      assert.equal(result.findings.length, 0);
      assert.match(result.disclaimer, /must not be interpreted as a clean registry/u);
    }
  });
});
