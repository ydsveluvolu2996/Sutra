import type {
  AwsAccount,
  ControlCategory,
  FindingEvidenceValue,
  FindingTarget,
  NormalizedResource,
  PostureSummary,
  SecurityControl,
  SecurityControlId,
  SecurityFinding,
  SecurityGroupRule,
  SecurityInventory,
  Severity,
} from "./types.ts";

export const SECURITY_ENGINE_DISCLAIMER =
  "These deterministic checks assess observed AWS configuration and service coverage. They do not inspect software packages, prove exploitability, or detect runtime threats, and they are not a replacement for AWS Inspector, GuardDuty, or Security Hub.";

const CONFIGURATION_LIMITATION =
  "Configuration observation only; validate the resource and business context before remediation.";

export const securityControls: readonly SecurityControl[] = [
  {
    id: "aws.s3.public-access",
    title: "S3 bucket permits public access",
    description: "The normalized bucket configuration reports effective public access.",
    category: "exposure",
    severity: "high",
    scope: "resource",
    services: ["s3"],
    remediation: "Confirm the use case, then restrict the bucket policy or ACL and enable S3 Block Public Access.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.ec2.security-group.open-ssh",
    title: "Security group exposes SSH to the internet",
    description: "An ingress rule permits TCP port 22 from an all-address IPv4 or IPv6 range.",
    category: "exposure",
    severity: "high",
    scope: "security-group",
    services: ["ec2"],
    remediation: "Limit port 22 to approved administration ranges or use AWS Systems Manager Session Manager.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.ec2.security-group.open-rdp",
    title: "Security group exposes RDP to the internet",
    description: "An ingress rule permits TCP port 3389 from an all-address IPv4 or IPv6 range.",
    category: "exposure",
    severity: "high",
    scope: "security-group",
    services: ["ec2"],
    remediation: "Limit port 3389 to approved administration ranges or use a managed access path.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.ec2.ebs.unencrypted",
    title: "EBS volume is not encrypted",
    description: "The normalized EBS configuration explicitly reports encryption as disabled.",
    category: "encryption",
    severity: "medium",
    scope: "resource",
    services: ["ec2"],
    remediation: "Snapshot and replace the volume with an encrypted volume, then enable EBS encryption by default.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.rds.unencrypted",
    title: "RDS instance is not encrypted",
    description: "The normalized RDS configuration explicitly reports storage encryption as disabled.",
    category: "encryption",
    severity: "high",
    scope: "resource",
    services: ["rds"],
    remediation: "Restore an encrypted snapshot into a replacement instance and migrate through an approved change plan.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.rds.public-access",
    title: "RDS instance is publicly accessible",
    description: "The normalized RDS configuration explicitly reports public accessibility as enabled.",
    category: "exposure",
    severity: "high",
    scope: "resource",
    services: ["rds"],
    remediation: "Set the instance to private access and route application traffic through private subnets and controlled security groups.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.iam.root-mfa-disabled",
    title: "Root user MFA is not enabled",
    description: "The latest account-level IAM signal explicitly reports root MFA as disabled.",
    category: "identity",
    severity: "critical",
    scope: "account",
    services: ["iam"],
    remediation: "Enable a phishing-resistant MFA method for the root user and protect the recovery process.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.iam.password-policy-missing",
    title: "Account password policy is not configured",
    description: "The latest account-level IAM signal explicitly reports no custom password policy.",
    category: "identity",
    severity: "medium",
    scope: "account",
    services: ["iam"],
    remediation: "Configure an IAM account password policy and prefer federated access for workforce identities.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.iam.access-key-stale",
    title: "IAM user has an active access key older than 90 days",
    description: "At least one normalized active IAM access key has an age greater than 90 days.",
    category: "identity",
    severity: "high",
    scope: "resource",
    services: ["iam"],
    remediation: "Confirm usage, rotate the key without interruption, then remove the old key and prefer temporary credentials.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.ec2.default-security-group-ingress",
    title: "Default security group contains ingress rules",
    description: "A VPC default security group has one or more ingress rules.",
    category: "exposure",
    severity: "medium",
    scope: "security-group",
    services: ["ec2"],
    remediation: "Remove ingress from the default group and assign purpose-built groups to workloads.",
    detectionMode: "configuration",
    limitation: CONFIGURATION_LIMITATION,
  },
  {
    id: "aws.cloudtrail.absent",
    title: "CloudTrail is not enabled",
    description: "The latest account-level coverage signal explicitly reports CloudTrail as disabled.",
    category: "logging",
    severity: "high",
    scope: "account",
    services: ["cloudtrail"],
    remediation: "Enable a multi-Region trail, protect its log destination, and monitor delivery failures.",
    detectionMode: "configuration",
    limitation: "Coverage signal only; it does not assess the completeness or integrity of historical events.",
  },
  {
    id: "aws.guardduty.coverage-incomplete",
    title: "GuardDuty coverage is incomplete",
    description: "The latest coverage signal reports GuardDuty as disabled or only partially enabled for monitored regions.",
    category: "coverage",
    severity: "medium",
    scope: "account",
    services: ["guardduty"],
    remediation: "Review cost and risk, then enable GuardDuty in the intended regions or document an approved alternative control.",
    detectionMode: "configuration",
    limitation: "Coverage signal only; it does not indicate that a threat is present or absent.",
  },
] as const;

