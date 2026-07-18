#!/usr/bin/env node
// Live vulnerability-feed refresh runner. Fetches the CISA KEV catalog and the
// FIRST EPSS scores, builds a serializable mirror via the pure, tested ingest
// core (lib/vulnerability-feed-ingest.ts), and writes it to disk for the control
// plane to enrich findings against. Network IO lives ONLY here; all parsing and
// normalization is the tested pure core. Each feed is fetched independently — a
// failed feed is reported and skipped, never faked, so the mirror honestly
// reflects what was retrieved.
//
// Usage: node scripts/vuln-feed-refresh.mjs [--out <path>]
// Env:   VULN_MIRROR_PATH  output path (default ./data/vuln-feeds/mirror.json)
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ingestVulnerabilityFeeds, serializeMirror } from "../lib/vulnerability-feed-ingest.ts";

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const EPSS_URL = "https://epss.cyentia.com/epss_scores-current.csv.gz";
const USER_AGENT = "sutra-vuln-feed-refresh";

function outputPath() {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf("--out");
  if (flagIndex !== -1 && typeof args[flagIndex + 1] === "string") return resolve(args[flagIndex + 1]);
  return resolve(process.env.VULN_MIRROR_PATH ?? "./data/vuln-feeds/mirror.json");
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function fetchGzipText(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
}

async function main() {
  let kevJson;
  let epssCsv;
  try {
    kevJson = await fetchJson(KEV_URL);
    console.log(`KEV: ${Array.isArray(kevJson?.vulnerabilities) ? kevJson.vulnerabilities.length : 0} entries`);
  } catch (error) {
    console.warn(`KEV fetch failed (skipped): ${error.message}`);
  }
  try {
    epssCsv = await fetchGzipText(EPSS_URL);
    console.log(`EPSS: fetched ${epssCsv.length} bytes`);
  } catch (error) {
    console.warn(`EPSS fetch failed (skipped): ${error.message}`);
  }

  const asOf = new Date().toISOString();
  const mirror = ingestVulnerabilityFeeds({ kevJson, epssCsv, asOf, source: "kev+epss" });
  const serialized = serializeMirror(mirror, "kev+epss");

  const path = outputPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(serialized), "utf8");
  console.log(
    `Wrote mirror as of ${asOf}: ${mirror.report.kevCount} KEV, ${mirror.report.epssCount} EPSS, ${mirror.report.recordCount} DB records -> ${path}`,
  );

  // Also emit the compact, committed KEV snapshot the app bundles for enrichment.
  // KEV is small (~1.6k entries) and slow-changing, so a refreshable snapshot is a
  // reasonable, honest (asOf-stamped) home; the large EPSS set stays in the mirror.
  const snapshotPath = resolve(process.env.KEV_SNAPSHOT_PATH ?? "./data/kev-snapshot.json");
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify({ asOf, source: "cisa-kev", entries: serialized.kev }, null, 0)}\n`, "utf8");
  console.log(`Wrote KEV snapshot: ${mirror.report.kevCount} entries -> ${snapshotPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
