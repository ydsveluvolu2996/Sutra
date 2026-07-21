// Shared ingest runner for third-party vulnerability scanners (Qualys, Rapid7
// InsightVM) into the unified cloud vulnerability queue.
//
// It mirrors scripts/inspector-vuln-ingest.mjs: all IO lives here; parsing and
// normalization are the tested pure cores (lib/qualys-vuln-normalizer.ts /
// lib/rapid7-vuln-normalizer.ts). It reads a provided export FILE (or stdin) — it
// is NOT a live API call, so it adds no new external-auth surface — normalizes it,
// and upserts the result into the SAME cloud_vulnerability_findings table the
// /api/v1/cloud/vulnerabilities queue reads. A missing DATABASE_URL is reported and
// skipped, never faked. Parse rejects are disclosed, never hidden. First-seen is
// preserved across runs so a persisting finding keeps its true age.
//
// The one deliberate difference from the Inspector runner: the replace is
// SOURCE-SCOPED (WHERE connection_id = ? AND source = ?), because Inspector, Qualys
// and Rapid7 all share this one table. A Qualys ingest replaces only the 'qualys'
// rows for the connection and never touches Inspector or Rapid7 rows. Finding keys
// are source-prefixed by the normalizers, so ids never collide across sources.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function arg(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index !== -1 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : undefined;
}

function deterministicId(connectionId, findingKey) {
  return `cvf_${createHash("sha256").update(`${connectionId} ${findingKey}`, "utf8").digest("hex").slice(0, 48)}`;
}

async function readInput(inputPath) {
  if (typeof inputPath === "string" && inputPath !== "-") {
    return await readFile(resolve(inputPath), "utf8");
  }
  // stdin: supports `... | node scripts/qualys-vuln-ingest.mjs --connection ...`
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {{ source: "qualys"|"rapid7", label: string, normalize: (report: unknown) => { findings: readonly any[], rejects: readonly any[] } }} scanner
 */
export async function runScannerIngest(scanner) {
  const connectionId = (arg("connection") ?? "").trim();
  if (!CONNECTION_ID.test(connectionId)) throw new Error("--connection conn_<hex32> is required");
  const inputPath = arg("input");

  const rawText = await readInput(inputPath);
  let report;
  try {
    report = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Could not parse the ${scanner.label} export as JSON: ${error.message ?? error}`);
  }

  const { findings, rejects } = scanner.normalize(report);
  if (rejects.length > 0) {
    console.warn(`${scanner.label}: rejected ${rejects.length} malformed row(s) (disclosed, not ingested):`);
    for (const reject of rejects.slice(0, 10)) console.warn(`  - ${reject.kind}: ${reject.locator}`);
    if (rejects.length > 10) console.warn(`  … and ${rejects.length - 10} more`);
  }
  if (findings.length === 0) console.warn(`No ${scanner.label} findings to ingest`);

  const databaseUrl = (process.env.DATABASE_URL ?? process.env.SUTRA_MIGRATOR_DATABASE_URL ?? "").trim();
  if (databaseUrl.length === 0) {
    // Without a database we can still prove the normalization is honest.
    console.warn(`DATABASE_URL not set — normalized ${findings.length} ${scanner.label} finding(s) but skipped the DB write`);
    return;
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, application_name: `sutra-${scanner.source}-vuln`, max: 1, connectionTimeoutMillis: 15_000 });
  const client = await pool.connect();
  try {
    // Resolve the tenant from the connection itself, so the runner cannot write
    // findings into the wrong tenant.
    const connection = await client.query(
      "SELECT org_id, customer_id, aws_account_id FROM aws_connections WHERE id = $1 LIMIT 1",
      [connectionId],
    );
    if (connection.rowCount === 0) throw new Error(`Connection ${connectionId} not found`);
    const { org_id: orgId, customer_id: customerId, aws_account_id: accountId } = connection.rows[0];

    const now = Date.now();
    await client.query("BEGIN");
    // Preserve first-seen for persisting findings of THIS source only.
    const existing = await client.query(
      "SELECT finding_key, first_seen_at FROM cloud_vulnerability_findings WHERE connection_id = $1 AND source = $2",
      [connectionId, scanner.source],
    );
    const firstSeenByKey = new Map(existing.rows.map((row) => [row.finding_key, Number(row.first_seen_at)]));
    // Source-scoped replace: only this scanner's rows are removed, so Inspector and
    // the other scanner's findings for this connection are left intact.
    await client.query(
      "DELETE FROM cloud_vulnerability_findings WHERE connection_id = $1 AND org_id = $2 AND customer_id = $3 AND source = $4",
      [connectionId, orgId, customerId, scanner.source],
    );
    const seen = new Set();
    let written = 0;
    for (const finding of findings) {
      if (seen.has(finding.findingKey)) continue; // idempotent per finding_key
      seen.add(finding.findingKey);
      const firstSeen = firstSeenByKey.get(finding.findingKey) ?? now;
      await client.query(
        `INSERT INTO cloud_vulnerability_findings
           (id, org_id, customer_id, connection_id, finding_key, resource_key, resource_kind,
            cve_id, package_name, installed_version, fixed_version, severity, cvss_score, source,
            status, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$16)`,
        [
          deterministicId(connectionId, finding.findingKey), orgId, customerId, connectionId,
          finding.findingKey, finding.resourceKey, finding.resourceKind, finding.cveId,
          finding.packageName, finding.installedVersion, finding.fixedVersion, finding.severity,
          finding.cvssScore, finding.source, firstSeen, now,
        ],
      );
      written += 1;
    }
    await client.query("COMMIT");
    console.log(`Ingested ${written} ${scanner.label} vulnerability finding(s) for ${connectionId} (account ${accountId})`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
