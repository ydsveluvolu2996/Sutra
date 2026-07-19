import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKubernetesIssues,
  type IssueExposureInput,
  type IssueFlowInput,
  type IssuePostureInput,
  type IssueRuntimeInput,
  type IssueVulnInput,
} from "../lib/kubernetes-issues.ts";

const wl = (name: string, namespace = "payments") => ({ namespace, name });

function vuln(name: string, severity: IssueVulnInput["severity"], over: Partial<IssueVulnInput> = {}): IssueVulnInput {
  return { workload: wl(name), severity, cveId: `CVE-2026-${name}`, title: "vuln", fixedVersion: "1.2.3", packageName: "openssl", ...over };
}
function posture(name: string, controlId: string, severity: IssuePostureInput["severity"] = "HIGH"): IssuePostureInput {
  return { workload: wl(name), controlId, severity, message: `${controlId} failed` };
}
function exposure(name: string, kind: IssueExposureInput["kind"] = "internet"): IssueExposureInput {
  return { workload: wl(name), kind, evidence: `${kind} exposure` };
}
function flow(name: string, over: Partial<IssueFlowInput> = {}): IssueFlowInput {
  return { workload: wl(name), fromExternal: true, verdict: "forwarded", observedAt: "2026-07-18T00:00:00.000Z", ...over };
}
function runtime(name: string, over: Partial<IssueRuntimeInput> = {}): IssueRuntimeInput {
  return { workload: wl(name), rule: "Terminal shell in container", priority: "Warning", observedAt: "2026-07-18T00:00:00.000Z", ...over };
}
const empty = { vulnerabilities: [], posture: [], exposures: [], flows: [], runtime: [] };

test("a confirmed-reachable, runtime-active HIGH outranks a dormant unreachable CRITICAL", () => {
  const report = buildKubernetesIssues({
    ...empty,
    vulnerabilities: [vuln("frontend", "high"), vuln("batch", "critical")],
    exposures: [exposure("frontend")],
    flows: [flow("frontend")],
    runtime: [runtime("frontend")],
  });
  // frontend: exposed + confirmed reachable + runtime + high vuln.
  // batch: critical vuln, not exposed, no runtime.
  const top = report.issues[0];
  assert.equal(top?.workload, "payments/frontend");
  assert.equal(top?.reachability, "confirmed");
  assert.equal(top?.runtimeObserved, true);
  const batch = report.issues.find((issue) => issue.workload === "payments/batch");
  assert.ok(batch !== undefined);
  assert.equal(batch.severity, "critical");
  assert.equal(batch.reachability, "not_exposed");
  assert.ok(
    top.priority > batch.priority,
    `reachable+runtime high (${top.priority}) must outrank dormant critical (${batch.priority})`,
  );
});

test("reachability is confirmed only from an observed external forwarded flow", () => {
  const confirmed = buildKubernetesIssues({ ...empty, vulnerabilities: [vuln("a", "high")], exposures: [exposure("a")], flows: [flow("a")] });
  assert.equal(confirmed.issues[0]?.reachability, "confirmed");

  const theoretical = buildKubernetesIssues({ ...empty, vulnerabilities: [vuln("a", "high")], exposures: [exposure("a")] });
  assert.equal(theoretical.issues[0]?.reachability, "theoretical");

  // An internal (non-external) or dropped flow must not confer reachability.
  const internal = buildKubernetesIssues({
    ...empty, vulnerabilities: [vuln("a", "high")], exposures: [exposure("a")],
    flows: [flow("a", { fromExternal: false }), flow("a", { verdict: "dropped" })],
  });
  assert.equal(internal.issues[0]?.reachability, "theoretical");
});

test("confirmed reachability raises priority and can raise privileged severity to critical", () => {
  const theoretical = buildKubernetesIssues({ ...empty, posture: [posture("a", "K8S-WORKLOAD-NO-PRIVILEGED")], exposures: [exposure("a")] });
  const confirmed = buildKubernetesIssues({ ...empty, posture: [posture("a", "K8S-WORKLOAD-NO-PRIVILEGED")], exposures: [exposure("a")], flows: [flow("a")] });
  const t = theoretical.issues.find((i) => i.ruleId === "exposed-privileged-workload");
  const c = confirmed.issues.find((i) => i.ruleId === "exposed-privileged-workload");
  assert.equal(t?.severity, "high");
  assert.equal(c?.severity, "critical");
  assert.ok((c?.priority ?? 0) > (t?.priority ?? 0));
});

test("each named toxic combination is emitted with cited factors", () => {
  const report = buildKubernetesIssues({
    ...empty,
    vulnerabilities: [vuln("a", "critical")],
    posture: [posture("a", "K8S-WORKLOAD-NO-PRIVILEGED"), posture("a", "K8S-RBAC-WILDCARDS")],
    exposures: [exposure("a")],
    flows: [flow("a")],
    runtime: [runtime("a")],
  });
  const rules = new Set(report.issues.map((issue) => issue.ruleId));
  assert.ok(rules.has("exposed-vulnerable-workload"));
  assert.ok(rules.has("exposed-privileged-workload"));
  assert.ok(rules.has("exposed-overpermissioned-identity"));
  assert.ok(rules.has("runtime-active-vulnerable-workload"));
  assert.ok(rules.has("runtime-active-privileged-workload"));
  for (const issue of report.issues) {
    assert.ok(issue.factors.length > 0, `${issue.ruleId} must cite factors`);
  }
});

test("the critical-vulnerability fallback fires only when not exposed and not runtime-active", () => {
  const captured = buildKubernetesIssues({ ...empty, vulnerabilities: [vuln("a", "critical")], exposures: [exposure("a")] });
  assert.ok(!captured.issues.some((i) => i.ruleId === "critical-vulnerability"), "exposed critical is captured by the exposure rule, not the fallback");

  const fallback = buildKubernetesIssues({ ...empty, vulnerabilities: [vuln("b", "critical")] });
  assert.deepEqual(fallback.issues.map((i) => i.ruleId), ["critical-vulnerability"]);
  assert.equal(fallback.issues[0]?.reachability, "not_exposed");
});

test("issues dedupe per workload and rule; summary counts are accurate", () => {
  const report = buildKubernetesIssues({
    ...empty,
    vulnerabilities: [vuln("a", "high"), vuln("a", "critical"), vuln("a", "low")],
    exposures: [exposure("a")],
    flows: [flow("a")],
  });
  // Only one exposed-vulnerable issue for workload a, using the worst (critical) severity.
  const exposedVuln = report.issues.filter((i) => i.ruleId === "exposed-vulnerable-workload" && i.workload === "payments/a");
  assert.equal(exposedVuln.length, 1);
  assert.equal(exposedVuln[0]?.severity, "critical");
  assert.equal(report.totals.issues, report.issues.length);
  assert.equal(report.totals.confirmedReachable, report.issues.filter((i) => i.reachability === "confirmed").length);
});

test("no evidence produces no issues", () => {
  const report = buildKubernetesIssues(empty);
  assert.equal(report.issues.length, 0);
  assert.equal(report.totals.issues, 0);
  assert.match(report.disclaimer, /not proof of exploitability/u);
});

test("output is deterministic for identical input", () => {
  const build = () => buildKubernetesIssues({
    ...empty,
    vulnerabilities: [vuln("z", "high"), vuln("a", "high")],
    exposures: [exposure("z"), exposure("a")],
    flows: [flow("a")],
    runtime: [runtime("z")],
  });
  assert.deepEqual(build(), build());
});
