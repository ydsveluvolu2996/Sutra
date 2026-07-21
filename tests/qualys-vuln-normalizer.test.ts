import assert from "node:assert/strict";
import test from "node:test";

import {
  QUALYS_RESOURCE_KIND,
  QUALYS_SOURCE,
  normalizeQualysReport,
  qualysFindingKey,
} from "../lib/qualys-vuln-normalizer.ts";

// A representative, captured-shape slice of a Qualys VM/VMDR host-detection export:
// one host with an FQDN, a level-5 detection carrying a CVE + a V3 CVSS + a fix, a
// level-4 detection carrying TWO CVEs (so per-CVE explosion is exercised), a QID
// with no CVE at all (alias/cveId honesty), and a level-1 detection (floor mapping).
const SAMPLE = {
  hosts: [
    {
      id: 90210,
      fqdn: "web01.prod.example.com",
      dnsName: "web01",
      ip: "10.0.0.5",
      detections: [
        {
          qid: 38173,
          severity: 5,
          cveIds: ["CVE-2023-1111"],
          cvssBase: 5.0,
          cvss3Base: 9.8,
          packageName: "openssl",
          installedVersion: "3.0.9",
          fixedVersion: "3.0.11",
        },
        {
          qid: 91234,
          severity: 4,
          cveIds: ["CVE-2023-2222", "CVE-2023-3333"],
          // No CVSS number and no fix: cvss stays null, fix stays null.
        },
        {
          qid: 45000,
          severity: 3,
          // A QID with no CVE (e.g. a policy/config detection): cveId null, QID alias.
        },
        {
          qid: 11111,
          severity: 1,
          cveIds: ["CVE-2020-4040"],
        },
      ],
    },
  ],
};

test("maps Qualys detections to source-labeled unified rows keyed to the host", () => {
  const { findings } = normalizeQualysReport(SAMPLE);
  assert.ok(findings.every((finding) => finding.source === QUALYS_SOURCE));
  assert.ok(findings.every((finding) => finding.resourceKind === QUALYS_RESOURCE_KIND));
  // FQDN is the most specific host identifier and is used verbatim as the key.
  assert.ok(findings.every((finding) => finding.resourceKey === "web01.prod.example.com"));

  const high = findings.find((finding) => finding.cveId === "CVE-2023-1111");
  assert.ok(high);
  assert.equal(high.severity, "critical", "Qualys level 5 maps to critical");
  assert.equal(high.packageName, "openssl");
  assert.equal(high.installedVersion, "3.0.9");
  assert.equal(high.fixedVersion, "3.0.11");
  assert.equal(high.cvssScore, 9.8, "the V3 base score is preferred over V2; a vector is never parsed");
  // The persisted key is source-prefixed so it cannot collide with an Inspector row.
  assert.equal(high.findingKey, qualysFindingKey(high));
  assert.equal(high.findingKey, "qualys web01.prod.example.com CVE-2023-1111 openssl");
});

test("severity mapping follows Qualys' 1..5 scale honestly (5->critical … 1->low)", () => {
  const { findings } = normalizeQualysReport(SAMPLE);
  assert.equal(findings.find((f) => f.cveId === "CVE-2023-2222")?.severity, "high", "level 4 -> high");
  assert.equal(findings.find((f) => f.cveId === "CVE-2020-4040")?.severity, "low", "level 1 -> low (floor, not fabricated)");
  const configOnly = findings.find((f) => f.cveId === null);
  assert.equal(configOnly?.severity, "medium", "level 3 -> medium");
});

test("an out-of-range or missing Qualys level is 'unknown', never a fabricated 'low'", () => {
  const { findings } = normalizeQualysReport({
    hosts: [{ ip: "10.1.1.1", detections: [
      { qid: 1, severity: 9, cveIds: ["CVE-2021-0001"] },
      { qid: 2, cveIds: ["CVE-2021-0002"] },
    ] }],
  });
  assert.equal(findings.find((f) => f.cveId === "CVE-2021-0001")?.severity, "unknown", "level 9 is out of range -> unknown");
  assert.equal(findings.find((f) => f.cveId === "CVE-2021-0002")?.severity, "unknown", "a missing level -> unknown");
});

