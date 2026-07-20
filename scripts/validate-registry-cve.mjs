// Live validation for registry-image CVE scanning. When a real Trivy runtime is
// present it scans a concrete image (the registry:2 image by default — the same
// image the sibling inventory validation seeds) and asserts that the output flows
// honestly through the pure normalizer: every finding carries source "trivy-image"
// and an in-range severity, the image identity resolves to a real CMDB key, and a
// disclosing coverage note is produced. When Trivy is absent it skips with a clear
// disclosure and exits 0 — no CVEs are ever fabricated.
//
// This complements scripts/validate-registry-scan.mjs (which proves tag/digest
// inventory against a live registry:2 container). Usage:
//   node scripts/validate-registry-cve.mjs [--image <ref>]
import { spawnSync } from "node:child_process";
import {
  describeTrivyImageCoverage,
  normalizeTrivyImageReport,
  resolveImageIdentity,
} from "../lib/registry-cve-normalizer.ts";

const SEVERITIES = new Set(["critical", "high", "medium", "low", "unknown"]);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : undefined;
}

function trivyAvailable() {
  const probe = spawnSync("trivy", ["--version"], { encoding: "utf8" });
  return !probe.error && (probe.status === 0 || probe.status === null);
}

const image = (arg("image") ?? "registry:2").trim();

if (!trivyAvailable()) {
  process.stdout.write("Trivy runtime not available — skipping registry CVE validation (no CVEs fabricated).\n");
  process.exit(0);
}

const scan = spawnSync("trivy", ["image", "--format", "json", "--quiet", image], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (scan.error || scan.status !== 0) {
  // Trivy is installed but could not complete the scan (e.g. no network to pull the
  // image). Disclose and skip rather than fabricate or fail an offline CI.
  process.stdout.write(`Trivy present but could not scan ${image} (${(scan.stderr || scan.error?.message || "unknown error").trim()}) — skipping with disclosure.\n`);
  process.exit(0);
}

const report = JSON.parse(scan.stdout);
const identity = resolveImageIdentity(report, image);
if (identity.resourceKey.length === 0) throw new Error("image identity did not resolve to a resource key");

const findings = normalizeTrivyImageReport(report, {
  resourceKey: identity.resourceKey,
  imageRef: image,
  imageDigest: identity.imageDigest,
});
for (const finding of findings) {
  if (finding.source !== "trivy-image") throw new Error(`finding has wrong source: ${finding.source}`);
  if (!SEVERITIES.has(finding.severity)) throw new Error(`finding has out-of-range severity: ${finding.severity}`);
  if (finding.resourceKey !== identity.resourceKey) throw new Error("finding resourceKey was not carried from the binding");
  if (finding.cvssScore !== null && !(finding.cvssScore >= 0 && finding.cvssScore <= 10)) {
    throw new Error(`finding cvssScore is out of range: ${finding.cvssScore}`);
  }
}
const coverage = describeTrivyImageCoverage(report, { imageRef: image });
process.stdout.write(`${coverage.note}\n`);
process.stdout.write(
  `Validated registry CVE normalization against a live Trivy scan of ${image}: ` +
  `${findings.length} finding(s) normalized to source trivy-image, keyed to ${identity.resourceKey}.\n`,
);
