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
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { validateCisaKevCatalog } from "../lib/exploitability-feed.ts";
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

function databaseConnectionString() {
  const direct = (process.env.DATABASE_URL ?? process.env.SUTRA_MIGRATOR_DATABASE_URL ?? "").trim();
  if (direct.length > 0) return direct;
  const host = process.env.SUTRA_DB_HOST?.trim() ?? "";
  const port = process.env.SUTRA_DB_PORT?.trim() ?? "";
  const name = process.env.SUTRA_DB_NAME?.trim() ?? "";
  const user = process.env.SUTRA_DB_APP_USER?.trim() ?? "";
  const password = process.env.SUTRA_DB_APP_PASSWORD ?? "";
  if (
    !/^[A-Za-z0-9.-]{1,253}$/u.test(host) ||
    !/^\d{2,5}$/u.test(port) ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u.test(name) ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u.test(user) ||
    password.length < 16 ||
    /[\r\n]/u.test(password)
  ) return "";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}?sslmode=require`;
}

// Upsert the mirror (EPSS + NVD/OSV disclosure) into Postgres so the control
// plane can enrich findings by CVE. The runner talks to `pg` directly (it cannot
// import the worker bindings). A missing DATABASE_URL or a failed write is logged
// and skipped — the file mirror is still written.
function sourceMarkers(value) {
  return new Set(
    String(value ?? "")
      .split("+")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function reconcileBulkMirrorRows(
  existingRows,
  serialized,
  asOf,
  {
    reconcileEpssMembership = true,
    reconcileKevMembership = true,
  } = {},
) {
  const byCve = new Map();
  for (const existing of existingRows) {
    const markers = sourceMarkers(existing.source);
    if (reconcileEpssMembership) markers.delete("epss");
    if (reconcileKevMembership) markers.delete("cisa-kev");
    if (markers.size === 0) continue;
    byCve.set(String(existing.cveId).toUpperCase(), {
      cveId: String(existing.cveId).toUpperCase(),
      epssScore: reconcileEpssMembership ? null : (existing.epssScore ?? null),
      epssPercentile: reconcileEpssMembership ? null : (existing.epssPercentile ?? null),
      cvssScore: existing.cvssScore ?? null,
      cvssVector: existing.cvssVector ?? null,
      severity: existing.severity ?? null,
      summary: existing.summary ?? null,
      markers,
      asOf: existing.asOf ?? asOf,
    });
  }
  const rowFor = (cve) => {
    const key = String(cve).toUpperCase();
    const existing = byCve.get(key);
    if (existing !== undefined) return existing;
    const created = {
      cveId: key,
      epssScore: null,
      epssPercentile: null,
      cvssScore: null,
      cvssVector: null,
      severity: null,
      summary: null,
      markers: new Set(),
      asOf,
    };
    byCve.set(key, created);
    return created;
  };
  for (const [cve, entry] of serialized.epss) {
    const row = rowFor(cve);
    row.epssScore = entry.score;
    row.epssPercentile = entry.percentile;
    row.markers.add("epss");
    row.asOf = asOf;
  }
  for (const record of serialized.records) {
    const row = rowFor(record.id);
    row.cvssScore = record.cvssScore;
    row.cvssVector = record.cvssVector;
    row.severity = record.severity;
    row.summary = record.summary;
    row.markers.add(record.source);
    row.asOf = asOf;
  }
  if (reconcileKevMembership) {
    for (const [cve] of serialized.kev) {
      const row = rowFor(cve);
      row.markers.add("cisa-kev");
      row.asOf = asOf;
    }
  }
  return [...byCve.values()].map((row) => ({
    cveId: row.cveId,
    epssScore: row.epssScore,
    epssPercentile: row.epssPercentile,
    cvssScore: row.cvssScore,
    cvssVector: row.cvssVector,
    severity: row.severity,
    summary: row.summary,
    source: [...row.markers].sort().join("+"),
    asOf: row.asOf,
  }));
}

async function writeMirrorToDatabase(
  serialized,
  asOf,
  strict = false,
  reconciliation = {},
) {
  const databaseUrl = databaseConnectionString();
  if (databaseUrl.length === 0) {
    if (strict) throw new Error("strict refresh requires database app-role credentials");
    console.warn("DATABASE_URL not set — skipped mirror DB write (file mirror still written)");
    return 0;
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: "sutra-vuln-feed",
    max: 1,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 20 * 60_000,
    query_timeout: 21 * 60_000,
  });
  const client = await pool.connect();
  const now = Date.now();
  const CHUNK = 500;
  try {
    await client.query("BEGIN");
    // Read every row. A successfully retrieved complete feed replaces its prior
    // membership; an unavailable/malformed feed preserves the prior evidence.
    const existingResult = await client.query(
      `SELECT cve_id, epss_score, epss_percentile, cvss_score, cvss_vector,
              severity, summary, source, as_of
         FROM vulnerability_feed_mirror`,
    );
    const existing = existingResult.rows.map((row) => ({
      cveId: row.cve_id,
      epssScore: row.epss_score,
      epssPercentile: row.epss_percentile,
      cvssScore: row.cvss_score,
      cvssVector: row.cvss_vector,
      severity: row.severity,
      summary: row.summary,
      source: row.source,
      asOf: row.as_of,
    }));
    const rows = reconcileBulkMirrorRows(existing, serialized, asOf, reconciliation);
    if (rows.length === 0) throw new Error("vulnerability mirror reconciliation produced no rows");
    await client.query("DELETE FROM vulnerability_feed_mirror");
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
    return rows.length;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    if (strict) throw error;
    console.warn(`Mirror DB write failed (file mirror still written): ${error.message}`);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function runVulnerabilityFeedRefresh({
  strict = false,
  fetchKev = () => fetchJson(KEV_URL),
  fetchEpss = () => fetchGzipText(EPSS_URL),
  fetchNvd = fetchNvdRecent,
  writeDatabase = writeMirrorToDatabase,
} = {}) {
  let kevJson;
  let kevAuthoritative = false;
  let epssCsv;
  let epssAuthoritative = false;
  let nvdItems = [];
  try {
    const candidate = await fetchKev();
    const validation = validateCisaKevCatalog(candidate);
    if (!validation.valid) throw new Error(`invalid CISA KEV catalog: ${validation.reason}`);
    kevJson = candidate;
    kevAuthoritative = true;
    console.log(`KEV: ${validation.feed.entries.size} entries`);
  } catch (error) {
    console.warn(`KEV refresh unavailable (existing membership preserved): ${error.message}`);
  }
  try {
    epssCsv = await fetchEpss();
    epssAuthoritative = typeof epssCsv === "string" && epssCsv.length > 0;
    console.log(`EPSS: fetched ${epssCsv.length} bytes`);
  } catch (error) {
    console.warn(`EPSS refresh unavailable (existing scores preserved): ${error.message}`);
  }
  if (strict && !kevAuthoritative) {
    throw new Error("strict refresh requires a successfully retrieved, valid, non-empty CISA KEV catalog");
  }
  if (strict && !epssAuthoritative) {
    throw new Error("strict refresh requires a successfully retrieved EPSS feed");
  }
  try {
    nvdItems = await fetchNvd();
    console.log(`NVD: ${nvdItems.length} recently-modified CVEs`);
  } catch (error) {
    console.warn(`NVD fetch failed (skipped): ${error.message}`);
  }

  const asOf = new Date().toISOString();
  const mirror = ingestVulnerabilityFeeds({ kevJson, epssCsv, nvdItems, asOf, source: "kev+epss+nvd" });
  const serialized = serializeMirror(mirror, "kev+epss+nvd");
  if (strict && mirror.report.epssCount === 0) {
    throw new Error("strict refresh requires a non-empty parsed EPSS feed");
  }
  if (mirror.report.epssCount === 0) epssAuthoritative = false;

  // THE DATABASE WRITE COMES FIRST, and nothing optional may precede it.
  //
  // It used to run last, after the two file writes below. In the production
  // container /app is not writable by the `node` user, so `mkdir /app/data` threw
  // EACCES and the process died — discarding a completed KEV + 10.7 MB EPSS + NVD
  // fetch and ingest that had already succeeded, and leaving the mirror in Postgres
  // untouched while the logs showed three feeds downloading happily. The mirror in
  // the database IS the product; the JSON files below are developer conveniences
  // that nothing in production reads.
  const rowsWritten = await writeDatabase(serialized, asOf, strict, {
    reconcileEpssMembership: epssAuthoritative,
    reconcileKevMembership: kevAuthoritative,
  });
  if (strict && (!Number.isSafeInteger(rowsWritten) || rowsWritten <= 0)) {
    throw new Error("strict refresh requires a committed non-empty database upsert");
  }
  console.log(
    `Mirror as of ${asOf}: ${mirror.report.kevCount} KEV, ${mirror.report.epssCount} EPSS, `
    + `${mirror.report.recordCount} records written to the database.`,
  );

  // Best-effort artifacts. A read-only or non-writable output directory must not
  // fail a refresh that already landed, so these warn instead of throwing — but they
  // warn with the path and the reason, because silently skipping a file someone is
  // waiting for is its own kind of lie.
  const path = outputPath();
  if (kevAuthoritative) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(serialized), "utf8");
      console.log(`Wrote file mirror -> ${path}`);
    } catch (error) {
      console.warn(`File mirror skipped (${path}): ${error.message}`);
    }
  } else {
    console.warn("File mirror unchanged because no authoritative KEV catalog was retrieved");
  }

  // The compact KEV snapshot the app bundles for enrichment. KEV is small (~1.6k
  // entries) and slow-changing, so a refreshable, asOf-stamped snapshot is a
  // reasonable home; the large EPSS set stays in the mirror.
  if (kevAuthoritative) {
    const snapshotPath = resolve(process.env.KEV_SNAPSHOT_PATH ?? "./data/kev-snapshot.json");
    try {
      await mkdir(dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, `${JSON.stringify({ asOf, source: "cisa-kev", entries: serialized.kev }, null, 0)}\n`, "utf8");
      console.log(`Wrote KEV snapshot: ${mirror.report.kevCount} entries -> ${snapshotPath}`);
    } catch (error) {
      console.warn(`KEV snapshot skipped (${snapshotPath}): ${error.message}`);
    }
  } else {
    console.warn("KEV snapshot unchanged because no authoritative catalog was retrieved");
  }
  return { mirror, serialized, rowsWritten };
}

function strictMode() {
  const value = process.env.SUTRA_VULN_FEED_STRICT ?? "false";
  if (value !== "true" && value !== "false") {
    throw new Error("SUTRA_VULN_FEED_STRICT must be true or false");
  }
  return value === "true";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runVulnerabilityFeedRefresh({ strict: strictMode() }).catch((error) => {
    console.error(JSON.stringify({
      event: "sutra.vulnerability-feed-refresh.failed",
      reason: error instanceof Error ? error.name : "unknown",
    }));
    process.exitCode = 1;
  });
}
