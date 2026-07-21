// Pure normalizer for a Rapid7 InsightVM asset-vulnerability export into the unified
// cloud-vulnerability finding model, so InsightVM CVEs compose with AWS Inspector,
// Qualys, and the container/Kubernetes sides of the vulnerability graph in the SAME
// queue. It performs no I/O: it accepts an already-parsed InsightVM export object
// and returns storable rows plus an honest reject ledger; it touches no network,
// filesystem, clock, or randomness.
//
// The severity/score/fix/id honesty rules are NOT re-implemented here — the
// building blocks are imported verbatim from vulnerability-finding.ts so Rapid7
// findings obey exactly the same guarantees as every other source:
//   * InsightVM's three-tier textual severity maps Critical->critical,
//     Severe->high, Moderate->medium via an explicit, documented table; standard
//     terms fall back to the shared normalizeSeverity, and anything unmapped is
//     'unknown', never a fabricated 'low'.
//   * a missing fixed version is null (fix UNKNOWN, not 'no fix'); cvssScore is
//     only a numeric CVSS v3/v2 base score InsightVM actually supplied (a CVSS
//     vector is never parsed into a number);
//   * each CVE InsightVM referenced becomes its own finding so EPSS/KEV enrichment
//     works per CVE. A vulnerability with no CVE reference keeps its InsightVM
//     vuln id (e.g. "ssl-cve-2016-2183-sweet32") in aliases with cveId=null — a
//     CVE is NEVER fabricated.
//
// Malformed rows are rejected and disclosed: an asset with no usable identifier, or
// a vulnerability with no InsightVM id, is reported in `rejects` with a cited
// reason. The resourceKey is taken verbatim from whatever asset identifier InsightVM
// reported and is never synthesized.
import {
  asArray,
  bestBaseScore,
  buildFinding,
  isRecord,
  mergeVulnerabilityFindings,
  normalizeSeverity,
  readBaseScore,
  readString,
  splitIds,
  type VulnerabilityFinding,
  type VulnSeverity,
} from "./vulnerability-finding.ts";
import type { CloudVulnerabilityFindingInput } from "../db/cloud-vulnerability-repository.ts";

export const RAPID7_SOURCE = "rapid7" as const;
export const RAPID7_RESOURCE_KIND = "asset";

// InsightVM's native textual severity is a three-tier scale; map it to the unified
// qualitative scale explicitly rather than guessing:
//   Critical -> critical, Severe -> high, Moderate -> medium.
// Standard critical/high/medium/low terms are handled by the shared normalizer.
const RAPID7_SEVERITY: Readonly<Record<string, VulnSeverity>> = {
  critical: "critical", severe: "high", moderate: "medium",
};

export const RAPID7_DISCLAIMER =
  "Rapid7 findings are the vulnerabilities an InsightVM scan actually reported per " +
  "asset, each labeled source 'rapid7' and keyed to the asset identifier InsightVM " +
  "named (host name, IP, or asset id — verbatim, never synthesized). InsightVM's " +
  "three-tier severity maps Critical->critical, Severe->high, Moderate->medium; an " +
  "unmapped or missing severity is 'unknown', never downgraded to a fabricated 'low'. " +
  "A missing fixed version is null (fix UNKNOWN, not 'no fix') and cvssScore is only a " +
  "numeric CVSS v3/v2 base score InsightVM supplied — a vector string is never parsed " +
  "into one. Each CVE a vulnerability references becomes its own finding so EPSS/KEV " +
  "enrichment works; a vulnerability with no CVE keeps its InsightVM id in aliases " +
  "with cveId=null and a CVE is never invented. Absence of a finding reflects " +
  "InsightVM's scan coverage, not proof an asset is clean. Assets with no identifier " +
  "and vulnerabilities with no id are rejected and disclosed, never coerced.";

export interface Rapid7Reject {
  readonly kind: "asset-without-identifier" | "vulnerability-without-id" | "not-a-record";
  readonly locator: string;
}

export interface Rapid7NormalizeResult {
  readonly findings: readonly CloudVulnerabilityFindingInput[];
  readonly rejects: readonly Rapid7Reject[];
  readonly disclaimer: string;
}

const SEP = " ";

// Prefix the persisted finding_key with the source so a Rapid7 row can never
// collide with an Inspector or Qualys row that shares the same (resource, CVE,
// package) on the unique (connection_id, finding_key) index.
export function rapid7FindingKey(finding: {
  readonly resourceKey: string;
  readonly cveId: string | null;
  readonly packageName: string | null;
}): string {
  return `${RAPID7_SOURCE}${SEP}${finding.resourceKey}${SEP}${finding.cveId ?? ""}${SEP}${finding.packageName ?? ""}`;
}

// The stable CMDB key for an asset: the most specific identifier InsightVM
// reported, verbatim. Never synthesized — an asset with none is rejected.
function assetResourceKey(asset: Record<string, unknown>): string | null {
  return (
    readString(asset.hostName) ??
    readString(asset.hostname) ??
    readString(asset.fqdn) ??
    readString(asset.ip) ??
    readString(asset.ipAddress) ??
    (typeof asset.id === "number" && Number.isFinite(asset.id) ? String(asset.id) : readString(asset.id)) ??
    readString(asset.assetId)
  );
}

function rapid7Severity(raw: unknown): VulnSeverity {
  const text = readString(raw);
  if (text === null) return "unknown";
  return RAPID7_SEVERITY[text.toLowerCase()] ?? normalizeSeverity(text);
}

