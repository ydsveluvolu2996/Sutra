import { canonicalJson } from "./canonical-json.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const POLICY_REPORT_API = "wgpolicyk8s.io/v1alpha2";
const MAX_RESULTS = 10_000;
const MAX_RESOURCES_PER_RESULT = 16;

export type KubernetesAdmissionMode = "audit" | "enforce";
export type KubernetesPolicyResultState = "PASS" | "FAIL" | "WARN" | "ERROR" | "SKIP";
export type KubernetesPolicySeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface KubernetesPolicyResource {
  readonly apiVersion: string | null;
  readonly kind: string;
  readonly namespace: string | null;
  readonly name: string;
  readonly uid: string | null;
}

export interface KubernetesPolicyResult {
  readonly policy: string;
  readonly rule: string;
  readonly state: KubernetesPolicyResultState;
  readonly severity: KubernetesPolicySeverity;
  readonly category: string | null;
  readonly source: string;
  readonly timestamp: string | null;
  readonly resources: readonly KubernetesPolicyResource[];
}

export interface KubernetesAdmissionEvidence {
  readonly schemaVersion: "sutra.kubernetes-admission.v1";
  readonly source: "KYVERNO_POLICY_REPORT";
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly mode: KubernetesAdmissionMode;
  readonly reportKind: "PolicyReport" | "ClusterPolicyReport";
  readonly reportNamespace: string | null;
  readonly reportName: string;
  readonly summary: Readonly<Record<KubernetesPolicyResultState, number>>;
  readonly results: readonly KubernetesPolicyResult[];
  readonly evidenceSha256: string;
  readonly limitations: readonly [
    "POLICY_REPORT_IS_POINT_IN_TIME",
    "MESSAGE_AND_RAW_RESOURCE_CONTENT_NOT_RETAINED",
    "BLOCKING_REQUIRES_SEPARATE_ADMISSION_DECISION_EVIDENCE",
  ];
}

export class KubernetesAdmissionEvidenceError extends Error {
  public readonly code = "INVALID_ADMISSION_EVIDENCE";

  public constructor() {
    super("Kubernetes admission evidence was rejected");
    this.name = "KubernetesAdmissionEvidenceError";
  }
}

function invalid(): never {
  throw new KubernetesAdmissionEvidenceError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) invalid();
  return value;
}

function identifier(value: unknown): string {
  const parsed = boundedText(value, 254);
  if (!IDENTIFIER.test(parsed)) invalid();
  return parsed;
}

function nullableIdentifier(value: unknown): string | null {
  return value === undefined || value === null ? null : identifier(value);
}

function nullableText(value: unknown, maximum: number): string | null {
  return value === undefined || value === null ? null : boundedText(value, maximum);
}

function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const seconds = (value as Record<string, unknown>).seconds;
    if (typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0) {
      return new Date(seconds * 1_000).toISOString();
    }
  }
  const parsed = boundedText(value, 40);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds)) invalid();
  return new Date(milliseconds).toISOString();
}

function state(value: unknown): KubernetesPolicyResultState {
  if (typeof value !== "string") invalid();
  const normalized = value.toLowerCase();
  if (normalized === "pass") return "PASS";
  if (normalized === "fail") return "FAIL";
  if (normalized === "warn") return "WARN";
  if (normalized === "error") return "ERROR";
  if (normalized === "skip") return "SKIP";
  return invalid();
}

function severity(value: unknown): KubernetesPolicySeverity {
  if (value === undefined || value === null || value === "") return "unknown";
  if (typeof value !== "string") invalid();
  const normalized = value.toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return "unknown";
}

function resource(value: unknown): KubernetesPolicyResource {
  const parsed = record(value);
  return {
    apiVersion: nullableText(parsed.apiVersion, 253),
    kind: identifier(parsed.kind),
    namespace: nullableIdentifier(parsed.namespace),
    name: identifier(parsed.name),
    uid: nullableIdentifier(parsed.uid),
  };
}

function result(value: unknown): KubernetesPolicyResult {
  const parsed = record(value);
  if (!Array.isArray(parsed.resources) || parsed.resources.length > MAX_RESOURCES_PER_RESULT) invalid();
  return {
    policy: identifier(parsed.policy),
    rule: identifier(parsed.rule),
    state: state(parsed.result),
    severity: severity(parsed.severity),
    category: nullableText(parsed.category, 128),
    source: identifier(parsed.source),
    timestamp: timestamp(parsed.timestamp),
    resources: parsed.resources.map(resource),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Sanitizes PolicyReport/ClusterPolicyReport evidence. Raw messages, resource
 * manifests, admission requests, usernames and Secret content are deliberately
 * excluded even when the upstream report happens to contain them.
 */
export async function normalizeKyvernoPolicyReport(input: {
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly mode: KubernetesAdmissionMode;
  readonly report: unknown;
}): Promise<KubernetesAdmissionEvidence> {
  const report = record(input.report);
  if (report.apiVersion !== POLICY_REPORT_API) invalid();
  if (report.kind !== "PolicyReport" && report.kind !== "ClusterPolicyReport") invalid();
  const reportKind: "PolicyReport" | "ClusterPolicyReport" = report.kind;
  if (!Array.isArray(report.results) || report.results.length > MAX_RESULTS) invalid();
  const metadata = record(report.metadata);
  const normalizedResults = report.results.map(result);
  const summary: Record<KubernetesPolicyResultState, number> = {
    PASS: 0,
    FAIL: 0,
    WARN: 0,
    ERROR: 0,
    SKIP: 0,
  };
  for (const item of normalizedResults) summary[item.state] += 1;
  const normalized = {
    schemaVersion: "sutra.kubernetes-admission.v1" as const,
    source: "KYVERNO_POLICY_REPORT" as const,
    clusterId: identifier(input.clusterId),
    collectedAt: new Date(timestamp(input.collectedAt) ?? invalid()).toISOString(),
    mode: input.mode,
    reportKind,
    reportNamespace: reportKind === "PolicyReport" ? identifier(metadata.namespace) : null,
    reportName: identifier(metadata.name),
    summary,
    results: normalizedResults,
    limitations: [
      "POLICY_REPORT_IS_POINT_IN_TIME",
      "MESSAGE_AND_RAW_RESOURCE_CONTENT_NOT_RETAINED",
      "BLOCKING_REQUIRES_SEPARATE_ADMISSION_DECISION_EVIDENCE",
    ] as const,
  };
  return {
    ...normalized,
    evidenceSha256: await sha256(canonicalJson(normalized)),
  };
}
