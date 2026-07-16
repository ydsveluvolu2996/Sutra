import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson as appCanonicalJson } from "../lib/canonical-json.ts";
import { canonicalJson as collectorCanonicalJson } from "../services/aws-collector/src/canonical-json.ts";

describe("canonical evidence JSON", () => {
  it("keeps app and collector digests stable across persisted key order", () => {
    const observed = {
      z: 1,
      nested: { beta: true, alpha: [{ right: "r", left: "l" }] },
      a: "first",
    };
    const persisted = {
      a: "first",
      nested: { alpha: [{ left: "l", right: "r" }], beta: true },
      z: 1,
    };
    assert.equal(appCanonicalJson(observed), appCanonicalJson(persisted));
    assert.equal(appCanonicalJson(observed), collectorCanonicalJson(observed));
    assert.equal(appCanonicalJson(persisted), collectorCanonicalJson(persisted));
  });

  it("rejects unsafe or non-JSON values", () => {
    assert.throws(() => appCanonicalJson({ value: undefined }), /safe JSON/u);
    assert.throws(() => collectorCanonicalJson(new Date()), /plain JSON/u);
    assert.throws(() => appCanonicalJson(JSON.parse('{"__proto__":{"polluted":true}}')), /unsafe JSON key/u);
  });
});
