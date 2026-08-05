import assert from "node:assert/strict";
import test from "node:test";

import { refreshBoundedVulnerabilityFeed } from "../lib/vuln-feed-runtime.ts";

function repository(writes) {
  return {
    upsertFeedRows: async (feed, rows) => {
      writes.push({ feed, rows });
      return rows.length;
    },
  };
}

test("bounded KEV refresh writes real catalog membership rows", async () => {
  const writes = [];
  const count = await refreshBoundedVulnerabilityFeed({
    feed: "kev",
    repository: repository(writes),
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    fetchImpl: async (url, options) => {
      assert.equal(new URL(String(url)).hostname, "www.cisa.gov");
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({
        dateReleased: "2026-07-30",
        count: 1,
        vulnerabilities: [{ cveID: "CVE-2026-12345" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(count, 1);
  assert.equal(writes[0].feed, "kev");
  assert.equal(writes[0].rows[0].cveId, "CVE-2026-12345");
  assert.equal(writes[0].rows[0].source, "cisa-kev");
});

test("bounded NVD refresh uses a finite modified window and persists parsed CVSS", async () => {
  const writes = [];
  const count = await refreshBoundedVulnerabilityFeed({
    feed: "nvd",
    nvdWindowDays: 3,
    repository: repository(writes),
    now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get("resultsPerPage"), "2000");
      assert.ok(parsed.searchParams.get("lastModStartDate"));
      assert.ok(parsed.searchParams.get("lastModEndDate"));
      return new Response(JSON.stringify({
        vulnerabilities: [{
          cve: {
            id: "CVE-2026-9999",
            descriptions: [{ lang: "en", value: "bounded test CVE" }],
            metrics: {
              cvssMetricV31: [{
                cvssData: {
                  baseScore: 9.8,
                  baseSeverity: "CRITICAL",
                  vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
                },
              }],
            },
          },
        }],
      }), { status: 200 });
    },
  });
  assert.equal(count, 1);
  assert.equal(writes[0].feed, "nvd");
  assert.equal(writes[0].rows[0].cvssScore, 9.8);
  assert.equal(writes[0].rows[0].severity, "critical");
});

test("an empty upstream is a failure, never a successful empty mirror", async () => {
  await assert.rejects(
    () => refreshBoundedVulnerabilityFeed({
      feed: "nvd",
      repository: repository([]),
      fetchImpl: async () => new Response(JSON.stringify({ vulnerabilities: [] }), { status: 200 }),
    }),
    /nvd-feed-empty/u,
  );
});

test("malformed or partial KEV catalogs cannot reconcile existing membership", async () => {
  for (const payload of [
    { dateReleased: "2026-07-30", count: 0, vulnerabilities: [] },
    { count: 1, vulnerabilities: [{ cveID: "CVE-2026-12345" }] },
    {
      dateReleased: "2026-07-30",
      count: 2,
      vulnerabilities: [{ cveID: "CVE-2026-12345" }],
    },
    {
      dateReleased: "2026-07-30",
      count: 2,
      vulnerabilities: [
        { cveID: "CVE-2026-12345" },
        { dueDate: "2026-08-30" },
      ],
    },
  ]) {
    const writes = [];
    await assert.rejects(
      () => refreshBoundedVulnerabilityFeed({
        feed: "kev",
        repository: repository(writes),
        fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
      }),
      /kev-feed-(?:empty|invalid)/u,
    );
    assert.equal(writes.length, 0, "an incomplete catalog must not touch the live membership");
  }
});
