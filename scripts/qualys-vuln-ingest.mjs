#!/usr/bin/env node
// Qualys VM/VMDR -> unified cloud vulnerability ingest runner.
//
// Reads a Qualys host-detection export (JSON: `{hosts:[...]}` or a bare array of
// hosts), normalizes it through the tested pure core (lib/qualys-vuln-normalizer.ts),
// and upserts the source-labeled ('qualys') result into cloud_vulnerability_findings
// — the same store /api/v1/cloud/vulnerabilities reads. Source-scoped: it never
// touches Inspector or Rapid7 rows. See scripts/scanner-vuln-ingest.mjs for the
// shared IO/persistence contract.
//
// Producing the export is the Qualys-gated step, done out of band (e.g. a VMDR Host
// List Detection API pull converted to the accepted JSON shape).
//
// Usage:
//   node scripts/qualys-vuln-ingest.mjs --connection conn_<hex32> --input qualys.json
//   cat qualys.json | node scripts/qualys-vuln-ingest.mjs --connection conn_<hex32>
// Env: DATABASE_URL  (required to write; without it the runner normalizes and reports only)
import { normalizeQualysReport } from "../lib/qualys-vuln-normalizer.ts";
import { runScannerIngest } from "./scanner-vuln-ingest.mjs";

runScannerIngest({ source: "qualys", label: "Qualys", normalize: normalizeQualysReport }).catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
