// Cloud Detection & Response (CDR) engine: evaluates a stream of already
// normalized audit/detection events (CloudTrail, GuardDuty, Kubernetes audit)
// against a small set of point-in-time rules and emits cited detections. Pure
// and deterministic; no clock, network, filesystem, or randomness. Two honesty
// ideas set it apart from a signature firehose:
//   * A detection is emitted only when the event's own fields prove it. A
//     mutating call that failed (an errorCode is present) is treated as not
//     having changed state; a ConsoleLogin is flagged only when the evidence
//     shows MFA was not used; a ClusterRoleBinding is reported as granting
//     cluster-admin only when the bound role is present in the evidence,
//     otherwise the granted role is left unresolved rather than assumed.
//   * Event types the engine has no rule for are counted as 'unclassified' in
//     the summary, never dropped silently and never assumed benign. Only the
//     specific param keys a rule needs are read; the rest of `params` is
//     discarded (the falco-runtime-boundary allowlist style).
// Correlation groups detections by an identical, tenant-scoped actor identity
// only; it performs no time-windowing because the clock is unavailable, so
// temporal correlation is the caller's responsibility.

export type DetectionSeverity = "critical" | "high" | "medium" | "low";
export type DetectionSource = "cloudtrail" | "guardduty" | "k8s-audit";

export interface CloudTrailEvent {
  readonly source: "cloudtrail";
  readonly eventName: string;
  readonly principal: string;
  readonly sourceIp?: string;
  readonly params?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly time: string;
  readonly tenant?: string;
}

export interface GuardDutyEvent {
  readonly source: "guardduty";
  readonly findingType: string;
  readonly severity: number;
  readonly resourceRef: string;
  readonly time: string;
  readonly tenant?: string;
}

export interface K8sAuditEvent {
  readonly source: "k8s-audit";
  readonly verb: string;
  readonly resource: string;
  readonly user: string;
  readonly namespace?: string;
  readonly time: string;
  readonly tenant?: string;
}

export type CloudDetectionEvent = CloudTrailEvent | GuardDutyEvent | K8sAuditEvent;

export interface DetectionEvidence {
  readonly name: string;
  readonly time: string;
  readonly sourceIp?: string;
}

export interface CloudDetection {
  readonly id: string;
  readonly ruleId: string;
  readonly title: string;
  readonly severity: DetectionSeverity;
  readonly source: DetectionSource;
  // The principal (CloudTrail) or user (Kubernetes) that performed the action;
  // 'unknown' when the evidence carries no actor identity (GuardDuty findings).
  readonly actor: string;
  readonly resourceRef?: string;
  readonly evidence: DetectionEvidence;
  readonly tenant: string | null;
}

export interface CorrelatedActor {
  readonly actor: string;
  readonly tenant: string | null;
  readonly detectionIds: readonly string[];
}

export interface CloudDetectionSummary {
  readonly events: number;
  // Events the engine had an applicable rule for (may still emit no detection).
  readonly evaluated: number;
  // Events with no matching rule; surfaced, never assumed benign.
  readonly unclassified: number;
  readonly detections: number;
  readonly bySeverity: Readonly<Record<DetectionSeverity, number>>;
  readonly bySource: Readonly<Record<DetectionSource, number>>;
}

export interface CloudDetectionReport {
  readonly schema: "sutra.cloud-detection.v1";
  readonly detections: readonly CloudDetection[];
  readonly correlated: readonly CorrelatedActor[];
  readonly summary: CloudDetectionSummary;
  readonly disclaimer: string;
}

// Actors are unresolved for sources that carry no principal (GuardDuty). Such
// detections are excluded from correlation: grouping distinct findings under a
// fabricated shared identity would be a false correlation.
const ACTOR_UNKNOWN = "unknown";

const INTERNET_CIDRS = new Set(["0.0.0.0/0", "::/0"]);
const PUBLIC_ACLS = new Set(["public-read", "public-read-write"]);
const SYSTEM_PRINCIPAL_PREFIX = "system:";

const SEVERITY_RANK: Readonly<Record<DetectionSeverity, number>> = {
  critical: 0, high: 1, medium: 2, low: 3,
};
const SOURCE_RANK: Readonly<Record<DetectionSource, number>> = {
  cloudtrail: 0, guardduty: 1, "k8s-audit": 2,
};

