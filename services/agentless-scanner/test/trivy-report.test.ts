import assert from "node:assert/strict";
import test from "node:test";

import { assertNoSecretMaterial, parseTrivyReport } from "../src/trivy-report.js";

test("maps CVEs to findings identified by CVE plus exact package version", () => {
  const parsed = parseTrivyReport({
    Results: [{
      Target: "/mnt/scan/usr/lib",
      Vulnerabilities: [
        { VulnerabilityID: "CVE-2026-1111", Severity: "CRITICAL", PkgName: "openssl", InstalledVersion: "3.0.1" },
      ],
    }],
  });
  assert.deepEqual(parsed.findings, [{
    source: "trivy-agentless",
    severity: "critical",
    title: "CVE-2026-1111 in openssl@3.0.1",
  }]);
  assert.equal(parsed.summary.vulnerabilities, 1);
});

test("every Trivy severity maps, and an unrecognised one degrades to unknown", () => {
  const parsed = parseTrivyReport({
    Results: [{
      Target: "t",
      Vulnerabilities: ["CRITICAL", "high", "Medium", "LOW", "NEGLIGIBLE", "WAT", null].map((severity, index) => ({
        VulnerabilityID: `CVE-2026-000${index}`, Severity: severity, PkgName: "p", InstalledVersion: "1",
      })),
    }],
  });
  assert.deepEqual(parsed.findings.map((f) => f.severity),
    ["critical", "high", "medium", "low", "unknown", "unknown", "unknown"]);
});

test("NEGLIGIBLE is not silently promoted to low", () => {
  // Mapping it to "low" would overstate a severity the distro deliberately
  // ranked below low, and low is actionable in the queue while unknown is triage.
  const parsed = parseTrivyReport({
    Results: [{ Target: "t", Vulnerabilities: [{ VulnerabilityID: "CVE-2026-9", Severity: "NEGLIGIBLE" }] }],
  });
  assert.equal(parsed.findings[0]?.severity, "unknown");
});

test("a secret is reported by CLASS and LOCATION — never by value", () => {
  const parsed = parseTrivyReport({
    Results: [{
      Target: "/mnt/scan/home/app/.env",
      Secrets: [{
        RuleID: "aws-access-key-id",
        Title: "AWS Access Key ID",
        StartLine: 12,
        // Trivy really does return the credential and its surrounding source.
        Match: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
        Code: { Lines: [{ Content: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" }] },
      }],
    }],
  });
  const title = parsed.findings[0]?.title ?? "";
  assert.match(title, /aws-access-key-id/u);
  assert.match(title, /\.env:12/u);
  assert.doesNotMatch(title, /wJalrXUtnFEMIK/u, "the credential must never reach a finding");
  assert.equal(parsed.findings[0]?.severity, "high", "a live credential on disk is not a medium");
  assert.equal(parsed.summary.secrets, 1);
});

test("an exposed secret with no rule id is still reported, not dropped", () => {
  const parsed = parseTrivyReport({
    Results: [{ Target: "/mnt/scan/x", Secrets: [{ StartLine: 3 }] }],
  });
  // Dropping it would turn "we found a credential we cannot classify" into
  // "clean", which is the worst possible direction to fail in.
  assert.equal(parsed.summary.secrets, 1);
  assert.match(parsed.findings[0]?.title ?? "", /unclassified-secret/u);
});

test("the redaction guard REFUSES the whole report if secret material leaked", () => {
  const leaked = [{ source: "trivy-agentless", severity: "high" as const, title: "found wJalrXUtnFEMIK7MDENGbPxRfiCY in .env" }];
  assert.throws(
    () => assertNoSecretMaterial(
      { Results: [{ Secrets: [{ Match: "wJalrXUtnFEMIK7MDENGbPxRfiCY" }] }] },
      leaked,
    ),
    /agentless-scan-refused/u,
  );
});

test("the guard ignores short values so it cannot false-positive on real titles", () => {
  // A 4-character Match would collide with ordinary words in a title and make
  // the guard useless by crying wolf.
  assert.doesNotThrow(() => assertNoSecretMaterial(
    { Results: [{ Secrets: [{ Match: "true" }] }] },
    [{ source: "trivy-agentless", severity: "low", title: "CVE-2026-1 in truetype@1.0" }],
  ));
});

test("misconfigurations are parsed and counted separately", () => {
  const parsed = parseTrivyReport({
    Results: [{
      Target: "/mnt/scan/etc/ssh/sshd_config",
      Misconfigurations: [{ ID: "AVD-KSV-0001", Title: "Root login permitted", Severity: "HIGH" }],
    }],
  });
  assert.equal(parsed.summary.misconfigurations, 1);
  assert.match(parsed.findings[0]?.title ?? "", /AVD-KSV-0001: Root login permitted/u);
});

test("an unparsable entry is COUNTED, so empty findings can be told apart from a schema change", () => {
  const parsed = parseTrivyReport({
    Results: [
      null,
      "not-an-object",
      { Target: "t", Vulnerabilities: [{ Severity: "HIGH" }] },
      { Target: "t", Misconfigurations: [{ Title: "no id" }] },
    ],
  });
  assert.deepEqual(parsed.findings, []);
  // Four bad shapes, four counted. A silent zero here would read as "clean disk".
  assert.equal(parsed.summary.unparsableResults, 4);
});

test("a report with no Results is empty, not an error", () => {
  for (const raw of [{}, { Results: [] }, { Results: null }, null, "x", 42]) {
    const parsed = parseTrivyReport(raw);
    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.summary.unparsableResults, 0);
  }
});

test("a vulnerability with no package falls back to the target path", () => {
  const parsed = parseTrivyReport({
    Results: [{ Target: "/mnt/scan/opt/app.jar", Vulnerabilities: [{ VulnerabilityID: "CVE-2026-5", Severity: "LOW" }] }],
  });
  assert.equal(parsed.findings[0]?.title, "CVE-2026-5 in /mnt/scan/opt/app.jar");
});

test("no finding carries a Description or raw file content", () => {
  const parsed = parseTrivyReport({
    Results: [{
      Target: "t",
      Vulnerabilities: [{
        VulnerabilityID: "CVE-2026-7", Severity: "HIGH", PkgName: "p", InstalledVersion: "1",
        Description: "A very long upstream prose description that should not be persisted verbatim.",
      }],
    }],
  });
  assert.doesNotMatch(parsed.findings[0]?.title ?? "", /upstream prose/u);
});
