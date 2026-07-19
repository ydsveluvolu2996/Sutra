import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCiGate,
  renderCiGateJUnit,
  renderCiGateSummary,
  type GateStageResult,
} from "../lib/ci-scan-gate.ts";

const pass = (name: string): GateStageResult => ({ name, status: "pass", findings: 0 });

test("all stages passing => gate passes with exit 0", () => {
  const decision = evaluateCiGate([pass("secrets"), pass("iac"), pass("image-vulns")]);
  assert.equal(decision.passed, true);
  assert.equal(decision.exitCode, 0);
  assert.equal(decision.counts.breaching, 0);
});

test("a failed stage at or above the fail-on severity breaches (exit 2)", () => {
  const decision = evaluateCiGate([
    pass("secrets"),
    { name: "image-vulns", status: "fail", findings: 3, highestSeverity: "critical" },
  ], { failOn: "high" });
  assert.equal(decision.breached, true);
  assert.equal(decision.exitCode, 2);
  assert.equal(decision.stages[1]?.reason, "at-or-above-threshold");
});

test("a failed stage below the fail-on severity does not breach but is reported", () => {
  const decision = evaluateCiGate([
    { name: "iac", status: "fail", findings: 2, highestSeverity: "low" },
  ], { failOn: "high" });
  assert.equal(decision.passed, true);
  assert.equal(decision.exitCode, 0);
  assert.equal(decision.stages[0]?.breaches, false);
  assert.equal(decision.stages[0]?.reason, "below-threshold");
});

test("a failed stage with unknown severity is treated as a breach", () => {
  const unknown = evaluateCiGate([{ name: "custom", status: "fail", findings: 1 }], { failOn: "critical" });
  assert.equal(unknown.breached, true);
  assert.equal(unknown.stages[0]?.reason, "unknown-severity");
  const explicitNull = evaluateCiGate([{ name: "custom", status: "fail", highestSeverity: null }], { failOn: "critical" });
  assert.equal(explicitNull.breached, true);
});

test("a skipped stage is surfaced and never counted as a pass", () => {
  const decision = evaluateCiGate([pass("secrets"), { name: "image-vulns", status: "skipped", detail: "trivy not installed" }]);
  assert.equal(decision.passed, true);
  assert.equal(decision.counts.skipped, 1);
  assert.equal(decision.counts.passed, 1);
  assert.equal(decision.stages[1]?.reason, "skipped");
});

test("fail-on threshold is honored: same finding breaches at 'high' but not at 'critical'", () => {
  const stage: GateStageResult = { name: "image-vulns", status: "fail", findings: 5, highestSeverity: "high" };
  assert.equal(evaluateCiGate([stage], { failOn: "high" }).breached, true);
  assert.equal(evaluateCiGate([stage], { failOn: "critical" }).breached, false);
});

test("default fail-on is 'high'", () => {
  assert.equal(evaluateCiGate([]).failOn, "high");
});

test("JUnit XML marks breaching stages as failures and skipped stages as skipped", () => {
  const decision = evaluateCiGate([
    pass("secrets"),
    { name: "image-vulns", status: "fail", findings: 2, highestSeverity: "critical" },
    { name: "trivy", status: "skipped", detail: "not installed" },
  ], { failOn: "high" });
  const xml = renderCiGateJUnit(decision);
  assert.match(xml, /<testsuites name="sutra-ci-scan-gate" tests="3" failures="1" skipped="1">/u);
  assert.match(xml, /<testcase name="image-vulns"[\s\S]*?<failure message="[^"]*critical/u);
  assert.match(xml, /<testcase name="trivy"[\s\S]*?<skipped/u);
  // The passing stage has neither a failure nor a skipped child.
  assert.match(xml, /<testcase name="secrets" classname="sutra.ci-scan-gate">\s*<system-out>/u);
});

test("JUnit XML escapes special characters in stage detail", () => {
  const decision = evaluateCiGate([
    { name: "iac", status: "fail", findings: 1, highestSeverity: "high", detail: 'a<b>&"c' },
  ], { failOn: "high" });
  const xml = renderCiGateJUnit(decision);
  assert.ok(!/detail=a<b>/u.test(xml));
  assert.match(xml, /a&lt;b&gt;&amp;&quot;c/u);
});

test("summary lists a verdict line and a marker per stage", () => {
  const decision = evaluateCiGate([
    pass("secrets"),
    { name: "image-vulns", status: "fail", findings: 2, highestSeverity: "critical" },
  ], { failOn: "high" });
  const summary = renderCiGateSummary(decision);
  assert.match(summary, /BREACHED \(fail-on=high\)/u);
  assert.match(summary, /breach {2}image-vulns/u);
  assert.match(summary, /ok {2}secrets/u);
});

test("output is deterministic", () => {
  const stages: GateStageResult[] = [
    pass("secrets"),
    { name: "iac", status: "fail", findings: 1, highestSeverity: "medium" },
  ];
  assert.deepEqual(evaluateCiGate(stages, { failOn: "high" }), evaluateCiGate(stages, { failOn: "high" }));
});