const controlsById = new Map<SecurityControlId, SecurityControl>(
  securityControls.map((control) => [control.id, control]),
);

function controlFor(id: SecurityControlId): SecurityControl {
  const control = controlsById.get(id);
  if (!control) throw new Error(`Unknown security control: ${id}`);
  return control;
}

function finding(
  id: SecurityControlId,
  account: AwsAccount,
  target: FindingTarget,
  service: string,
  region: string,
  evidence: Readonly<Record<string, FindingEvidenceValue>>,
): SecurityFinding {
  const control = controlFor(id);
  return {
    id: `${id}:${target.type}:${target.id}`,
    customerId: account.customerId,
    accountId: account.id,
    controlId: id,
    title: control.title,
    description: control.description,
    category: control.category,
    severity: control.severity,
    status: "open",
    service,
    region,
    target,
    evidence,
    remediation: control.remediation,
    observedAt: account.lastSyncedAt,
    source: "deterministic-configuration-check",
    capability: "configuration-assessment",
  };
}

function publicRanges(rule: SecurityGroupRule): readonly string[] {
  return [
    ...rule.ipv4Ranges.filter((range) => range === "0.0.0.0/0"),
    ...rule.ipv6Ranges.filter((range) => range === "::/0"),
  ];
}

function ruleExposesTcpPort(rule: SecurityGroupRule, port: number): boolean {
  if (publicRanges(rule).length === 0) return false;
  if (rule.protocol === "-1") return true;
  if (rule.protocol !== "tcp") return false;
  if (rule.fromPort === null && rule.toPort === null) return true;
  if (rule.fromPort === null || rule.toPort === null) return false;
  return rule.fromPort <= port && rule.toPort >= port;
}

function targetForResource(resource: NormalizedResource): FindingTarget {
  return { type: "resource", id: resource.id, name: resource.name };
}

function accountTarget(account: AwsAccount): FindingTarget {
  return { type: "account", id: account.id, name: account.name };
}

const severityOrder: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