const CLOUD_DETECTION_DISCLAIMER =
  "Detections are rule-based and point-in-time over the supplied audit and " +
  "finding events only. A detection is emitted only when the event's own fields " +
  "prove it: a mutating call that failed (errorCode present) is treated as not " +
  "having changed state, a ConsoleLogin is flagged only when the evidence shows " +
  "MFA was not used, and a ClusterRoleBinding is reported as granting " +
  "cluster-admin only when the bound role is present in the evidence, otherwise " +
  "the granted role is left unresolved. Event types with no matching rule are " +
  "counted as 'unclassified', never dropped and never assumed benign. GuardDuty " +
  "findings are passed through with their numeric severity mapped to a band; a " +
  "GuardDuty finding carries no actor identity, so those detections use an " +
  "'unknown' actor and are excluded from correlation. Correlation groups " +
  "detections only by an identical, tenant-scoped actor identity and performs no " +
  "time-windowing (the clock is unavailable); temporal correlation is the " +
  "caller's responsibility. Detections are triage signals, not proof of " +
  "compromise.";

interface RawDetection {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: DetectionSeverity;
  readonly source: DetectionSource;
  readonly actor: string;
  readonly resourceRef?: string;
  readonly evidence: DetectionEvidence;
  readonly tenant: string | null;
}

interface Classification {
  readonly detections: readonly RawDetection[];
  readonly recognized: boolean;
}

