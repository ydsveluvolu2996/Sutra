#!/usr/bin/env node
// AWS Inspector -> cloud vulnerability ingest runner.
//
// Reads a raw AWS Inspector2 ListFindings export (JSON: an array of findings, or
// `{findings:[...]}`), normalizes it through the tested pure core
// (lib/cloud-vulnerability-evidence.ts), and upserts the result into the
// cloud_vulnerability_findings table for one connection — the same store the
// /api/v1/cloud/vulnerabilities queue reads. It DOES NOT touch the SHA-signed
// inventory snapshot pipeline, so it can never destabilize CMDB sync.
//
// This mirrors scripts/vuln-feed-refresh.mjs: all IO lives here; parsing and
// normalization are the tested pure core; a missing DATABASE_URL is reported and
// skipped, never faked. First-seen is preserved across runs so a persisting CVE
// keeps its true age; a finding absent from the new export is removed (resolved).
//
// Producing the export is the AWS-gated step, done out of band, e.g.:
//   aws inspector2 list-findings \
//     --filter-criteria '{"awsAccountId":[{"comparison":"EQUALS","value":"<ACCOUNT>"}]}' \
//     > findings.json
//
// Usage:
//   node scripts/inspector-vuln-ingest.mjs --connection conn_<hex32> --input findings.json [--partition aws]
// Env: DATABASE_URL  (required to write; without it the runner normalizes and reports only)
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeInspectorFindingsForStorage } from "../lib/cloud-vulnerability-evidence.ts";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function arg(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index !== -1 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : undefined;
}

function deterministicId(connectionId, findingKey) {
  return `cvf_${createHash("sha256").update(`${connectionId} ${findingKey}`, "utf8").digest("hex").slice(0, 48)}`;
}

async function main() {
  const connectionId = (arg("connection") ?? "").trim();
  if (!CONNECTION_ID.test(connectionId)) throw new Error("--connection conn_<hex32> is required");
  const inputPath = arg("input");
  if (typeof inputPath !== "string") throw new Error("--input <findings.json> is required");
  const partition = (arg("partition") ?? "aws").trim();

  const raw = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  const rawFindings = Array.isArray(raw) ? raw : Array.isArray(raw?.findings) ? raw.findings : [];
  if (rawFindings.length === 0) console.warn("No Inspector findings in the input (nothing to ingest)");

  const databaseUrl = (process.env.DATABASE_URL ?? process.env.SUTRA_MIGRATOR_DATABASE_URL ?? "").trim();
  if (databaseUrl.length === 0) {
    // Without a database we can still prove the normalization is honest.
    const preview = normalizeInspectorFindingsForStorage(rawFindings, { accountId: "000000000000", partition });
    console.warn(`DATABASE_URL not set — normalized ${preview.length} finding(s) but skipped the DB write`);
    return;
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, application_name: "sutra-inspector-vuln", max: 1, connectionTimeoutMillis: 15_000 });
  const client = await pool.connect();
  try {
    // Resolve the tenant + account from the connection itself, so the runner
    // cannot write findings into the wrong tenant.
    const connection = await client.query(
      "SELECT org_id, customer_id, aws_account_id FROM aws_connections WHERE id = $1 LIMIT 1",
      [connectionId],
    );
    if (connection.rowCount === 0) throw new Error(`Connection ${connectionId} not found`);
    const { org_id: orgId, customer_id: customerId, aws_account_id: accountId } = connection.rows[0];

    const findings = normalizeInspectorFindingsForStorage(rawFindings, { accountId, partition });
    const now = Date.now();

    await client.query("BEGIN");
    // Preserve first-seen for persisting findings.
    const existing = await client.query(
      "SELECT finding_key, first_seen_at FROM cloud_vulnerability_findings WHERE connection_id = $1",
      [connectionId],
    );
    const firstSeenByKey = new Map(existing.rows.map((row) => [row.finding_key, Number(row.first_seen_at)]));
    await client.query(
      "DELETE FROM cloud_vulnerability_findings WHERE connection_id = $1 AND org_id = $2 AND customer_id = $3",
      [connectionId, orgId, customerId],
    );
    const seen = new Set();
    let written = 0;
    for (const finding of findings) {
      if (seen.has(finding.findingKey)) continue;
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
    console.log(`Ingested ${written} cloud vulnerability finding(s) for ${connectionId} (account ${accountId})`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