/** Evaluates only explicit normalized values; unknown signals are deliberately not failed. */
export function evaluateSecurityControls(inventory: SecurityInventory): SecurityFinding[] {
  const accountsById = new Map(inventory.accounts.map((account) => [account.id, account]));
  const findings: SecurityFinding[] = [];

  for (const account of inventory.accounts) {
    const target = accountTarget(account);
    const signals = account.securitySignals;
    if (signals.rootMfa === "disabled") {
      findings.push(finding("aws.iam.root-mfa-disabled", account, target, "iam", "global", { rootMfa: "disabled" }));
    }
    if (signals.passwordPolicy === "disabled") {
      findings.push(
        finding("aws.iam.password-policy-missing", account, target, "iam", "global", {
          passwordPolicy: "disabled",
        }),
      );
    }
    if (signals.cloudTrail.status === "disabled") {
      findings.push(
        finding("aws.cloudtrail.absent", account, target, "cloudtrail", "global", {
          coverageStatus: "disabled",
          coveredRegions: signals.cloudTrail.coveredRegions,
        }),
      );
    }
    if (signals.guardDuty.status === "disabled" || signals.guardDuty.status === "partial") {
      findings.push(
        finding("aws.guardduty.coverage-incomplete", account, target, "guardduty", "global", {
          coverageStatus: signals.guardDuty.status,
          coveredRegions: signals.guardDuty.coveredRegions,
          monitoredRegions: account.regions,
        }),
      );
    }
  }

  for (const resource of inventory.resources) {
    const account = accountsById.get(resource.accountId);
    if (!account || account.customerId !== resource.customerId) continue;
    const target = targetForResource(resource);

    if (resource.resourceType === "s3-bucket" && resource.configuration.publicAccess === "public") {
      findings.push(
        finding("aws.s3.public-access", account, target, "s3", resource.region, {
          effectivePublicAccess: "public",
          blockPublicAccessEnabled: resource.configuration.blockPublicAccessEnabled ?? "unknown",
        }),
      );
    }
    if (resource.resourceType === "ebs-volume" && resource.configuration.encrypted === false) {
      findings.push(
        finding("aws.ec2.ebs.unencrypted", account, target, "ec2", resource.region, {
          encrypted: false,
          volumeType: resource.configuration.volumeType,
          sizeGiB: resource.configuration.sizeGiB,
        }),
      );
    }
    if (resource.resourceType === "rds-instance") {
      if (resource.configuration.encrypted === false) {
        findings.push(
          finding("aws.rds.unencrypted", account, target, "rds", resource.region, {
            encrypted: false,
            engine: resource.configuration.engine,
          }),
        );
      }
      if (resource.configuration.publiclyAccessible === true) {
        findings.push(
          finding("aws.rds.public-access", account, target, "rds", resource.region, {
            publiclyAccessible: true,
            engine: resource.configuration.engine,
          }),
        );
      }
    }
    if (resource.resourceType === "iam-user") {
      const staleKeys = resource.configuration.accessKeys
        .filter((key) => key.status === "active" && key.ageDays > 90)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (staleKeys.length > 0) {
        findings.push(
          finding("aws.iam.access-key-stale", account, target, "iam", "global", {
            staleKeyIds: staleKeys.map((key) => key.id),
            oldestActiveKeyAgeDays: Math.max(...staleKeys.map((key) => key.ageDays)),
            thresholdDays: 90,
          }),
        );
      }
    }
  }

  for (const group of inventory.securityGroups) {
    const account = accountsById.get(group.accountId);
    if (!account || account.customerId !== group.customerId) continue;
    const target: FindingTarget = { type: "security-group", id: group.id, name: group.name };

    for (const [port, id] of [
      [22, "aws.ec2.security-group.open-ssh"],
      [3389, "aws.ec2.security-group.open-rdp"],
    ] as const) {
      const matchingRules = group.ingress.filter((rule) => ruleExposesTcpPort(rule, port));
      if (matchingRules.length > 0) {
        findings.push(
          finding(id, account, target, "ec2", group.region, {
            port,
            ruleIds: matchingRules.map((rule) => rule.id).sort(),
            publicRanges: [...new Set(matchingRules.flatMap(publicRanges))].sort(),
          }),
        );
      }
    }

    if (group.isDefault && group.ingress.length > 0) {
      findings.push(
        finding("aws.ec2.default-security-group-ingress", account, target, "ec2", group.region, {
          ingressRuleCount: group.ingress.length,
          vpcId: group.vpcId,
        }),
      );
    }
  }

  return findings.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.customerId.localeCompare(b.customerId) ||
      a.accountId.localeCompare(b.accountId) ||
      a.controlId.localeCompare(b.controlId) ||
      a.target.id.localeCompare(b.target.id),
  );
}

export function summarizeFindings(findings: readonly SecurityFinding[]): PostureSummary {
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  const byCategory: Record<ControlCategory, number> = {
    exposure: 0,
    encryption: 0,
    identity: 0,
    logging: 0,
    coverage: 0,
  };
  const accountIds = new Set<string>();
  const resourceIds = new Set<string>();

  for (const item of findings) {
    bySeverity[item.severity] += 1;
    byCategory[item.category] += 1;
    accountIds.add(item.accountId);
    if (item.target.type !== "account") resourceIds.add(item.target.id);
  }

  return {
    total: findings.length,
    bySeverity,
    byCategory,
    affectedAccounts: accountIds.size,
    affectedResources: resourceIds.size,
  };
}

export const controls = securityControls;