test("a QID carrying multiple CVEs explodes into one finding per CVE (for enrichment)", () => {
  const { findings } = normalizeQualysReport(SAMPLE);
  const cves = new Set(findings.map((finding) => finding.cveId));
  assert.ok(cves.has("CVE-2023-2222"));
  assert.ok(cves.has("CVE-2023-3333"));
});

test("a QID with no CVE keeps the QID in the finding, cveId null (never a fabricated CVE)", () => {
  const { findings } = normalizeQualysReport(SAMPLE);
  const configOnly = findings.filter((finding) => finding.cveId === null);
  assert.equal(configOnly.length, 1);
  assert.equal(configOnly[0]?.findingKey, "qualys web01.prod.example.com  ");
});

test("a missing fix and missing score are null, never defaulted", () => {
  const { findings } = normalizeQualysReport(SAMPLE);
  const noFix = findings.find((finding) => finding.cveId === "CVE-2023-2222");
  assert.ok(noFix);
  assert.equal(noFix.fixedVersion, null, "no structured fix -> null");
  assert.equal(noFix.cvssScore, null, "no numeric CVSS -> null");
});

test("a textual severity export falls back to the shared normalizer", () => {
  const { findings } = normalizeQualysReport({
    hosts: [{ ip: "10.2.2.2", detections: [{ qid: 7, severity: "High", cveIds: ["CVE-2019-0001"] }] }],
  });
  assert.equal(findings[0]?.severity, "high");
});

test("malformed rows are rejected and disclosed, never coerced into findings", () => {
  const result = normalizeQualysReport({
    hosts: [
      { detections: [{ qid: 1, cveIds: ["CVE-2022-0001"] }] }, // host with no identifier
      { ip: "10.3.3.3", detections: [{ severity: 5, cveIds: ["CVE-2022-0002"] }] }, // detection with no QID
      "not-an-object",
    ],
  });
  assert.equal(result.findings.length, 0, "nothing is fabricated from malformed input");
  const kinds = result.rejects.map((reject) => reject.kind).sort();
  assert.deepEqual(kinds, ["detection-without-qid", "host-without-identifier", "not-a-record"]);
});

test("empty / non-object input yields no findings and no crash", () => {
  assert.deepEqual(normalizeQualysReport(null).findings, []);
  assert.deepEqual(normalizeQualysReport(undefined).findings, []);
  assert.deepEqual(normalizeQualysReport({}).findings, []);
  assert.deepEqual(normalizeQualysReport({ hosts: "nope" }).findings, []);
});

test("the same CVE seen via two QIDs on one host collapses to a single row", () => {
  const { findings } = normalizeQualysReport({
    hosts: [{ ip: "10.4.4.4", detections: [
      { qid: 100, severity: 3, cveIds: ["CVE-2024-0001"] },
      { qid: 200, severity: 5, cveIds: ["CVE-2024-0001"] },
    ] }],
  });
  const matches = findings.filter((finding) => finding.cveId === "CVE-2024-0001");
  assert.equal(matches.length, 1, "merge dedupes by resource+cve+package");
  assert.equal(matches[0]?.severity, "critical", "merge keeps the most severe observation");
});

test("carries the CVE id verbatim so downstream EPSS/KEV enrichment can key on it", () => {
  const { findings } = normalizeQualysReport(SAMPLE);
  assert.ok(findings.some((finding) => finding.cveId === "CVE-2023-1111"));
  assert.ok(findings.every((finding) => finding.cveId === null || /^CVE-\d{4}-\d+$/u.test(finding.cveId)));
});
