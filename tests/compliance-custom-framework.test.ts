import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCustomFrameworkReadiness,
  validateCustomFrameworkDefinition,
  type CustomFrameworkDefinition,
} from "../lib/compliance-custom-framework.ts";
import {
  buildFrameworkReadiness,
  getComplianceFramework,
  type CollectedControlResult,
} from "../lib/compliance-frameworks.ts";

const DEFINITION: CustomFrameworkDefinition = {
  name: "acme-msp-baseline",
  title: "Acme MSP baseline",
  claimBoundary: "Operator-defined mapping; readiness view only.",
  controls: [
    { controlId: "ACME-1", title: "Encrypt data at rest", sutraControlIds: ["SUTRA.AWS.EBS.1", "SUTRA.AWS.S3.2"] },
    { controlId: "ACME-2", title: "Restrict public entry points", sutraControlIds: ["SUTRA.AWS.SG.1"] },
    { controlId: "ACME-3", title: "Cluster admission control", sutraControlIds: ["K8S-ADMISSION-1"] },
  ],
};

describe("validateCustomFrameworkDefinition", () => {
  it("accepts a well-formed definition and defaults the claim boundary", () => {
    const { definition, errors } = validateCustomFrameworkDefinition({
      name: "acme",
      title: "Acme",
      controls: [{ controlId: "A-1", title: "One", sutraControlIds: ["SUTRA.AWS.EBS.1"] }],
    });
    assert.deepEqual(errors, []);
    assert.match(definition!.claimBoundary, /Operator-defined/);
  });

  it("reports malformed names, duplicate control ids, and empty mappings explicitly", () => {
    const { definition, errors } = validateCustomFrameworkDefinition({
      name: "Not Valid!",
      title: "",
      controls: [
        { controlId: "A-1", title: "One", sutraControlIds: [] },
        { controlId: "A-1", title: "Dup", sutraControlIds: ["SUTRA.AWS.EBS.1"] },
      ],
    });
    assert.equal(definition, null);
    assert.equal(errors.some((error) => error.includes("name must be")), true);
    assert.equal(errors.some((error) => error.includes("title must be")), true);
    assert.equal(errors.some((error) => error.includes("sutraControlIds must be a non-empty array")), true);
  });

  it("rejects oversized catalogs instead of truncating silently", () => {
    const { definition, errors } = validateCustomFrameworkDefinition({
      name: "big",
      title: "Big",
      controls: Array.from({ length: 201 }, (_, index) => ({
        controlId: `C-${index}`,
        title: "x",
        sutraControlIds: ["SUTRA.AWS.EBS.1"],
      })),
    });
    assert.equal(definition, null);
    assert.equal(errors.some((error) => error.includes("maximum of 200")), true);
  });
});

describe("buildCustomFrameworkReadiness", () => {
  const collected: readonly CollectedControlResult[] = [
    { controlId: "SUTRA.AWS.EBS.1", state: "PASS" },
    { controlId: "SUTRA.AWS.S3.2", state: "FAIL" },
    { controlId: "SUTRA.AWS.SG.1", state: "PASS" },
    { controlId: "SUTRA.AWS.UNRELATED.9", state: "PASS" },
  ];

  it("is evidence-honest: FAIL wins, missing evidence is NOT_COLLECTED, never PASS by absence", () => {
    const readiness = buildCustomFrameworkReadiness(collected, DEFINITION);
    const byId = new Map(readiness.controls.map((control) => [control.controlId, control]));
    assert.equal(byId.get("ACME-1")!.state, "FAIL");
    assert.equal(byId.get("ACME-2")!.state, "PASS");
    assert.equal(byId.get("ACME-3")!.state, "NOT_COLLECTED");
    assert.deepEqual(readiness.unmappedControlIds, ["SUTRA.AWS.UNRELATED.9"]);
    assert.equal(readiness.framework.id, "custom:acme-msp-baseline");
    assert.equal(readiness.framework.availability, "user-defined-mapping");
    assert.match(readiness.disclaimer, /not licensed framework content/);
  });

  it("keeps parity with the built-in engine for an identical mapping", () => {
    const builtIn = getComplianceFramework("soc-2-tsc");
    assert.notEqual(builtIn, undefined);
    const mirror: CustomFrameworkDefinition = {
      name: "soc2-mirror",
      title: builtIn!.title,
      claimBoundary: builtIn!.claimBoundary,
      controls: builtIn!.controls.map((control) => ({
        controlId: control.controlId,
        title: control.title,
        sutraControlIds: [...control.sutraControlIds],
      })),
    };
    // Mixed evidence across every mapped id: PASS/FAIL/UNKNOWN cycling, plus one id left uncollected.
    const allIds = [...new Set(builtIn!.controls.flatMap((control) => [...control.sutraControlIds]))];
    const states = ["PASS", "FAIL", "UNKNOWN"] as const;
    const mixed: CollectedControlResult[] = allIds.slice(1).map((controlId, index) => ({
      controlId,
      state: states[index % states.length],
    }));
    const expected = buildFrameworkReadiness(mixed, "soc-2-tsc");
    const actual = buildCustomFrameworkReadiness(mixed, mirror);
    assert.deepEqual(
      actual.controls.map((control) => ({ id: control.controlId, state: control.state })),
      expected.controls.map((control) => ({ id: control.controlId, state: control.state })),
    );
    assert.deepEqual(actual.summary, expected.summary);
    assert.deepEqual(actual.unmappedControlIds, expected.unmappedControlIds);
  });
});