// Every CVE string a vulnerability references. InsightVM shapes seen in the wild:
// a `cves` array of strings, or a `references` array of { source, reference } where
// CVEs have source "CVE" (also accepts { name }/plain strings). Non-CVE references
// (BID, URL, ...) are ignored here; the InsightVM vuln id carries the identity.
function cveCandidates(vulnerability: Record<string, unknown>): readonly string[] {
  const seen: string[] = [];
  const push = (value: unknown): void => {
    const text = readString(value);
    if (text !== null && !seen.includes(text)) seen.push(text);
  };
  for (const value of asArray(vulnerability.cves)) push(value);
  push(vulnerability.cve);
  for (const rawRef of asArray(vulnerability.references)) {
    if (readString(rawRef) !== null) { push(rawRef); continue; }
    if (!isRecord(rawRef)) continue;
    const source = readString(rawRef.source);
    if (source !== null && source.toUpperCase() !== "CVE") continue;
    push(rawRef.reference ?? rawRef.id ?? rawRef.name);
  }
  return seen;
}

// The InsightVM vulnerability id, e.g. "ssl-cve-2016-2183-sweet32". It is the
// detection identity and is required; a vulnerability without one is rejected.
function vulnerabilityId(vulnerability: Record<string, unknown>): string | null {
  return readString(vulnerability.id) ?? readString(vulnerability.vulnerabilityId) ?? readString(vulnerability.nexposeId);
}

// Read a numeric CVSS base score, preferring v3 over v2, from the shapes an
// InsightVM export may carry. Only a genuine 0..10 number is accepted.
function cvssOf(vulnerability: Record<string, unknown>): number | null {
  const cvss = isRecord(vulnerability.cvss) ? vulnerability.cvss : {};
  const v3 = isRecord(cvss.v3) ? cvss.v3 : isRecord(vulnerability.cvssV3) ? vulnerability.cvssV3 : {};
  const v2 = isRecord(cvss.v2) ? cvss.v2 : isRecord(vulnerability.cvssV2) ? vulnerability.cvssV2 : {};
  return (
    readBaseScore(vulnerability.cvssV3Score) ??
    readBaseScore(v3.score) ??
    readBaseScore(cvss.v3Score) ??
    readBaseScore(vulnerability.cvssV2Score) ??
    readBaseScore(v2.score) ??
    readBaseScore(cvss.v2Score) ??
    readBaseScore(vulnerability.cvssScore) ??
    // A flat numeric `cvss` value (not the nested object) is a last resort.
    bestBaseScore([vulnerability], (entry) => entry.cvss)
  );
}

/**
 * Normalize a parsed Rapid7 InsightVM export into storable, deduped cloud-
 * vulnerability rows plus an honest reject ledger. Deterministic and pure.
 *
 * Accepted shape: `{ assets: [ { <identifier fields>, vulnerabilities: [ { id,
 * severity, cves | references, cvss?, packageName?, installedVersion?,
 * fixedVersion? } ] } ] }`. A bare array of assets is also accepted.
 */
export function normalizeRapid7Report(report: unknown): Rapid7NormalizeResult {
  const root = isRecord(report) ? report : {};
  const assets = Array.isArray(report)
    ? report
    : asArray(root.assets).length > 0
      ? asArray(root.assets)
      : asArray(root.resources);
  const rejects: Rapid7Reject[] = [];
  const normalized: VulnerabilityFinding[] = [];

  for (const rawAsset of assets) {
    if (!isRecord(rawAsset)) {
      rejects.push({ kind: "not-a-record", locator: "asset" });
      continue;
    }
    const resourceKey = assetResourceKey(rawAsset);
    if (resourceKey === null) {
      rejects.push({ kind: "asset-without-identifier", locator: "asset" });
      continue;
    }
    const vulnerabilities = asArray(rawAsset.vulnerabilities).length > 0
      ? asArray(rawAsset.vulnerabilities)
      : asArray(rawAsset.vulns);
    for (const rawVuln of vulnerabilities) {
      if (!isRecord(rawVuln)) {
        rejects.push({ kind: "not-a-record", locator: `${resourceKey} vulnerability` });
        continue;
      }
      const nativeId = vulnerabilityId(rawVuln);
      if (nativeId === null) {
        rejects.push({ kind: "vulnerability-without-id", locator: `${resourceKey} vulnerability` });
        continue;
      }
      const severity = rapid7Severity(rawVuln.severity);
      const cvssScore = cvssOf(rawVuln);
      const packageName = readString(rawVuln.packageName) ?? readString(rawVuln.package);
      const installedVersion = readString(rawVuln.installedVersion) ?? readString(rawVuln.version);
      const fixedVersion = readString(rawVuln.fixedVersion) ?? readString(rawVuln.fixVersion);

      const cves = cveCandidates(rawVuln);
      const idGroups = cves.length > 0
        ? cves.map((cve) => splitIds(cve, [nativeId]))
        : [splitIds(null, [nativeId])];
      for (const { cveId, aliases } of idGroups) {
        normalized.push(buildFinding(
          { resourceKey, resourceKind: RAPID7_RESOURCE_KIND, tenant: null, firstSeenMs: null },
          RAPID7_SOURCE,
          { cveId, aliases, packageName, installedVersion, fixedVersion, severity, cvssScore },
        ));
      }
    }
  }

  const findings = mergeVulnerabilityFindings(normalized).map((finding) => ({
    findingKey: rapid7FindingKey(finding),
    resourceKey: finding.resourceKey,
    resourceKind: finding.resourceKind,
    cveId: finding.cveId,
    packageName: finding.packageName,
    installedVersion: finding.installedVersion,
    fixedVersion: finding.fixedVersion,
    severity: finding.severity,
    cvssScore: finding.cvssScore,
    source: RAPID7_SOURCE,
  }));

  return { findings, rejects, disclaimer: RAPID7_DISCLAIMER };
}
