#!/usr/bin/env node
// Rapid7 InsightVM -> unified cloud vulnerability ingest runner.
//
// Reads an InsightVM asset-vulnerability export (JSON: `{assets:[...]}` or a bare
// array of assets), normalizes it through the tested pure core
// (lib/rapid7-vuln-normalizer.ts), and upserts the source-labeled ('rapid7') result
// into cloud_vulnerability_findings — the same store /api/v1/cloud/vulnerabilities
// reads. Source-scoped: it never touches Inspector or Qualys rows. See
// scripts/scanner-vuln-ingest.mjs for the shared IO/persistence contract.
//
// Producing the export is the Rapid7-gated step, done out of band (e.g. an InsightVM
// API v3 asset/vulnerability pull converted to the accepted JSON shape).
//
// Usage:
//   node scripts/rapid7-vuln-ingest.mjs --connection conn_<hex32> --input insightvm.json
//   cat insightvm.json | node scripts/rapid7-vuln-ingest.mjs --connection conn_<hex32>
// Env: DATABASE_URL  (required to write; without it the runner normalizes and reports only)
import { normalizeRapid7Report } from "../lib/rapid7-vuln-normalizer.ts";
import { runScannerIngest } from "./scanner-vuln-ingest.mjs";

runScannerIngest({ source: "rapid7", label: "Rapid7 InsightVM", normalize: normalizeRapid7Report }).catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
