// CI/CD scan gate. Turns the security stages a pipeline runs (secret scan, IaC
// misconfiguration, image vulnerabilities, network exposure, ...) into a single
// severity-aware pass/fail decision a build system can act on, plus a JUnit XML
// report Jenkins (and most CI systems) can publish natively. Pure and
// deterministic. Two honesty rules distinguish it from a naive gate:
//   * A stage that FAILED but whose worst finding is below the fail-on threshold
//     does not breach the gate — it is reported as "below threshold", never
//     hidden. A failed stage with an UNKNOWN severity is treated as a breach:
//     an unmeasured failure is not a pass.
//   * A stage is "skipped" only when its input or tool was genuinely absent; a
//     skipped stage is surfaced and never silently counted as a pass.

export type GateSeverity = "critical" | "high" | "medium" | "low";
export type GateStageStatus = "pass" | "fail" | "skipped";

export interface GateStageResult {
  readonly name: string;
  readonly status: GateStageStatus;
  readonly findings?: number;
  readonly highestSeverity?: GateSeverity | null;
  readonly detail?: string;
}

export interface EvaluatedStage extends GateStageResult {
  readonly breaches: boolean;
  readonly reason: "passed" | "skipped" | "below-threshold" | "at-or-above-threshold" | "unknown-severity";
}

export interface CiGateDecision {
  readonly schema: "sutra.ci-scan-gate.v1";
  readonly passed: boolean;
  readonly breached: boolean;
  readonly exitCode: 0 | 2;
  readonly failOn: GateSeverity;
  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly breaching: number;
  };
  readonly stages: readonly EvaluatedStage[];
  readonly disclaimer: string;
}

const SEVERITY_RANK: Readonly<Record<GateSeverity, number>> = { critical: 4, high: 3, medium: 2, low: 1 };

const DISCLAIMER =
  "The CI scan gate combines security stages into one pass/fail decision. A " +
  "failed stage breaches the gate only when its worst finding is at or above the " +
  "fail-on severity; a failed stage with an unknown severity is treated as a " +
  "breach (an unmeasured failure is not a pass). Skipped stages (absent input or " +
  "tool) are surfaced, never silently passed. Exit 2 = gate breached.";

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function evaluateStage(stage: GateStageResult, failOn: GateSeverity): EvaluatedStage {
  if (stage.status === "pass") return { ...stage, breaches: false, reason: "passed" };
  if (stage.status === "skipped") return { ...stage, breaches: false, reason: "skipped" };
  // status === "fail"
  if (stage.highestSeverity === undefined || stage.highestSeverity === null) {
    return { ...stage, breaches: true, reason: "unknown-severity" };
  }
  const breaches = SEVERITY_RANK[stage.highestSeverity] >= SEVERITY_RANK[failOn];
  return { ...stage, breaches, reason: breaches ? "at-or-above-threshold" : "below-threshold" };
}

export function evaluateCiGate(
  stages: readonly GateStageResult[],
  opts: { readonly failOn?: GateSeverity } = {},
): CiGateDecision {
  const failOn = opts.failOn ?? "high";
  const evaluated = stages.map((stage) => evaluateStage(stage, failOn));
  const breaching = evaluated.filter((stage) => stage.breaches).length;
  const breached = breaching > 0;
  return {
    schema: "sutra.ci-scan-gate.v1",
    passed: !breached,
    breached,
    exitCode: breached ? 2 : 0,
    failOn,
    counts: {
      total: evaluated.length,
      passed: evaluated.filter((stage) => stage.status === "pass").length,
      failed: evaluated.filter((stage) => stage.status === "fail").length,
      skipped: evaluated.filter((stage) => stage.status === "skipped").length,
      breaching,
    },
    stages: evaluated,
    disclaimer: DISCLAIMER,
  };
}

// JUnit XML: one <testcase> per stage. A breaching stage is a <failure>, a
// skipped stage is <skipped>, a non-breaching failure is a passing testcase
// annotated with system-out so the build stays green but the finding is visible.
export function renderCiGateJUnit(decision: CiGateDecision): string {
  const cases = decision.stages.map((stage) => {
    const name = xmlEscape(stage.name);
    const detail = stage.detail === undefined ? "" : xmlEscape(stage.detail);
    const severity = stage.highestSeverity ?? "n/a";
    const findings = stage.findings ?? 0;
    const sysOut = `<system-out>status=${stage.status} findings=${findings} highestSeverity=${severity} reason=${stage.reason}${detail === "" ? "" : ` detail=${detail}`}</system-out>`;
    if (stage.breaches) {
      const message = stage.reason === "unknown-severity"
        ? `${stage.name} failed with unknown severity`
        : `${stage.name} failed at or above ${decision.failOn} (highest ${severity}, ${findings} findings)`;
      return `    <testcase name="${name}" classname="sutra.ci-scan-gate">\n      <failure message="${xmlEscape(message)}" type="security-gate"/>\n      ${sysOut}\n    </testcase>`;
    }
    if (stage.status === "skipped") {
      return `    <testcase name="${name}" classname="sutra.ci-scan-gate">\n      <skipped message="${xmlEscape(detail || "input or tool absent")}"/>\n      ${sysOut}\n    </testcase>`;
    }
    return `    <testcase name="${name}" classname="sutra.ci-scan-gate">\n      ${sysOut}\n    </testcase>`;
  }).join("\n");
  const failures = decision.counts.breaching;
  const skipped = decision.counts.skipped;
  const total = decision.counts.total;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="sutra-ci-scan-gate" tests="${total}" failures="${failures}" skipped="${skipped}">`,
    `  <testsuite name="sutra-ci-scan-gate" tests="${total}" failures="${failures}" skipped="${skipped}">`,
    cases,
    `  </testsuite>`,
    `</testsuites>`,
    ``,
  ].join("\n");
}

export function renderCiGateSummary(decision: CiGateDecision): string {
  const verdict = decision.passed ? "PASS" : "BREACHED";
  const lines = [`Sutra CI scan gate: ${verdict} (fail-on=${decision.failOn})`];
  for (const stage of decision.stages) {
    const mark = stage.breaches ? "x breach" : stage.status === "skipped" ? "- skipped" : "ok";
    const sev = stage.highestSeverity ?? "n/a";
    lines.push(`  ${mark}  ${stage.name} [status=${stage.status} highest=${sev} findings=${stage.findings ?? 0}]`);
  }
  return lines.join("\n");
}
