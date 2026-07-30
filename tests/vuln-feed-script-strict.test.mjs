import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileBulkMirrorRows,
  runVulnerabilityFeedRefresh,
} from "../scripts/vuln-feed-refresh.mjs";

const EPSS = [
  "#model_version:v2026.07.30,score_date:2026-07-30T00:00:00Z",
  "cve,epss,percentile",
  "CVE-2026-12345,0.75,0.98",
].join("\n");

const KEV = {
  catalogVersion: "2026.07.30",
  dateReleased: "2026-07-30T00:00:00Z",
  count: 1,
  vulnerabilities: [{
    cveID: "CVE-2026-12345",
    dueDate: "2026-08-30",
    knownRansomwareCampaignUse: "Unknown",
  }],
};

test("strict managed refresh fails when EPSS retrieval fails", async () => {
  let wrote = false;
  await assert.rejects(
    () => runVulnerabilityFeedRefresh({
      strict: true,
      fetchKev: async () => KEV,
      fetchEpss: async () => { throw new Error("upstream unavailable"); },
      fetchNvd: async () => [],
      writeDatabase: async () => { wrote = true; return 1; },
    }),
    /requires a successfully retrieved EPSS feed/u,
  );
  assert.equal(wrote, false, "a missing EPSS feed must never overwrite the live mirror");
});

test("strict managed refresh fails when the database transaction does not commit", async () => {
  await assert.rejects(
    () => runVulnerabilityFeedRefresh({
      strict: true,
      fetchKev: async () => KEV,
      fetchEpss: async () => EPSS,
      fetchNvd: async () => [],
      writeDatabase: async () => { throw new Error("database commit failed"); },
    }),
    /database commit failed/u,
  );
});

test("strict managed refresh rejects a retrieved but empty EPSS document", async () => {
  await assert.rejects(
    () => runVulnerabilityFeedRefresh({
      strict: true,
      fetchKev: async () => KEV,
      fetchEpss: async () => "cve,epss,percentile\n",
      fetchNvd: async () => [],
      writeDatabase: async () => 1,
    }),
    /non-empty parsed EPSS feed/u,
  );
});

test("strict managed refresh rejects a zero-row database acknowledgement", async () => {
  await assert.rejects(
    () => runVulnerabilityFeedRefresh({
      strict: true,
      fetchKev: async () => KEV,
      fetchEpss: async () => EPSS,
      fetchNvd: async () => [],
      writeDatabase: async () => 0,
    }),
    /committed non-empty database upsert/u,
  );
});

test("strict managed refresh rejects failed, empty, and malformed KEV catalogs without writing", async (t) => {
  const cases = [
    ["fetch failure", async () => { throw new Error("upstream unavailable"); }],
    ["empty catalog", async () => ({ catalogVersion: "2026.07.30", vulnerabilities: [] })],
    ["missing catalog metadata", async () => ({ count: 1, vulnerabilities: KEV.vulnerabilities })],
    ["declared count mismatch", async () => ({
      catalogVersion: "2026.07.30",
      count: 2,
      vulnerabilities: KEV.vulnerabilities,
    })],
    ["malformed catalog entry", async () => ({
      catalogVersion: "2026.07.30",
      count: 1,
      vulnerabilities: [{ dueDate: "2026-08-30" }],
    })],
  ];
  for (const [name, fetchKev] of cases) {
    await t.test(name, async () => {
      let wrote = false;
      await assert.rejects(
        () => runVulnerabilityFeedRefresh({
          strict: true,
          fetchKev,
          fetchEpss: async () => EPSS,
          fetchNvd: async () => [],
          writeDatabase: async () => { wrote = true; return 1; },
        }),
        /valid, non-empty CISA KEV catalog/u,
      );
      assert.equal(wrote, false);
    });
  }
});

test("failed KEV retrieval preserves existing membership in best-effort mode", async () => {
  const existing = [{
    cveId: "CVE-2026-1002",
    epssScore: null,
    epssPercentile: null,
    cvssScore: 7.5,
    cvssVector: null,
    severity: "high",
    summary: "Existing evidence",
    source: "cisa-kev+nvd",
    asOf: "2026-07-29T00:00:00.000Z",
  }];
  let reconciled = [];
  await runVulnerabilityFeedRefresh({
    strict: false,
    fetchKev: async () => { throw new Error("upstream unavailable"); },
    fetchEpss: async () => EPSS,
    fetchNvd: async () => [],
    writeDatabase: async (serialized, asOf, _strict, policy) => {
      reconciled = reconcileBulkMirrorRows(existing, serialized, asOf, policy);
      return reconciled.length;
    },
  });
  assert.match(reconciled[0].source, /cisa-kev/u);
  assert.equal(reconciled[0].cvssScore, 7.5);
});

test("authoritative current catalogs preserve CVSS/current KEV and remove stale EPSS/KEV membership", () => {
  const existing = [
    {
      cveId: "CVE-2026-1001",
      epssScore: 0.1,
      epssPercentile: 0.2,
      cvssScore: 9.1,
      cvssVector: "CVSS:3.1/preserved",
      severity: "critical",
      summary: "NVD evidence",
      source: "cisa-kev+epss+nvd",
      asOf: "2026-07-29T00:00:00.000Z",
    },
    {
      cveId: "CVE-2026-1002",
      epssScore: null,
      epssPercentile: null,
      cvssScore: 7.5,
      cvssVector: null,
      severity: "high",
      summary: "Older NVD evidence",
      source: "cisa-kev+nvd",
      asOf: "2026-07-29T00:00:00.000Z",
    },
    {
      cveId: "CVE-2026-STALE",
      epssScore: 0.2,
      epssPercentile: 0.4,
      cvssScore: null,
      cvssVector: null,
      severity: null,
      summary: null,
      source: "epss",
      asOf: "2026-07-29T00:00:00.000Z",
    },
  ];
  const serialized = {
    epss: [
      ["CVE-2026-1001", { score: 0.8, percentile: 0.99 }],
      ["CVE-2026-1003", { score: 0.3, percentile: 0.7 }],
    ],
    records: [],
    kev: [["CVE-2026-1001", { knownExploited: true }]],
  };
  const rows = reconcileBulkMirrorRows(
    existing,
    serialized,
    "2026-07-30T00:00:00.000Z",
    { reconcileEpssMembership: true, reconcileKevMembership: true },
  );
  const byCve = new Map(rows.map((row) => [row.cveId, row]));
  assert.equal(byCve.get("CVE-2026-1001").cvssScore, 9.1);
  assert.equal(byCve.get("CVE-2026-1001").epssScore, 0.8);
  assert.match(byCve.get("CVE-2026-1001").source, /cisa-kev/u);
  assert.doesNotMatch(
    byCve.get("CVE-2026-1002").source,
    /cisa-kev|epss/u,
    "removed KEV/EPSS membership must not survive the current feed",
  );
  assert.equal(byCve.get("CVE-2026-1002").cvssScore, 7.5);
  assert.equal(byCve.get("CVE-2026-1003").source, "epss");
  assert.equal(byCve.has("CVE-2026-STALE"), false);
});
