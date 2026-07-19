// Pre-deploy IaC misconfiguration scanner: a bounded, deterministic rule engine
// over an already-NORMALIZED set of infrastructure-as-code resources. The caller
// parses raw HCL/YAML and hands over typed resources; this engine never touches
// raw source, state, the filesystem, the network, the clock, or randomness. Each
// rule inspects one documented config field and reports a finding only when that
// field is present and unsafe. Two honesty rules set it apart from a scanner that
// assumes a default:
//   * A rule fires ONLY on evidence: the specific field it inspects must be
//     present and unsafe. A present-but-safe field passes silently and nothing
//     is synthesized from a provider default we were not given.
//   * When the field a rule needs is ABSENT, the resource is recorded under
//     coverage.notEvaluated as 'field-absent' — an explicit unknown, never a
//     pass or a fail — because the setting may be defined elsewhere or left at a
//     default the normalized input did not capture. A wrong-typed field reads as
//     absent rather than being coerced, and an unsupported kind is surfaced the
//     same way rather than silently dropped.

export type IacSeverity = "critical" | "high" | "medium" | "low";

export interface IacSourceRef {
  readonly file: string;
  readonly line?: number;
}

export interface IacResource {
  readonly kind: string;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly sourceRef?: IacSourceRef;
}

export interface IacScanOptions {
  readonly tenant?: string;
}

export interface IacFinding {
  readonly ruleId: string;
  readonly severity: IacSeverity;
  readonly kind: string;
  readonly resourceName: string;
  readonly sourceRef?: IacSourceRef;
  readonly message: string;
  readonly remediationHint: string;
  readonly evidencePath: string;
}

export type NotEvaluatedReason = "field-absent" | "kind-not-supported";

export interface IacNotEvaluated {
  readonly resourceName: string;
  readonly kind: string;
  readonly ruleId: string | null;
  readonly reason: NotEvaluatedReason;
}

export interface IacCoverage {
  readonly evaluatedKinds: readonly string[];
  readonly notEvaluated: readonly IacNotEvaluated[];
}

export interface IacScanSummary {
  readonly resources: number;
  readonly findings: number;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly notEvaluated: number;
}

export interface IacScanReport {
  readonly schema: "sutra.iac-misconfiguration.v1";
  readonly tenant: string | null;
  readonly findings: readonly IacFinding[];
  readonly summary: IacScanSummary;
  readonly coverage: IacCoverage;
  readonly disclaimer: string;
}

const SEVERITY_RANK: Readonly<Record<IacSeverity, number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

const INTERNET_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

const IAC_MISCONFIGURATION_DISCLAIMER =
  "Sutra evaluates a bounded rule set over the normalized IaC resource evidence " +
  "provided; it does not parse raw HCL or YAML and has no visibility into state, " +
  "modules, or provider defaults not captured in the input. A rule reports a " +
  "finding only when the specific config field it inspects is present and unsafe. " +
  "When that field is absent the resource is recorded under coverage.notEvaluated " +
  "as 'field-absent' (unknown) rather than passed or failed, because the setting " +
  "may be defined elsewhere or left at a default the input did not capture. The " +
  "absence of a finding is not proof of a secure configuration.";

// ---- typed config readers: a missing or wrong-typed field reads as absent ----

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key];
  return typeof value === "boolean" ? value : undefined;
}

function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(config: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const value = config[key];
  return Array.isArray(value) ? value : undefined;
}

