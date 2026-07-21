import assert from "node:assert/strict";
import test from "node:test";

import {
  RAPID7_RESOURCE_KIND,
  RAPID7_SOURCE,
  normalizeRapid7Report,
  rapid7FindingKey,
} from "../lib/rapid7-vuln-normalizer.ts";

// A representative, captured-shape slice of a Rapid7 InsightVM asset-vulnerability
// export: one asset with a hostName, a "Critical" vuln carrying a CVE (via the
// `references` array, source CVE) + a nested CVSS v3 score + a fix, a "Severe" vuln
// carrying a CVE via a flat `cves` array with no score/fix, and a vuln with NO CVE
// reference (only its InsightVM id) to exercise the alias/cveId honesty path.
const SAMPLE = {
  assets: [
    {
      id: 4242,
      hostName: "db-01.corp.example.com",
      ip: "10.20.30.40",
      vulnerabilities: [
        {
          id: "openssl-cve-2023-1111",
          severity: "Critical",
          references: [
            { source: "CVE", reference: "CVE-2023-1111" },
            { source: "URL", reference: "https://example.com/advisory" },
          ],
          cvss: { v3: { score: 9.1 }, v2: { score: 6.4 } },
          packageName: "openssl",
          installedVersion: "3.0.9",
          fixedVersion: "3.0.11",
        },
        {
          id: "http-cve-2023-2222",
          severity: "Severe",
          cves: ["CVE-2023-2222"],
        },
        {
          id: "policy-weak-tls-config",
          severity: "Moderate",
          // No CVE reference at all: cveId null, the InsightVM id kept as alias.
        },
      ],
    },
  ],
};

test("maps InsightVM vulnerabilities to source-labeled unified rows keyed to the asset", () => {
  const { findings } = normalizeRapid7Report(SAMPLE);
  assert.ok(findings.every((finding) => finding.source === RAPID7_SOURCE));
  assert.ok(findings.every((finding) => finding.resourceKind === RAPID7_RESOURCE_KIND));
  assert.ok(findings.every((finding) => finding.resourceKey === "db-01.corp.example.com"));

  const critical = findings.find((finding) => finding.cveId === "CVE-2023-1111");
  assert.ok(critical);
  assert.equal(critical.severity, "critical", "InsightVM 'Critical' -> critical");
  assert.equal(critical.packageName, "openssl");
  assert.equal(critical.installedVersion, "3.0.9");
  assert.equal(critical.fixedVersion, "3.0.11");
  assert.equal(critical.cvssScore, 9.1, "the nested V3 base score is preferred over V2");
  assert.equal(critical.findingKey, rapid7FindingKey(critical));
  assert.equal(critical.findingKey, "rapid7 db-01.corp.example.com CVE-2023-1111 openssl");
});

test("severity mapping follows InsightVM's three-tier scale (Critical/Severe/Moderate)", () => {
  const { findings } = normalizeRapid7Report(SAMPLE);
  assert.equal(findings.find((f) => f.cveId === "CVE-2023-2222")?.severity, "high", "'Severe' -> high");
  assert.equal(findings.find((f) => f.cveId === null)?.severity, "medium", "'Moderate' -> medium");
});

test("an unmapped or missing severity is 'unknown', never a fabricated 'low'", () => {
  const { findings } = normalizeRapid7Report({
    assets: [{ ip: "10.0.0.9", vulnerabilities: [
      { id: "v-1", severity: "Cosmic", cves: ["CVE-2021-0001"] },
      { id: "v-2", cves: ["CVE-2021-0002"] },
    ] }],
  });
  assert.equal(findings.find((f) => f.cveId === "CVE-2021-0001")?.severity, "unknown");
  assert.equal(findings.find((f) => f.cveId === "CVE-2021-0002")?.severity, "unknown");
});

test("extracts CVEs from both the references array (source CVE) and a flat cves array", () => {
  const { findings } = normalizeRapid7Report(SAMPLE);
  const cves = new Set(findings.map((finding) => finding.cveId));
  assert.ok(cves.has("CVE-2023-1111"), "from references[] with source CVE");
  assert.ok(cves.has("CVE-2023-2222"), "from a flat cves[]");
  // The non-CVE reference (URL) is not misread as a CVE.
  assert.ok(![...cves].includes("https://example.com/advisory"));
});

test("a vulnerability with no CVE keeps its InsightVM id, cveId null (never a fabricated CVE)", () => {
  const { findings } = normalizeRapid7Report(SAMPLE);
  const noCve = findings.filter((finding) => finding.cveId === null);
  assert.equal(noCve.length, 1);
  assert.equal(noCve[0]?.severity, "medium");
  assert.equal(noCve[0]?.findingKey, "rapid7 db-01.corp.example.com  ");
});

test("a missing fix and missing score are null, never defaulted", () => {
  const { findings } = normalizeRapid7Report(SAMPLE);
  const severe = findings.find((finding) => finding.cveId === "CVE-2023-2222");
  assert.ok(severe);
  assert.equal(severe.fixedVersion, null);
  assert.equal(severe.cvssScore, null);
});

test("malformed rows are rejected and disclosed, never coerced into findings", () => {
  const result = normalizeRapid7Report({
    assets: [
      { vulnerabilities: [{ id: "v-1", cves: ["CVE-2022-0001"] }] }, // asset with no identifier
      { ip: "10.9.9.9", vulnerabilities: [{ severity: "Critical", cves: ["CVE-2022-0002"] }] }, // vuln with no id
      12345,
    ],
  });
  assert.equal(result.findings.length, 0);
  const kinds = result.rejects.map((reject) => reject.kind).sort();
  assert.deepEqual(kinds, ["asset-without-identifier", "not-a-record", "vulnerability-without-id"]);
});

test("empty / non-object input yields no findings and no crash", () => {
  assert.deepEqual(normalizeRapid7Report(null).findings, []);
  assert.deepEqual(normalizeRapid7Report(undefined).findings, []);
  assert.deepEqual(normalizeRapid7Report({}).findings, []);
  assert.deepEqual(normalizeRapid7Report({ assets: "nope" }).findings, []);
});

test("the same CVE seen via two vulnerabilities on one asset collapses to a single row", () => {
  const { findings } = normalizeRapid7Report({
    assets: [{ ip: "10.4.4.4", vulnerabilities: [
      { id: "a", severity: "Moderate", cves: ["CVE-2024-0001"] },
      { id: "b", severity: "Critical", cves: ["CVE-2024-0001"] },
    ] }],
  });
  const matches = findings.filter((finding) => finding.cveId === "CVE-2024-0001");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.severity, "critical", "merge keeps the most severe observation");
});

test("carries the CVE id verbatim so downstream EPSS/KEV enrichment can key on it", () => {
  const { findings } = normalizeRapid7Report(SAMPLE);
  assert.ok(findings.some((finding) => finding.cveId === "CVE-2023-1111"));
  assert.ok(findings.every((finding) => finding.cveId === null || /^CVE-\d{4}-\d+$/u.test(finding.cveId)));
});

test("a bare array of assets is accepted the same as { assets: [...] }", () => {
  const { findings } = normalizeRapid7Report([
    { hostName: "h1", vulnerabilities: [{ id: "v", severity: "Critical", cves: ["CVE-2025-0001"] }] },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.resourceKey, "h1");
});
