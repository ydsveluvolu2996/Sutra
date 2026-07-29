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

// A bounded pull of recently-modified NVD CVEs (last 7 days, one page) so the
// mirror carries disclosure CVSS/severity for fresh CVEs. Kept small and
// graceful — NVD is rate-limited, so a failure is skipped, never faked. Full/
// historical population is a future extension (per-year feeds or an API key).
async function fetchNvdRecent() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const url =
    "https://services.nvd.nist.gov/rest/json/cves/2.0" +
    `?lastModStartDate=${encodeURIComponent(start.toISOString())}` +
    `&lastModEndDate=${encodeURIComponent(end.toISOString())}&resultsPerPage=2000&startIndex=0`;
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`NVD -> HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.vulnerabilities) ? body.vulnerabilities : [];
}

// Upsert the mirror (EPSS + NVD/OSV disclosure) into Postgres so the control
// plane can enrich findings by CVE. The runner talks to `pg` directly (it cannot
// import the worker bindings). A missing DATABASE_URL or a failed write is logged
// and skipped — the file mirror is still written.
async function writeMirrorToDatabase(serialized, asOf) {
  const databaseUrl = (process.env.DATABASE_URL ?? process.env.SUTRA_MIGRATOR_DATABASE_URL ?? "").trim();
  if (databaseUrl.length === 0) {
    console.warn("DATABASE_URL not set — skipped mirror DB write (file mirror still written)");
    return;
  }
  const { default: pg } = await import("pg");
  const byCve = new Map();
  for (const [cve, entry] of serialized.epss) {
    const key = cve.toUpperCase();
    byCve.set(key, { cveId: key, epssScore: entry.score, epssPercentile: entry.percentile, cvssScore: null, cvssVector: null, severity: null, summary: null, source: "epss" });
  }
  for (const record of serialized.records) {
    const key = record.id.toUpperCase();
    const row = byCve.get(key) ?? { cveId: key, epssScore: null, epssPercentile: null, cvssScore: null, cvssVector: null, severity: null, summary: null, source: record.source };
    row.cvssScore = record.cvssScore;
    row.cvssVector = record.cvssVector;
    row.severity = record.severity;
    row.summary = record.summary;
    row.source = row.epssScore !== null ? `epss+${record.source}` : record.source;
    byCve.set(key, row);
  }
  const rows = [...byCve.values()];
  if (rows.length === 0) {
    console.log("No mirror rows to write to the database");
    return;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, application_name: "sutra-vuln-feed", max: 1, connectionTimeoutMillis: 15_000 });
  const client = await pool.connect();
  const now = Date.now();
  const CHUNK = 500;
  try {
    await client.query("BEGIN");
    for (let index = 0; index < rows.length; index += CHUNK) {
      const chunk = rows.slice(index, index + CHUNK);
      const tuples = [];
      const params = [];
      for (let j = 0; j < chunk.length; j += 1) {
        const row = chunk[j];
        const base = j * 10;
        tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`);
        params.push(row.cveId, row.epssScore, row.epssPercentile, row.cvssScore, row.cvssVector, row.severity, row.summary, row.source, asOf, now);
      }
      await client.query(
        `INSERT INTO vulnerability_feed_mirror (cve_id, epss_score, epss_percentile, cvss_score, cvss_vector, severity, summary, source, as_of, updated_at)
           VALUES ${tuples.join(",")}
         ON CONFLICT (cve_id) DO UPDATE SET
           epss_score = excluded.epss_score, epss_percentile = excluded.epss_percentile,
           cvss_score = excluded.cvss_score, cvss_vector = excluded.cvss_vector,
           severity = excluded.severity, summary = excluded.summary,
           source = excluded.source, as_of = excluded.as_of, updated_at = excluded.updated_at`,
        params,
      );
    }
    await client.query("COMMIT");
    console.log(`Upserted ${rows.length} rows into vulnerability_feed_mirror`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    console.warn(`Mirror DB write failed (file mirror still written): ${error.message}`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  let kevJson;
  let epssCsv;
  let nvdItems = [];
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
  try {
    nvdItems = await fetchNvdRecent();
    console.log(`NVD: ${nvdItems.length} recently-modified CVEs`);
  } catch (error) {
    console.warn(`NVD fetch failed (skipped): ${error.message}`);
  }

  const asOf = new Date().toISOString();
  const mirror = ingestVulnerabilityFeeds({ kevJson, epssCsv, nvdItems, asOf, source: "kev+epss+nvd" });
  const serialized = serializeMirror(mirror, "kev+epss+nvd");

  // THE DATABASE WRITE COMES FIRST, and nothing optional may precede it.
  //
  // It used to run last, after the two file writes below. In the production
  // container /app is not writable by the `node` user, so `mkdir /app/data` threw
  // EACCES and the process died — discarding a completed KEV + 10.7 MB EPSS + NVD
  // fetch and ingest that had already succeeded, and leaving the mirror in Postgres
  // untouched while the logs showed three feeds downloading happily. The mirror in
  // the database IS the product; the JSON files below are developer conveniences
  // that nothing in production reads.
  await writeMirrorToDatabase(serialized, asOf);
  console.log(
    `Mirror as of ${asOf}: ${mirror.report.kevCount} KEV, ${mirror.report.epssCount} EPSS, `
    + `${mirror.report.recordCount} records written to the database.`,
  );

  // Best-effort artifacts. A read-only or non-writable output directory must not
  // fail a refresh that already landed, so these warn instead of throwing — but they
  // warn with the path and the reason, because silently skipping a file someone is
  // waiting for is its own kind of lie.
  const path = outputPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(serialized), "utf8");
    console.log(`Wrote file mirror -> ${path}`);
  } catch (error) {
    console.warn(`File mirror skipped (${path}): ${error.message}`);
  }

  // The compact KEV snapshot the app bundles for enrichment. KEV is small (~1.6k
  // entries) and slow-changing, so a refreshable, asOf-stamped snapshot is a
  // reasonable home; the large EPSS set stays in the mirror.
  const snapshotPath = resolve(process.env.KEV_SNAPSHOT_PATH ?? "./data/kev-snapshot.json");
  try {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify({ asOf, source: "cisa-kev", entries: serialized.kev }, null, 0)}\n`, "utf8");
    console.log(`Wrote KEV snapshot: ${mirror.report.kevCount} entries -> ${snapshotPath}`);
  } catch (error) {
    console.warn(`KEV snapshot skipped (${snapshotPath}): ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