function readStringList(config: Record<string, unknown>, key: string): readonly string[] {
  const value = config[key];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readStringOrList(config: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = config[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return undefined;
}

// ---- rule model ----

interface RuleHit {
  readonly evidencePath?: string;
  readonly message?: string;
  readonly severity?: IacSeverity;
}

type RuleResult =
  | { readonly status: "field-absent" }
  | { readonly status: "evaluated"; readonly hits: readonly RuleHit[] };

interface Rule {
  readonly ruleId: string;
  readonly kind: string;
  readonly severity: IacSeverity;
  readonly message: string;
  readonly remediationHint: string;
  readonly evidencePath: string;
  readonly evaluate: (config: Record<string, unknown>) => RuleResult;
}

const FIELD_ABSENT: RuleResult = { status: "field-absent" };

function evaluated(hits: readonly RuleHit[]): RuleResult {
  return { status: "evaluated", hits };
}

const RULES: readonly Rule[] = [
  {
    ruleId: "S3_PUBLIC_ACL",
    kind: "aws_s3_bucket",
    severity: "high",
    message: "S3 bucket ACL grants public access",
    remediationHint: "Set the bucket ACL to 'private' and share via explicit, scoped bucket policies.",
    evidencePath: "config.acl",
    evaluate: (config) => {
      const acl = readString(config, "acl");
      if (acl === undefined) return FIELD_ABSENT;
      const isPublic = acl === "public-read" || acl === "public-read-write";
      return evaluated(isPublic ? [{ message: `S3 bucket ACL is '${acl}', granting public access` }] : []);
    },
  },
  {
    ruleId: "S3_NO_SERVER_SIDE_ENCRYPTION",
    kind: "aws_s3_bucket",
    severity: "medium",
    message: "S3 bucket has server-side encryption disabled",
    remediationHint: "Enable default server-side encryption (SSE-S3 or SSE-KMS) on the bucket.",
    evidencePath: "config.server_side_encryption_enabled",
    evaluate: (config) => {
      const enabled = readBoolean(config, "server_side_encryption_enabled");
      if (enabled === undefined) return FIELD_ABSENT;
      return evaluated(enabled === false ? [{}] : []);
    },
  },
  {
    ruleId: "S3_NO_BLOCK_PUBLIC_ACCESS",
    kind: "aws_s3_bucket",
    severity: "medium",
    message: "S3 bucket does not enable block-public-access",
    remediationHint: "Attach an aws_s3_bucket_public_access_block enabling all four block settings.",
    evidencePath: "config.block_public_access",
    evaluate: (config) => {
      const blocked = readBoolean(config, "block_public_access");
      if (blocked === undefined) return FIELD_ABSENT;
      return evaluated(blocked === false ? [{}] : []);
    },
  },
  {
    ruleId: "SG_UNRESTRICTED_INGRESS",
    kind: "aws_security_group",
    severity: "high",
    message: "Security group allows unrestricted inbound access from 0.0.0.0/0",
    remediationHint: "Restrict ingress CIDRs to known networks; never expose port 22, 3389, or all ports to 0.0.0.0/0.",
    evidencePath: "config.ingress",
    evaluate: (config) => {
      const ingress = readArray(config, "ingress");
      if (ingress === undefined) return FIELD_ABSENT;
      const hits: RuleHit[] = [];
      ingress.forEach((entry, index) => {
        const rule = asRecord(entry);
        if (rule === undefined) return;
        const openToWorld = readStringList(rule, "cidr_blocks").some((cidr) => INTERNET_CIDRS.has(cidr));
        if (!openToWorld) return;
        const path = `config.ingress[${index}]`;
        const protocol = readString(rule, "protocol");
        const fromPort = readNumber(rule, "from_port");
        const toPort = readNumber(rule, "to_port");
        if (protocol === "-1" || (fromPort === 0 && toPort === 65535)) {
          hits.push({
            evidencePath: path, severity: "critical",
            message: "Security group allows all inbound traffic from 0.0.0.0/0",
          });
          return;
        }
        // Port range unknown: do not synthesize a specific-port finding.
        if (fromPort === undefined || toPort === undefined) return;
        if (fromPort <= 22 && 22 <= toPort) {
          hits.push({
            evidencePath: path, severity: "high",
            message: "Security group allows inbound SSH (port 22) from 0.0.0.0/0",
          });
        }
        if (fromPort <= 3389 && 3389 <= toPort) {
          hits.push({
            evidencePath: path, severity: "high",
            message: "Security group allows inbound RDP (port 3389) from 0.0.0.0/0",
          });
        }
      });
      return evaluated(hits);
    },
  },
  {
    ruleId: "IAM_WILDCARD_ACTION_RESOURCE",
    kind: "aws_iam_policy",
    severity: "critical",
    message: "IAM policy Allow statement grants Action '*' on Resource '*'",
    remediationHint: "Scope the statement to the specific actions and resource ARNs required.",
    evidencePath: "config.statement",
    evaluate: (config) => {
      const statements = readArray(config, "statement");
      if (statements === undefined) return FIELD_ABSENT;
      const hits: RuleHit[] = [];
      statements.forEach((entry, index) => {
        const statement = asRecord(entry);
        if (statement === undefined) return;
        // Only an explicit Allow is unsafe; a missing effect is not assumed to be Allow.
        if (readString(statement, "effect") !== "Allow") return;
        const actions = readStringOrList(statement, "action");
        const resources = readStringOrList(statement, "resource");
        if (actions === undefined || resources === undefined) return;
        if (actions.includes("*") && resources.includes("*")) {
          hits.push({ evidencePath: `config.statement[${index}]` });
        }
      });
      return evaluated(hits);
    },
  },
  {
    ruleId: "RDS_PUBLICLY_ACCESSIBLE",
    kind: "aws_db_instance",
    severity: "high",
    message: "RDS instance is publicly accessible",
    remediationHint: "Set publicly_accessible = false and place the instance in private subnets.",
    evidencePath: "config.publicly_accessible",
    evaluate: (config) => {
      const publiclyAccessible = readBoolean(config, "publicly_accessible");
      if (publiclyAccessible === undefined) return FIELD_ABSENT;
      return evaluated(publiclyAccessible === true ? [{}] : []);
    },
  },
  {
    ruleId: "RDS_STORAGE_NOT_ENCRYPTED",
    kind: "aws_db_instance",
    severity: "medium",
    message: "RDS instance storage is not encrypted at rest",
    remediationHint: "Set storage_encrypted = true (a KMS key may be required) before creating the instance.",
    evidencePath: "config.storage_encrypted",
    evaluate: (config) => {
      const encrypted = readBoolean(config, "storage_encrypted");
      if (encrypted === undefined) return FIELD_ABSENT;
      return evaluated(encrypted === false ? [{}] : []);
    },
  },
  {
    ruleId: "EBS_NOT_ENCRYPTED",
    kind: "aws_ebs_volume",
    severity: "medium",
    message: "EBS volume is not encrypted at rest",
    remediationHint: "Set encrypted = true, or enable account-level EBS encryption by default.",
    evidencePath: "config.encrypted",
    evaluate: (config) => {
      const encrypted = readBoolean(config, "encrypted");
      if (encrypted === undefined) return FIELD_ABSENT;
      return evaluated(encrypted === false ? [{}] : []);
    },
  },
  {
    ruleId: "K8S_POD_PRIVILEGED",
    kind: "kubernetes_pod",
    severity: "critical",
    message: "Kubernetes pod runs a privileged container",
    remediationHint: "Set securityContext.privileged = false and grant only the specific capabilities required.",
    evidencePath: "config.privileged",
    evaluate: (config) => {
      const privileged = readBoolean(config, "privileged");
      if (privileged === undefined) return FIELD_ABSENT;
      return evaluated(privileged === true ? [{}] : []);
    },
  },
  {
    ruleId: "K8S_POD_HOST_NETWORK",
    kind: "kubernetes_pod",
    severity: "high",
    message: "Kubernetes pod shares the host network namespace",
    remediationHint: "Set host_network = false so the pod uses its own network namespace.",
    evidencePath: "config.host_network",
    evaluate: (config) => {
      const hostNetwork = readBoolean(config, "host_network");
      if (hostNetwork === undefined) return FIELD_ABSENT;
      return evaluated(hostNetwork === true ? [{}] : []);
    },
  },
  {
    ruleId: "K8S_POD_RUN_AS_NON_ROOT",
    kind: "kubernetes_pod",
    severity: "high",
    message: "Kubernetes pod does not require containers to run as non-root",
    remediationHint: "Set securityContext.run_as_non_root = true so the kubelet rejects containers that run as root.",
    evidencePath: "config.run_as_non_root",
    evaluate: (config) => {
      const runAsNonRoot = readBoolean(config, "run_as_non_root");
      if (runAsNonRoot === undefined) return FIELD_ABSENT;
      return evaluated(runAsNonRoot === false ? [{}] : []);
    },
  },
  {
    ruleId: "K8S_POD_MISSING_RESOURCE_LIMITS",
    kind: "kubernetes_pod",
    severity: "low",
    message: "Kubernetes pod container declares no resource limits",
    remediationHint: "Declare resources.limits (cpu and memory) on every container.",
    evidencePath: "config.has_resource_limits",
    evaluate: (config) => {
      const hasLimits = readBoolean(config, "has_resource_limits");
      if (hasLimits === undefined) return FIELD_ABSENT;
      return evaluated(hasLimits === false ? [{}] : []);
    },
  },
];

const RULES_BY_KIND: ReadonlyMap<string, readonly Rule[]> = (() => {
  const map = new Map<string, Rule[]>();
  for (const rule of RULES) {
    const existing = map.get(rule.kind);
    if (existing === undefined) map.set(rule.kind, [rule]);
    else existing.push(rule);
  }
  return map;
})();

function toFinding(rule: Rule, resource: IacResource, hit: RuleHit): IacFinding {
  return {
    ruleId: rule.ruleId,
    severity: hit.severity ?? rule.severity,
    kind: resource.kind,
    resourceName: resource.name,
    ...(resource.sourceRef !== undefined ? { sourceRef: resource.sourceRef } : {}),
    message: hit.message ?? rule.message,
    remediationHint: rule.remediationHint,
    evidencePath: hit.evidencePath ?? rule.evidencePath,
  };
}

export function scanIacResources(
  resources: readonly IacResource[],
  options: IacScanOptions = {},
): IacScanReport {
  const findings: IacFinding[] = [];
  const notEvaluated: IacNotEvaluated[] = [];
  const evaluatedKinds = new Set<string>();

  for (const resource of resources) {
    const rules = RULES_BY_KIND.get(resource.kind);
    if (rules === undefined) {
      notEvaluated.push({
        resourceName: resource.name, kind: resource.kind,
        ruleId: null, reason: "kind-not-supported",
      });
      continue;
    }
    evaluatedKinds.add(resource.kind);
    const config = asRecord(resource.config) ?? {};
    for (const rule of rules) {
      const result = rule.evaluate(config);
      if (result.status === "field-absent") {
        notEvaluated.push({
          resourceName: resource.name, kind: resource.kind,
          ruleId: rule.ruleId, reason: "field-absent",
        });
        continue;
      }
      for (const hit of result.hits) findings.push(toFinding(rule, resource, hit));
    }
  }

  findings.sort((left, right) =>
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    left.kind.localeCompare(right.kind, "en-US") ||
    left.resourceName.localeCompare(right.resourceName, "en-US") ||
    left.ruleId.localeCompare(right.ruleId, "en-US") ||
    left.evidencePath.localeCompare(right.evidencePath, "en-US") ||
    left.message.localeCompare(right.message, "en-US"));

  notEvaluated.sort((left, right) =>
    left.resourceName.localeCompare(right.resourceName, "en-US") ||
    left.kind.localeCompare(right.kind, "en-US") ||
    (left.ruleId ?? "").localeCompare(right.ruleId ?? "", "en-US") ||
    left.reason.localeCompare(right.reason, "en-US"));

  const summary: IacScanSummary = {
    resources: resources.length,
    findings: findings.length,
    critical: findings.filter((finding) => finding.severity === "critical").length,
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    low: findings.filter((finding) => finding.severity === "low").length,
    notEvaluated: notEvaluated.length,
  };

  return {
    schema: "sutra.iac-misconfiguration.v1",
    tenant: options.tenant ?? null,
    findings,
    summary,
    coverage: {
      evaluatedKinds: [...evaluatedKinds].sort((left, right) => left.localeCompare(right, "en-US")),
      notEvaluated,
    },
    disclaimer: IAC_MISCONFIGURATION_DISCLAIMER,
  };
}
