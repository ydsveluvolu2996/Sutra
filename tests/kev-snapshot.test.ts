import assert from "node:assert/strict";
import test from "node:test";

import { KEV_AS_OF, KEV_COUNT, isKnownExploited, kevEntry, sampleKevId } from "../lib/kev-snapshot.ts";

test("the bundled KEV snapshot loads and flags known-exploited CVEs case-insensitively", () => {
  assert.ok(KEV_COUNT > 500, "the CISA KEV catalog carries hundreds of entries");
  assert.equal(typeof KEV_AS_OF, "string");
  const sample = sampleKevId();
  assert.ok(sample, "the snapshot exposes a sample CVE id");
  assert.equal(isKnownExploited(sample), true);
  assert.equal(isKnownExploited(sample.toLowerCase()), true);
  assert.ok(kevEntry(sample), "a known-exploited CVE resolves to its KEV entry");
});

test("unknown or missing CVEs are not flagged, never guessed", () => {
  assert.equal(isKnownExploited(null), false);
  assert.equal(isKnownExploited(undefined), false);
  assert.equal(isKnownExploited("CVE-0000-00000"), false);
  assert.equal(kevEntry("CVE-0000-00000"), null);
});
