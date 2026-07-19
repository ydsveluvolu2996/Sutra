import type { KubernetesAttackPath } from "./kubernetes-attack-paths.ts";

export type RiskSeverity = "critical" | "high" | "medium" | "low";
export type RiskSource = "attack_path" | "posture" | "scanner";

export interface RiskPostureInput {
  readonly controlId: string;
  readonly subject: string;
  readonly state: "PASS" | "FAIL" | "UNKNOWN";
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly message: string;
}

export interface RiskScannerInput {
  readonly fingerprint: string;
  readonly severity: "critical" | "high" | "medium" | "low" | "unknown";
  readonly title: string;
  readonly cveId: string | null;
  readonly checkId: string | null;
  readonly fixedVersion: string | null;
  readonly packageName: string | null;
  readonly affectedResource: {
    readonly namespace: string | null;
    readonly name: string | null;
  };
}

export interface RiskQueueItem {
  readonly id: string;
  readonly source: RiskSource;
  readonly title: string;
  readonly subject: string;
  readonly severity: RiskSeverity;
  readonly blastRadius: number;
  readonly priority: number;
  readonly recommendation: string;
  readonly evidenceRef: string;
}

export interface RiskQueueSummary {
  readonly schema: "sutra.kubernetes-risk-queue.v1";
  readonly items: readonly RiskQueueItem[];
  readonly totals: Readonly<Record<RiskSeverity, number>> & { readonly items: number };
  readonly disclaimer: string;
}

const SEVERITY_WEIGHT: Readonly<Record<RiskSeverity, number>> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 15,
};

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const MAX_BLAST_BONUS = 40;
const BLAST_BONUS_PER_RESOURCE = 5;

const RISK_QUEUE_DISCLAIMER =
  "Priority ranks observed evidence by severity and blast radius; it is a " +
  "triage aid, not proof of exploitability. Every item links to stored evidence.";

function normalizeSeverity(value: string): RiskSeverity {
  switch (value.toLocaleLowerCase("en-US")) {
    case "critical": return "critical";
    case "high": return "high";
    case "medium": return "medium";
    default: return "low";
  }
}

// Priority is severity weight plus a bounded blast-radius bonus. Attack paths
// also fold in their own deterministic score so a broad, well-evidenced path
// outranks an isolated finding of the same severity.
function priorityScore(input: {
  readonly severity: RiskSeverity;
  readonly blastRadius: number;
  readonly pathScore?: number;
}): number {
  const blastBonus = Math.min(MAX_BLAST_BONUS, input.blastRadius * BLAST_BONUS_PER_RESOURCE);
  const pathBonus = input.pathScore === undefined ? 0 : Math.round(input.pathScore * 0.5);
  return SEVERITY_WEIGHT[input.severity] + blastBonus + pathBonus;
}

export function buildKubernetesRiskQueue(input: {
  readonly attackPaths: readonly KubernetesAttackPath[];
  readonly postureFindings: readonly RiskPostureInput[];
  readonly scannerFindings: readonly RiskScannerInput[];
}): RiskQueueSummary {
  const items: RiskQueueItem[] = [];

  for (const path of input.attackPaths) {
    const blastRadius = path.blastRadius.length;
    items.push({
      id: `path:${path.id}`,
      source: "attack_path",
      title: path.title,
      subject: path.nodes.at(-1)?.label ?? path.nodes[0]?.label ?? "cluster",
      severity: path.risk,
      blastRadius,
      priority: priorityScore({ severity: path.risk, blastRadius, pathScore: path.score }),
      recommendation: path.remediations[0]?.guidance ??
        "Review the cited attack-path evidence and break the earliest edge.",
      evidenceRef: `attack-path/${path.id}`,
    });
  }

  for (const finding of input.postureFindings) {
    if (finding.state !== "FAIL") continue;
    const severity = normalizeSeverity(finding.severity);
    items.push({
      id: `posture:${finding.controlId}:${finding.subject}`,
      source: "posture",
      title: finding.controlId,
      subject: finding.subject,
      severity,
      blastRadius: 0,
      priority: priorityScore({ severity, blastRadius: 0 }),
      recommendation: finding.message,
      evidenceRef: `posture/${finding.controlId}`,
    });
  }

  for (const finding of input.scannerFindings) {
    if (finding.severity === "unknown") continue;
    const severity = normalizeSeverity(finding.severity);
    const subject = `${finding.affectedResource.namespace ?? "cluster"}/${finding.affectedResource.name ?? "workload"}`;
    items.push({
      id: `scanner:${finding.fingerprint}`,
      source: "scanner",
      title: finding.cveId ?? finding.checkId ?? finding.title,
      subject,
      severity,
      blastRadius: 0,
      priority: priorityScore({ severity, blastRadius: 0 }),
      recommendation: finding.fixedVersion
        ? `Upgrade ${finding.packageName ?? "the affected package"} to ${finding.fixedVersion} or later, then rescan.`
        : "Review the scanner evidence and vendor advisory, then rescan.",
      evidenceRef: `scanner/${finding.fingerprint}`,
    });
  }

  items.sort((left, right) =>
    right.priority - left.priority ||
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    right.blastRadius - left.blastRadius ||
    left.title.localeCompare(right.title, "en-US") ||
    left.id.localeCompare(right.id, "en-US"));

  const totals = { critical: 0, high: 0, medium: 0, low: 0, items: items.length };
  for (const item of items) totals[item.severity] += 1;

  return {
    schema: "sutra.kubernetes-risk-queue.v1",
    items,
    totals,
    disclaimer: RISK_QUEUE_DISCLAIMER,
  };
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toRiskQueueCsv(summary: RiskQueueSummary): string {
  const header = ["priority", "severity", "source", "title", "subject", "blast_radius", "recommendation", "evidence_ref"];
  const rows = summary.items.map((item) => [
    item.priority,
    item.severity,
    item.source,
    item.title,
    item.subject,
    item.blastRadius,
    item.recommendation,
    item.evidenceRef,
  ].map(csvCell).join(","));
  return [header.join(","), ...rows].join("\r\n");
}
