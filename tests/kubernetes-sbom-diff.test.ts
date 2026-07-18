import assert from "node:assert/strict";
import test from "node:test";
import { buildSbomComponentDiff, type SbomDiffComponent } from "../lib/kubernetes-sbom-diff.ts";

function component(over: Partial<SbomDiffComponent> & { name: string }): SbomDiffComponent {
  return { version: null, packageUrl: null, type: "library", ...over };
}

test("no previous scan reports nothing (never invents drift)", () => {
  const report = buildSbomComponentDiff({
    current: [component({ name: "openssl", version: "3.0.1", packageUrl: "pkg:apk/openssl@3.0.1" })],
    previous: null,
  });
  assert.equal(report.hasPrevious, false);
  assert.deepEqual(report.changes, []);
  assert.equal(report.summary.added, 0);
});

test("classifies added, removed, and version-changed components", () => {
  const report = buildSbomComponentDiff({
    current: [
      component({ name: "openssl", version: "3.0.2", packageUrl: "pkg:apk/openssl" }),
      component({ name: "left-pad", version: "1.3.0", packageUrl: "pkg:npm/left-pad" }),
    ],
    previous: [
      component({ name: "openssl", version: "3.0.1", packageUrl: "pkg:apk/openssl" }),
      component({ name: "lodash", version: "4.17.21", packageUrl: "pkg:npm/lodash" }),
    ],
  });
  assert.equal(report.hasPrevious, true);
  const versionChanged = report.changes.find((c) => c.kind === "version-changed");
  assert.equal(versionChanged?.name, "openssl");
  assert.equal(versionChanged?.from, "3.0.1");
  assert.equal(versionChanged?.to, "3.0.2");
  assert.ok(report.changes.some((c) => c.kind === "added" && c.name === "left-pad"));
  assert.ok(report.changes.some((c) => c.kind === "removed" && c.name === "lodash"));
  assert.equal(report.summary.added, 1);
  assert.equal(report.summary.removed, 1);
  assert.equal(report.summary.versionChanged, 1);
});

test("keys by package URL and falls back to type|name; unchanged components are counted not listed", () => {
  const report = buildSbomComponentDiff({
    current: [
      component({ name: "same", version: "1.0.0", packageUrl: "pkg:npm/same@1.0.0" }),
      component({ name: "nopurl", version: "2.0.0", packageUrl: null, type: "application" }),
    ],
    previous: [
      component({ name: "same", version: "1.0.0", packageUrl: "pkg:npm/same@1.0.0" }),
      component({ name: "nopurl", version: "2.0.0", packageUrl: null, type: "application" }),
    ],
  });
  assert.deepEqual(report.changes, []);
  assert.equal(report.summary.unchanged, 2);
});

test("detects a license change on an otherwise-identical component", () => {
  const report = buildSbomComponentDiff({
    current: [component({ name: "pkg", version: "1.0", packageUrl: "pkg:npm/pkg@1.0", licenses: ["GPL-3.0"] })],
    previous: [component({ name: "pkg", version: "1.0", packageUrl: "pkg:npm/pkg@1.0", licenses: ["MIT"] })],
  });
  const licenseChanged = report.changes.find((c) => c.kind === "license-changed");
  assert.equal(licenseChanged?.from, "MIT");
  assert.equal(licenseChanged?.to, "GPL-3.0");
  assert.equal(report.summary.licenseChanged, 1);
});

test("is deterministic regardless of input order", () => {
  const a = buildSbomComponentDiff({
    current: [component({ name: "b", packageUrl: "pkg:npm/b" }), component({ name: "a", packageUrl: "pkg:npm/a" })],
    previous: [],
  });
  const b = buildSbomComponentDiff({
    current: [component({ name: "a", packageUrl: "pkg:npm/a" }), component({ name: "b", packageUrl: "pkg:npm/b" })],
    previous: [],
  });
  assert.deepEqual(a.changes, b.changes);
});