function byLocale(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

function readBool(params: Record<string, unknown> | undefined, key: string): boolean | null {
  if (params === undefined) return null;
  const value = params[key];
  return typeof value === "boolean" ? value : null;
}

function readString(params: Record<string, unknown> | undefined, key: string): string | null {
  if (params === undefined) return null;
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readStrings(params: Record<string, unknown> | undefined, key: string): readonly string[] {
  if (params === undefined) return [];
  const value = params[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRootPrincipal(principal: string): boolean {
  const value = principal.trim();
  return value.toLocaleLowerCase("en-US") === "root" || value.endsWith(":root");
}

function isBroadAction(action: string): boolean {
  return action === "*" || action === "*:*" || action.endsWith(":*");
}

function isBroadManagedPolicy(policyArn: string): boolean {
  return policyArn.includes("AdministratorAccess") || policyArn.includes("PowerUserAccess");
}

function guardDutyBand(severity: number): DetectionSeverity {
  if (severity >= 8) return "critical";
  if (severity >= 7) return "high";
  if (severity >= 4) return "medium";
  return "low";
}

function cloudTrailEvidence(event: CloudTrailEvent): DetectionEvidence {
  return event.sourceIp === undefined
    ? { name: event.eventName, time: event.time }
    : { name: event.eventName, time: event.time, sourceIp: event.sourceIp };
}

function opensToWorld(params: Record<string, unknown> | undefined): boolean {
  const cidrs: string[] = [];
  const single = readString(params, "cidr");
  if (single !== null) cidrs.push(single);
  cidrs.push(...readStrings(params, "cidrs"));
  return cidrs.some((cidr) => INTERNET_CIDRS.has(cidr));
}

function grantsBroadPermissions(params: Record<string, unknown> | undefined): boolean {
  if (readStrings(params, "actions").some(isBroadAction)) return true;
  const policyArn = readString(params, "policyArn");
  return policyArn !== null && isBroadManagedPolicy(policyArn);
}

function makesBucketPublic(params: Record<string, unknown> | undefined): boolean {
  if (readBool(params, "public") === true) return true;
  const acl = readString(params, "acl");
  return acl !== null && PUBLIC_ACLS.has(acl);
}

function iamTargetRef(params: Record<string, unknown> | undefined): string | undefined {
  return readString(params, "userName")
    ?? readString(params, "roleName")
    ?? readString(params, "groupName")
    ?? undefined;
}

function classifyCloudTrail(event: CloudTrailEvent): Classification {
  const tenant = event.tenant ?? null;
  const evidence = cloudTrailEvidence(event);
  const params = event.params;
  const actor = event.principal;
  const failed = event.errorCode !== undefined && event.errorCode !== null && event.errorCode !== "";
  const detections: RawDetection[] = [];

  const root = isRootPrincipal(actor);
  if (root) {
    detections.push({
      ruleId: "cloudtrail-root-account-usage",
      title: "Root account credentials used",
      severity: "high", source: "cloudtrail", actor, evidence, tenant,
    });
  }

  let recognized = root;
  switch (event.eventName) {
    case "StopLogging":
    case "DeleteTrail": {
      recognized = true;
      if (!failed) {
        detections.push({
          ruleId: "cloudtrail-logging-disabled",
          title: event.eventName === "DeleteTrail" ? "CloudTrail trail deleted" : "CloudTrail logging stopped",
          severity: "high", source: "cloudtrail", actor,
          resourceRef: readString(params, "trailName") ?? readString(params, "name") ?? undefined,
          evidence, tenant,
        });
      }
      break;
    }
    case "ConsoleLogin": {
      recognized = true;
      // Emitted only when the evidence proves the login succeeded without MFA.
      // A missing mfaUsed field cannot prove absence, so it yields no detection.
      if (!failed && readBool(params, "mfaUsed") === false) {
        detections.push({
          ruleId: "console-login-without-mfa",
          title: "Console login without MFA",
          severity: "medium", source: "cloudtrail", actor, evidence, tenant,
        });
      }
      break;
    }
    case "AuthorizeSecurityGroupIngress": {
      recognized = true;
      if (!failed && opensToWorld(params)) {
        detections.push({
          ruleId: "security-group-open-to-world",
          title: "Security group ingress opened to 0.0.0.0/0",
          severity: "high", source: "cloudtrail", actor,
          resourceRef: readString(params, "groupId") ?? undefined,
          evidence, tenant,
        });
      }
      break;
    }
    case "PutUserPolicy":
    case "PutRolePolicy":
    case "PutGroupPolicy":
    case "AttachUserPolicy":
    case "AttachRolePolicy":
    case "AttachGroupPolicy": {
      recognized = true;
      if (!failed && grantsBroadPermissions(params)) {
        detections.push({
          ruleId: "iam-policy-made-permissive",
          title: "IAM policy made more permissive",
          severity: "high", source: "cloudtrail", actor,
          resourceRef: iamTargetRef(params),
          evidence, tenant,
        });
      }
      break;
    }
    case "PutBucketAcl":
    case "PutBucketPolicy": {
      recognized = true;
      if (!failed && makesBucketPublic(params)) {
        detections.push({
          ruleId: "s3-bucket-made-public",
          title: "S3 bucket made public",
          severity: "high", source: "cloudtrail", actor,
          resourceRef: readString(params, "bucketName") ?? readString(params, "bucket") ?? undefined,
          evidence, tenant,
        });
      }
      break;
    }
    case "DeleteDetector":
    case "StopMonitoringMembers":
    case "DisableOrganizationAdminAccount": {
      recognized = true;
      if (!failed) {
        detections.push({
          ruleId: "guardduty-disabled",
          title: "GuardDuty disabled",
          severity: "high", source: "cloudtrail", actor,
          resourceRef: readString(params, "detectorId") ?? undefined,
          evidence, tenant,
        });
      }
      break;
    }
    case "UpdateDetector": {
      recognized = true;
      // Only a detector update that explicitly disables monitoring is a finding.
      if (!failed && readBool(params, "enable") === false) {
        detections.push({
          ruleId: "guardduty-disabled",
          title: "GuardDuty detector disabled",
          severity: "high", source: "cloudtrail", actor,
          resourceRef: readString(params, "detectorId") ?? undefined,
          evidence, tenant,
        });
      }
      break;
    }
    default:
      break;
  }

  return { detections, recognized };
}

function classifyGuardDuty(event: GuardDutyEvent): Classification {
  return {
    recognized: true,
    detections: [{
      ruleId: "guardduty-finding",
      title: `GuardDuty finding: ${event.findingType}`,
      severity: guardDutyBand(event.severity),
      source: "guardduty",
      actor: ACTOR_UNKNOWN,
      resourceRef: event.resourceRef,
      evidence: { name: event.findingType, time: event.time },
      tenant: event.tenant ?? null,
    }],
  };
}

function k8sResourceRef(event: K8sAuditEvent): string {
  return event.namespace !== undefined && event.namespace !== ""
    ? `${event.namespace}/${event.resource}`
    : event.resource;
}

function classifyK8sAudit(event: K8sAuditEvent): Classification {
  const tenant = event.tenant ?? null;
  const actor = event.user;
  const evidence: DetectionEvidence = { name: `${event.verb} ${event.resource}`, time: event.time };
  const resourceRef = k8sResourceRef(event);
  const parts = event.resource.split("/");
  const head = parts[0];

  if (event.verb === "create" && head === "pods" && parts[1] === "exec") {
    return {
      recognized: true,
      detections: [{
        ruleId: "k8s-exec-into-pod",
        title: "Exec into pod",
        severity: "high", source: "k8s-audit", actor, resourceRef, evidence, tenant,
      }],
    };
  }

  if ((event.verb === "get" || event.verb === "list" || event.verb === "watch") && head === "secrets") {
    // "Unexpected" is heuristic: a non-system identity reading Secrets directly.
    // system: principals (nodes, controllers, service accounts) are the expected
    // automated readers and are recognized without a detection.
    if (actor.startsWith(SYSTEM_PRINCIPAL_PREFIX)) return { recognized: true, detections: [] };
    return {
      recognized: true,
      detections: [{
        ruleId: "k8s-secret-accessed-by-user",
        title: "Kubernetes secret read by a non-system user",
        severity: "high", source: "k8s-audit", actor, resourceRef, evidence, tenant,
      }],
    };
  }

  if ((event.verb === "create" || event.verb === "update" || event.verb === "patch") && head === "clusterrolebindings") {
    const role = parts[1];
    if (role === "cluster-admin") {
      return {
        recognized: true,
        detections: [{
          ruleId: "k8s-clusterrolebinding-cluster-admin",
          title: "cluster-admin granted via ClusterRoleBinding",
          severity: "critical", source: "k8s-audit", actor, resourceRef, evidence, tenant,
        }],
      };
    }
    if (role === "admin") {
      return {
        recognized: true,
        detections: [{
          ruleId: "k8s-clusterrolebinding-privileged",
          title: "Privileged ClusterRole (admin) granted via ClusterRoleBinding",
          severity: "high", source: "k8s-audit", actor, resourceRef, evidence, tenant,
        }],
      };
    }
    return {
      recognized: true,
      detections: [{
        ruleId: "k8s-clusterrolebinding-created",
        title: "ClusterRoleBinding created; bound ClusterRole not in evidence (unresolved)",
        severity: "medium", source: "k8s-audit", actor, resourceRef, evidence, tenant,
      }],
    };
  }

  return { recognized: false, detections: [] };
}

function classify(event: CloudDetectionEvent): Classification {
  switch (event.source) {
    case "cloudtrail": return classifyCloudTrail(event);
    case "guardduty": return classifyGuardDuty(event);
    case "k8s-audit": return classifyK8sAudit(event);
    default: return { recognized: false, detections: [] };
  }
}

function compareRaw(left: RawDetection, right: RawDetection): number {
  return SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || SOURCE_RANK[left.source] - SOURCE_RANK[right.source]
    || byLocale(left.tenant ?? "", right.tenant ?? "")
    || byLocale(left.actor, right.actor)
    || byLocale(left.ruleId, right.ruleId)
    || byLocale(left.evidence.time, right.evidence.time)
    || byLocale(left.evidence.name, right.evidence.name)
    || byLocale(left.resourceRef ?? "", right.resourceRef ?? "");
}

function finalize(raw: RawDetection, index: number): CloudDetection {
  const head = {
    id: `det_${index}`,
    ruleId: raw.ruleId,
    title: raw.title,
    severity: raw.severity,
    source: raw.source,
    actor: raw.actor,
  };
  const withResource = raw.resourceRef !== undefined ? { ...head, resourceRef: raw.resourceRef } : head;
  return { ...withResource, evidence: raw.evidence, tenant: raw.tenant };
}

function correlate(detections: readonly CloudDetection[]): CorrelatedActor[] {
  const groups = new Map<string, { actor: string; tenant: string | null; detectionIds: string[] }>();
  for (const detection of detections) {
    if (detection.actor === ACTOR_UNKNOWN) continue;
    // Tenant-scoped identity: the same actor string in two tenants is two actors.
    const key = `${detection.tenant ?? ""} ${detection.actor}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { actor: detection.actor, tenant: detection.tenant, detectionIds: [detection.id] });
    } else {
      existing.detectionIds.push(detection.id);
    }
  }
  const correlated: CorrelatedActor[] = [];
  for (const group of groups.values()) {
    if (group.detectionIds.length < 2) continue;
    correlated.push({ actor: group.actor, tenant: group.tenant, detectionIds: group.detectionIds });
  }
  correlated.sort((left, right) =>
    byLocale(left.tenant ?? "", right.tenant ?? "") || byLocale(left.actor, right.actor));
  return correlated;
}

export function buildCloudDetections(events: readonly CloudDetectionEvent[]): CloudDetectionReport {
  const raw: RawDetection[] = [];
  let evaluated = 0;
  let unclassified = 0;
  const bySource: Record<DetectionSource, number> = { cloudtrail: 0, guardduty: 0, "k8s-audit": 0 };

  for (const event of events) {
    if (event.source === "cloudtrail" || event.source === "guardduty" || event.source === "k8s-audit") {
      bySource[event.source] += 1;
    }
    const result = classify(event);
    if (result.recognized) evaluated += 1;
    else unclassified += 1;
    for (const detection of result.detections) raw.push(detection);
  }

  raw.sort(compareRaw);
  const detections = raw.map(finalize);
  const correlated = correlate(detections);

  const bySeverity: Record<DetectionSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const detection of detections) bySeverity[detection.severity] += 1;

  return {
    schema: "sutra.cloud-detection.v1",
    detections,
    correlated,
    summary: {
      events: events.length,
      evaluated,
      unclassified,
      detections: detections.length,
      bySeverity,
      bySource,
    },
    disclaimer: CLOUD_DETECTION_DISCLAIMER,
  };
}
