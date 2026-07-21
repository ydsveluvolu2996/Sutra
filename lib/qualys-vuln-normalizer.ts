// Pure normalizer for a Qualys VM / VMDR host-detection export into the unified
// cloud-vulnerability finding model, so Qualys CVEs compose with AWS Inspector and
// the container/Kubernetes sides of the vulnerability graph in the SAME queue. It
// performs no I/O: it accepts an already-parsed Qualys export object and returns
// storable rows plus an honest reject ledger; it touches no network, filesystem,
// clock, or randomness.
//
// The severity/score/fix/id honesty rules are NOT re-implemented here — the
// building blocks are imported verbatim from vulnerability-finding.ts so Qualys
// findings obey exactly the same guarantees as every other source:
//   * severity is mapped from Qualys' own 1..5 level via an explicit, documented
//     table; an out-of-range or missing level is 'unknown', never a fabricated
//     'low'. A textual severity falls back to the shared normalizeSeverity.
//   * a missing fixed version is null (fix UNKNOWN, not 'no fix'); cvssScore is
//     only a numeric base score Qualys actually supplied (a CVSS vector is never
//     parsed into a number);
//   * the QID is the detection id; each CVE Qualys attached to a QID becomes its
//     own finding so EPSS/KEV enrichment works per CVE. A QID with no CVE keeps
//     the QID in aliases with cveId=null — a CVE is NEVER fabricated.
//
// Malformed rows are rejected and disclosed, never silently dropped and never
// coerced into a finding: a host with no usable identifier, or a detection with no
// QID, is reported in `rejects` with a cited reason. The resourceKey is taken
// verbatim from whatever host identifier Qualys reported and is never synthesized.
import {
  asArray,
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

export const QUALYS_SOURCE = "qualys" as const;
export const QUALYS_RESOURCE_KIND = "host";

// Qualys assigns each detection a severity level 1..5. The mapping to the unified
// qualitative scale is fixed and disclosed rather than guessed per-run:
//   5 Urgent -> critical, 4 Critical -> high, 3 Serious -> medium,
//   2 Medium -> low, 1 Minimal -> low. Anything outside 1..5 is 'unknown'.
const QUALYS_LEVEL: Readonly<Record<number, VulnSeverity>> = {
  5: "critical", 4: "high", 3: "medium", 2: "low", 1: "low",
};

export const QUALYS_DISCLAIMER =
  "Qualys findings are the detections a Qualys VM/VMDR scan actually reported, each " +
  "labeled source 'qualys' and keyed to the host identifier Qualys named (FQDN, DNS " +
  "name, IP, or asset id — verbatim, never synthesized). Qualys severity levels map " +
  "5->critical, 4->high, 3->medium, 2->low, 1->low; an out-of-range or missing level " +
  "is 'unknown', never downgraded to a fabricated 'low'. A missing fixed version is " +
  "null (fix UNKNOWN, not 'no fix') and cvssScore is only a numeric base score Qualys " +
  "supplied — a CVSS vector string is never parsed into one. Each CVE a QID carries " +
  "becomes its own finding so EPSS/KEV enrichment works; a QID with no CVE keeps the " +
  "QID in aliases with cveId=null and a CVE is never invented. Absence of a detection " +
  "reflects Qualys' scan coverage, not proof a host is clean. Hosts with no identifier " +
  "and detections with no QID are rejected and disclosed, never coerced into findings.";

export interface QualysReject {
  /** The record kind that failed: a host with no id, or a detection with no QID. */
  readonly kind: "host-without-identifier" | "detection-without-qid" | "not-a-record";
  /** A stable, non-fabricated locator for the rejected record (best-effort). */
  readonly locator: string;
}

export interface QualysNormalizeResult {
  readonly findings: readonly CloudVulnerabilityFindingInput[];
  readonly rejects: readonly QualysReject[];
  readonly disclaimer: string;
}

const SEP = " ";

// Prefix the persisted finding_key with the source so a Qualys row can never
// collide with an Inspector or Rapid7 row that happens to share the same
// (resource, CVE, package) on the unique (connection_id, finding_key) index.
export function qualysFindingKey(finding: {
  readonly resourceKey: string;
  readonly cveId: string | null;
  readonly packageName: string | null;
}): string {
  return `${QUALYS_SOURCE}${SEP}${finding.resourceKey}${SEP}${finding.cveId ?? ""}${SEP}${finding.packageName ?? ""}`;
}

// The stable CMDB key for a host: the most specific identifier Qualys reported,
// verbatim. Never synthesized — a host with none is rejected, not keyed to a guess.
function hostResourceKey(host: Record<string, unknown>): string | null {
  return (
    readString(host.fqdn) ??
    readString(host.dnsName) ??
    readString(host.dns) ??
    readString(host.netbiosName) ??
    readString(host.ip) ??
    readString(host.ipAddress) ??
    (typeof host.id === "number" && Number.isFinite(host.id) ? String(host.id) : readString(host.id)) ??
    readString(host.assetId)
  );
}

// Qualys level is a small integer; accept it as a number or a numeric string, and
// fall back to the shared textual normalizer for exports that carry words instead.
function qualysSeverity(raw: unknown): VulnSeverity {
  if (typeof raw === "number" && Number.isInteger(raw)) return QUALYS_LEVEL[raw] ?? "unknown";
  const text = readString(raw);
  if (text === null) return "unknown";
  if (/^[0-9]+$/u.test(text)) {
    const level = Number(text);
    return QUALYS_LEVEL[level] ?? "unknown";
  }
  return normalizeSeverity(text);
}

// Every CVE string Qualys attached to a detection, in a couple of shapes seen in
// the wild: a `cveIds`/`cves` array, or a single `cveId`. Non-strings are skipped.
function cveCandidates(detection: Record<string, unknown>): readonly string[] {
  const raw = [
    ...asArray(detection.cveIds),
    ...asArray(detection.cves),
    detection.cveId,
    detection.cve,
  ];
  const seen: string[] = [];
  for (const value of raw) {
    const text = readString(value);
    if (text !== null && !seen.includes(text)) seen.push(text);
  }
  return seen;
}

function qidLocator(detection: Record<string, unknown>): string {
  const qid = detection.qid ?? detection.QID;
  if (typeof qid === "number" && Number.isFinite(qid)) return `qid:${qid}`;
  const text = readString(qid);
  return text === null ? "qid:unknown" : `qid:${text}`;
}

function qidId(detection: Record<string, unknown>): string | null {
  const qid = detection.qid ?? detection.QID;
  if (typeof qid === "number" && Number.isInteger(qid)) return `QID-${qid}`;
  const text = readString(qid);
  if (text === null) return null;
  return /^[0-9]+$/u.test(text) ? `QID-${text}` : text;
}

// Read a numeric CVSS base score from any of the fields a Qualys export may carry;
// only a genuine 0..10 number is accepted, a vector string is never parsed.
function cvssOf(detection: Record<string, unknown>): number | null {
  return (
    readBaseScore(detection.cvss3Base) ??
    readBaseScore(detection.cvss3_base) ??
    readBaseScore(detection.cvssBase) ??
    readBaseScore(detection.cvss_base) ??
    readBaseScore(detection.cvss)
  );
}

/**
 * Normalize a parsed Qualys VM/VMDR host-detection export into storable, deduped
 * cloud-vulnerability rows plus an honest reject ledger. Deterministic and pure.
 *
 * Accepted shape: `{ hosts: [ { <identifier fields>, detections: [ { qid, severity,
 * cveIds, cvssBase?, packageName?, installedVersion?, fixedVersion? } ] } ] }`. A
 * bare array of hosts is also accepted.
 */
export function normalizeQualysReport(report: unknown): QualysNormalizeResult {
  const root = isRecord(report) ? report : {};
  const hosts = Array.isArray(report) ? report : asArray(root.hosts);
  const rejects: QualysReject[] = [];
  const normalized: VulnerabilityFinding[] = [];

  for (const rawHost of hosts) {
    if (!isRecord(rawHost)) {
      rejects.push({ kind: "not-a-record", locator: "host" });
      continue;
    }
    const resourceKey = hostResourceKey(rawHost);
    if (resourceKey === null) {
      rejects.push({ kind: "host-without-identifier", locator: "host" });
      continue;
    }
    for (const rawDetection of asArray(rawHost.detections)) {
      if (!isRecord(rawDetection)) {
        rejects.push({ kind: "not-a-record", locator: `${resourceKey} detection` });
        continue;
      }
      const nativeId = qidId(rawDetection);
      if (nativeId === null) {
        rejects.push({ kind: "detection-without-qid", locator: `${resourceKey} ${qidLocator(rawDetection)}` });
        continue;
      }
      const severity = qualysSeverity(rawDetection.severity);
      const cvssScore = cvssOf(rawDetection);
      const packageName = readString(rawDetection.packageName) ?? readString(rawDetection.package);
      const installedVersion = readString(rawDetection.installedVersion) ?? readString(rawDetection.version);
      // A fixed version is carried only when Qualys structured it; free-text
      // "Solution"/"Results" prose is never parsed into a version.
      const fixedVersion = readString(rawDetection.fixedVersion) ?? readString(rawDetection.fixVersion);

      const cves = cveCandidates(rawDetection);
      // One finding per CVE (so enrichment is per-CVE); a QID with no CVE keeps the
      // QID id in aliases with cveId=null — never a fabricated CVE.
      const idGroups = cves.length > 0
        ? cves.map((cve) => splitIds(cve, [nativeId]))
        : [splitIds(null, [nativeId])];
      for (const { cveId, aliases } of idGroups) {
        normalized.push(buildFinding(
          { resourceKey, resourceKind: QUALYS_RESOURCE_KIND, tenant: null, firstSeenMs: null },
          QUALYS_SOURCE,
          { cveId, aliases, packageName, installedVersion, fixedVersion, severity, cvssScore },
        ));
      }
    }
  }

  // Merge collapses the same CVE+package on the same host (e.g. two QIDs sharing a
  // CVE) into one row, keeping the most severe / most complete observation.
  const findings = mergeVulnerabilityFindings(normalized).map((finding) => ({
    findingKey: qualysFindingKey(finding),
    resourceKey: finding.resourceKey,
    resourceKind: finding.resourceKind,
    cveId: finding.cveId,
    packageName: finding.packageName,
    installedVersion: finding.installedVersion,
    fixedVersion: finding.fixedVersion,
    severity: finding.severity,
    cvssScore: finding.cvssScore,
    source: QUALYS_SOURCE,
  }));

  return { findings, rejects, disclaimer: QUALYS_DISCLAIMER };
}
