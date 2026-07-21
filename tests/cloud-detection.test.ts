import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCloudDetections,
  type CloudDetectionEvent,
  type CloudTrailEvent,
  type GuardDutyEvent,
  type K8sAuditEvent,
} from "../lib/cloud-detection.ts";

const T = "2026-07-18T00:00:00.000Z";

function ct(over: Partial<CloudTrailEvent> & { readonly eventName: string }): CloudTrailEvent {
  return { source: "cloudtrail", principal: "arn:aws:iam::111122223333:user/alice", time: T, ...over };
}
function gd(over: Partial<GuardDutyEvent> & { readonly findingType: string; readonly severity: number }): GuardDutyEvent {
  return { source: "guardduty", resourceRef: "i-0abc", time: T, ...over };
}
function k8s(over: Partial<K8sAuditEvent> & { readonly verb: string; readonly resource: string }): K8sAuditEvent {
  return { source: "k8s-audit", user: "alice", time: T, ...over };
}

function ruleIds(events: readonly CloudDetectionEvent[]): string[] {
  return buildCloudDetections(events).detections.map((detection) => detection.ruleId);
}

test("root account usage is detected from the root principal", () => {
  const report = buildCloudDetections([
    ct({ eventName: "RunInstances", principal: "arn:aws:iam::111122223333:root" }),
  ]);
  assert.equal(report.detections.length, 1);
  const detection = report.detections[0];
  assert.equal(detection?.ruleId, "cloudtrail-root-account-usage");
  assert.equal(detection?.severity, "high");
  assert.equal(detection?.actor, "arn:aws:iam::111122223333:root");
  assert.equal(detection?.evidence.name, "RunInstances");
  assert.equal(detection?.evidence.time, T);
  // A root event with an unknown eventName is still recognized (root rule fired).
  assert.equal(report.summary.unclassified, 0);
  assert.equal(report.summary.evaluated, 1);
});

test("StopLogging is detected as CloudTrail logging disabled", () => {
  const report = buildCloudDetections([ct({ eventName: "StopLogging", params: { trailName: "org-trail" } })]);
  assert.equal(report.detections.length, 1);
  assert.equal(report.detections[0]?.ruleId, "cloudtrail-logging-disabled");
  assert.equal(report.detections[0]?.resourceRef, "org-trail");
  assert.equal(report.summary.bySource.cloudtrail, 1);
});

test("a benign DescribeInstances event produces no detection", () => {
  const report = buildCloudDetections([ct({ eventName: "DescribeInstances" })]);
  assert.equal(report.detections.length, 0);
  assert.equal(report.correlated.length, 0);
});

test("an unknown eventName is counted as unclassified, never dropped or assumed benign", () => {
  const report = buildCloudDetections([
    ct({ eventName: "DescribeInstances" }),
    ct({ eventName: "SomeBrandNewApiCall2099" }),
  ]);
  assert.equal(report.detections.length, 0);
  assert.equal(report.summary.events, 2);
  assert.equal(report.summary.unclassified, 2);
  assert.equal(report.summary.evaluated, 0);
});

test("two detections by the same actor are grouped in correlated", () => {
  const events = [
    ct({ eventName: "StopLogging" }),
    ct({ eventName: "AuthorizeSecurityGroupIngress", params: { cidr: "0.0.0.0/0", groupId: "sg-1" } }),
  ];
  const report = buildCloudDetections(events);
  assert.equal(report.detections.length, 2);
  assert.equal(report.correlated.length, 1);
  const group = report.correlated[0];
  assert.equal(group?.actor, "arn:aws:iam::111122223333:user/alice");
  assert.equal(group?.detectionIds.length, 2);
  // Group ids must reference real detections.
  const ids = new Set(report.detections.map((detection) => detection.id));
  for (const id of group?.detectionIds ?? []) assert.ok(ids.has(id));
});

test("a single detection does not form a correlation group", () => {
  const report = buildCloudDetections([ct({ eventName: "StopLogging" })]);
  assert.equal(report.detections.length, 1);
  assert.equal(report.correlated.length, 0);
});

test("a failed mutating call (errorCode present) yields no state-change detection but is still recognized", () => {
  const report = buildCloudDetections([
    ct({ eventName: "StopLogging", errorCode: "AccessDenied" }),
    ct({ eventName: "AuthorizeSecurityGroupIngress", errorCode: "Client.UnauthorizedOperation", params: { cidr: "0.0.0.0/0" } }),
  ]);
  assert.equal(report.detections.length, 0);
  assert.equal(report.summary.evaluated, 2);
  assert.equal(report.summary.unclassified, 0);
});

test("console login is flagged only when the evidence proves MFA was not used", () => {
  assert.deepEqual(ruleIds([ct({ eventName: "ConsoleLogin", params: { mfaUsed: false } })]), ["console-login-without-mfa"]);
  // MFA present -> recognized, no detection.
  assert.deepEqual(ruleIds([ct({ eventName: "ConsoleLogin", params: { mfaUsed: true } })]), []);
  // MFA field absent -> cannot prove absence -> no detection (honesty), still recognized.
  const missing = buildCloudDetections([ct({ eventName: "ConsoleLogin" })]);
  assert.equal(missing.detections.length, 0);
  assert.equal(missing.summary.unclassified, 0);
  assert.equal(missing.summary.evaluated, 1);
});

test("security group ingress is flagged only for an internet CIDR present in the evidence", () => {
  assert.deepEqual(
    ruleIds([ct({ eventName: "AuthorizeSecurityGroupIngress", params: { cidr: "0.0.0.0/0" } })]),
    ["security-group-open-to-world"],
  );
  assert.deepEqual(
    ruleIds([ct({ eventName: "AuthorizeSecurityGroupIngress", params: { cidrs: ["::/0"] } })]),
    ["security-group-open-to-world"],
  );
  // A scoped CIDR is not world-open.
  assert.deepEqual(ruleIds([ct({ eventName: "AuthorizeSecurityGroupIngress", params: { cidr: "10.0.0.0/8" } })]), []);
  // No CIDR in evidence -> cannot prove -> no detection.
  assert.deepEqual(ruleIds([ct({ eventName: "AuthorizeSecurityGroupIngress" })]), []);
});

test("IAM permissiveness is flagged for broad actions or an admin managed policy, not for scoped grants", () => {
  assert.deepEqual(ruleIds([ct({ eventName: "PutUserPolicy", params: { actions: ["*"] } })]), ["iam-policy-made-permissive"]);
  assert.deepEqual(ruleIds([ct({ eventName: "PutRolePolicy", params: { actions: ["s3:*"] } })]), ["iam-policy-made-permissive"]);
  assert.deepEqual(
    ruleIds([ct({ eventName: "AttachRolePolicy", params: { policyArn: "arn:aws:iam::aws:policy/AdministratorAccess" } })]),
    ["iam-policy-made-permissive"],
  );
  // Scoped single-action grant -> recognized, no detection.
  assert.deepEqual(ruleIds([ct({ eventName: "PutUserPolicy", params: { actions: ["s3:GetObject"] } })]), []);
  // No action/policy evidence -> cannot prove broad -> no detection.
  assert.deepEqual(ruleIds([ct({ eventName: "AttachRolePolicy" })]), []);
});

test("S3 public exposure is flagged only when the evidence marks it public", () => {
  assert.deepEqual(ruleIds([ct({ eventName: "PutBucketAcl", params: { public: true, bucketName: "logs" } })]), ["s3-bucket-made-public"]);
  assert.deepEqual(ruleIds([ct({ eventName: "PutBucketAcl", params: { acl: "public-read" } })]), ["s3-bucket-made-public"]);
  assert.deepEqual(ruleIds([ct({ eventName: "PutBucketPolicy", params: { public: false } })]), []);
  assert.deepEqual(ruleIds([ct({ eventName: "PutBucketPolicy" })]), []);
});

test("GuardDuty control-plane teardown events are flagged as GuardDuty disabled", () => {
  assert.deepEqual(ruleIds([ct({ eventName: "DeleteDetector", params: { detectorId: "d-1" } })]), ["guardduty-disabled"]);
  assert.deepEqual(ruleIds([ct({ eventName: "UpdateDetector", params: { enable: false } })]), ["guardduty-disabled"]);
  // UpdateDetector that enables (or omits the flag) is not a teardown.
  assert.deepEqual(ruleIds([ct({ eventName: "UpdateDetector", params: { enable: true } })]), []);
  assert.deepEqual(ruleIds([ct({ eventName: "UpdateDetector" })]), []);
});

test("GuardDuty findings pass through with numeric severity mapped to a band", () => {
  const report = buildCloudDetections([
    gd({ findingType: "Backdoor:EC2/C&CActivity.B", severity: 8.5 }),
    gd({ findingType: "Recon:EC2/PortProbeUnprotectedPort", severity: 7.0 }),
    gd({ findingType: "UnauthorizedAccess:EC2/SSHBruteForce", severity: 5.0 }),
    gd({ findingType: "Discovery:S3/TorIPCaller", severity: 2.0 }),
  ]);
  const bands = new Map(report.detections.map((detection) => [detection.evidence.name, detection.severity]));
  assert.equal(bands.get("Backdoor:EC2/C&CActivity.B"), "critical");
  assert.equal(bands.get("Recon:EC2/PortProbeUnprotectedPort"), "high");
  assert.equal(bands.get("UnauthorizedAccess:EC2/SSHBruteForce"), "medium");
  assert.equal(bands.get("Discovery:S3/TorIPCaller"), "low");
  for (const detection of report.detections) {
    assert.equal(detection.ruleId, "guardduty-finding");
    assert.equal(detection.source, "guardduty");
    assert.equal(detection.actor, "unknown");
    assert.equal(detection.resourceRef, "i-0abc");
  }
});

test("GuardDuty detections carry no actor identity and are excluded from correlation", () => {
  const report = buildCloudDetections([
    gd({ findingType: "A", severity: 8 }),
    gd({ findingType: "B", severity: 8 }),
  ]);
  assert.equal(report.detections.length, 2);
  assert.equal(report.correlated.length, 0);
});

test("Kubernetes exec into a pod is detected", () => {
  const report = buildCloudDetections([k8s({ verb: "create", resource: "pods/exec", namespace: "payments", user: "dev@corp" })]);
  assert.equal(report.detections.length, 1);
  assert.equal(report.detections[0]?.ruleId, "k8s-exec-into-pod");
  assert.equal(report.detections[0]?.source, "k8s-audit");
  assert.equal(report.detections[0]?.actor, "dev@corp");
  assert.equal(report.detections[0]?.resourceRef, "payments/pods/exec");
  assert.equal(report.detections[0]?.evidence.name, "create pods/exec");
});

test("secret reads are flagged for a non-system user but not for expected system principals", () => {
  assert.deepEqual(
    ruleIds([k8s({ verb: "get", resource: "secrets", user: "alice" })]),
    ["k8s-secret-accessed-by-user"],
  );
  // A system: principal is the expected automated reader -> recognized, no detection.
  const system = buildCloudDetections([k8s({ verb: "get", resource: "secrets", user: "system:serviceaccount:kube-system:token-cleaner" })]);
  assert.equal(system.detections.length, 0);
  assert.equal(system.summary.evaluated, 1);
  assert.equal(system.summary.unclassified, 0);
});

test("ClusterRoleBinding severity reflects what the evidence proves about the bound role", () => {
  assert.deepEqual(
    buildCloudDetections([k8s({ verb: "create", resource: "clusterrolebindings/cluster-admin" })]).detections.map((d) => [d.ruleId, d.severity]),
    [["k8s-clusterrolebinding-cluster-admin", "critical"]],
  );
  assert.deepEqual(
    buildCloudDetections([k8s({ verb: "create", resource: "clusterrolebindings/admin" })]).detections.map((d) => [d.ruleId, d.severity]),
    [["k8s-clusterrolebinding-privileged", "high"]],
  );
  // No bound-role segment -> the granted role is unresolved, not assumed cluster-admin.
  assert.deepEqual(
    buildCloudDetections([k8s({ verb: "create", resource: "clusterrolebindings" })]).detections.map((d) => [d.ruleId, d.severity]),
    [["k8s-clusterrolebinding-created", "medium"]],
  );
});

test("a Kubernetes verb the engine has no rule for is unclassified", () => {
  const report = buildCloudDetections([k8s({ verb: "get", resource: "pods", user: "alice" })]);
  assert.equal(report.detections.length, 0);
  assert.equal(report.summary.unclassified, 1);
  assert.equal(report.summary.evaluated, 0);
});

test("empty input yields no detections, no correlations, and honest zeroed totals", () => {
  const report = buildCloudDetections([]);
  assert.equal(report.detections.length, 0);
  assert.equal(report.correlated.length, 0);
  assert.deepEqual(report.summary, {
    events: 0,
    evaluated: 0,
    unclassified: 0,
    detections: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    bySource: { cloudtrail: 0, guardduty: 0, "k8s-audit": 0 },
  });
  assert.match(report.disclaimer, /unclassified/u);
  assert.match(report.disclaimer, /caller's responsibility/u);
});

test("sourceIp is cited when present and omitted when absent, never synthesized", () => {
  const withIp = buildCloudDetections([ct({ eventName: "StopLogging", sourceIp: "203.0.113.7" })]);
  assert.equal(withIp.detections[0]?.evidence.sourceIp, "203.0.113.7");
  const withoutIp = buildCloudDetections([ct({ eventName: "StopLogging" })]);
  assert.equal(Object.prototype.hasOwnProperty.call(withoutIp.detections[0]?.evidence ?? {}, "sourceIp"), false);
});

test("resourceRef is present only when the evidence supplies it", () => {
  const withRef = buildCloudDetections([ct({ eventName: "StopLogging", params: { trailName: "t" } })]);
  assert.equal(withRef.detections[0]?.resourceRef, "t");
  const withoutRef = buildCloudDetections([ct({ eventName: "StopLogging" })]);
  assert.equal(Object.prototype.hasOwnProperty.call(withoutRef.detections[0] ?? {}, "resourceRef"), false);
});

test("tenant is threaded from each event onto its detection", () => {
  const report = buildCloudDetections([
    ct({ eventName: "StopLogging", tenant: "acme" }),
    ct({ eventName: "StopLogging" }),
  ]);
  const tenants = report.detections.map((detection) => detection.tenant);
  assert.equal(tenants.filter((tenant) => tenant === "acme").length, 1);
  assert.equal(tenants.filter((tenant) => tenant === null).length, 1);
});

test("correlation is tenant-scoped: the same actor in two tenants is two identities", () => {
  const events: CloudDetectionEvent[] = [
    ct({ eventName: "StopLogging", principal: "u1", tenant: "acme" }),
    ct({ eventName: "AuthorizeSecurityGroupIngress", principal: "u1", tenant: "acme", params: { cidr: "0.0.0.0/0" } }),
    ct({ eventName: "StopLogging", principal: "u1", tenant: "globex" }),
    ct({ eventName: "AuthorizeSecurityGroupIngress", principal: "u1", tenant: "globex", params: { cidr: "0.0.0.0/0" } }),
  ];
  const report = buildCloudDetections(events);
  assert.equal(report.correlated.length, 2);
  assert.deepEqual(report.correlated.map((group) => group.tenant), ["acme", "globex"]);
  for (const group of report.correlated) {
    assert.equal(group.actor, "u1");
    assert.equal(group.detectionIds.length, 2);
  }
});

test("an unrecognized source is counted as unclassified rather than dropped", () => {
  const junk = { source: "azure-activity", op: "whatever", time: T } as unknown as CloudDetectionEvent;
  const report = buildCloudDetections([junk]);
  assert.equal(report.detections.length, 0);
  assert.equal(report.summary.events, 1);
  assert.equal(report.summary.unclassified, 1);
  assert.equal(report.summary.evaluated, 0);
});

test("summary invariant: events always equals evaluated plus unclassified", () => {
  const events: CloudDetectionEvent[] = [
    ct({ eventName: "StopLogging" }),
    ct({ eventName: "DescribeInstances" }),
    gd({ findingType: "X", severity: 6 }),
    k8s({ verb: "create", resource: "pods/exec" }),
    k8s({ verb: "get", resource: "configmaps", user: "alice" }),
  ];
  const report = buildCloudDetections(events);
  assert.equal(report.summary.events, 5);
  assert.equal(report.summary.evaluated + report.summary.unclassified, report.summary.events);
  assert.equal(report.summary.detections, report.detections.length);
});

test("every detection is labeled with the source that proved it and a confidence", () => {
  const report = buildCloudDetections([
    ct({ eventName: "StopLogging" }),
    gd({ findingType: "Backdoor:EC2/C&CActivity.B", severity: 8.5 }),
    gd({ findingType: "Discovery:S3/TorIPCaller", severity: 2.0 }),
    k8s({ verb: "create", resource: "pods/exec", user: "dev@corp" }),
    k8s({ verb: "create", resource: "clusterrolebindings" }),
  ]);
  const byRule = new Map(report.detections.map((detection) => [detection.ruleId, detection]));
  // CloudTrail + Kubernetes rules fire only on proven evidence -> high confidence.
  assert.equal(byRule.get("cloudtrail-logging-disabled")?.source, "cloudtrail");
  assert.equal(byRule.get("cloudtrail-logging-disabled")?.confidence, "high");
  assert.equal(byRule.get("k8s-exec-into-pod")?.source, "k8s-audit");
  assert.equal(byRule.get("k8s-exec-into-pod")?.confidence, "high");
  // A ClusterRoleBinding whose bound role is not in the evidence is medium.
  assert.equal(byRule.get("k8s-clusterrolebinding-created")?.confidence, "medium");
  // GuardDuty findings inherit the confidence band of the provider's severity.
  const guardDuty = report.detections.filter((detection) => detection.source === "guardduty");
  const high = guardDuty.find((detection) => detection.evidence.name === "Backdoor:EC2/C&CActivity.B");
  const low = guardDuty.find((detection) => detection.evidence.name === "Discovery:S3/TorIPCaller");
  assert.equal(high?.confidence, "high");
  assert.equal(low?.confidence, "low");
});

test("a mid-band GuardDuty finding is medium confidence", () => {
  const report = buildCloudDetections([gd({ findingType: "UnauthorizedAccess:EC2/SSHBruteForce", severity: 5.0 })]);
  assert.equal(report.detections[0]?.source, "guardduty");
  assert.equal(report.detections[0]?.severity, "medium");
  assert.equal(report.detections[0]?.confidence, "medium");
});

test("multi-source merge: three sources are counted, labeled, and correlated honestly in one report", () => {
  const events: CloudDetectionEvent[] = [
    // CloudTrail + Kubernetes for the SAME tenant-scoped actor -> correlated.
    ct({ eventName: "StopLogging", principal: "alice", tenant: "acme" }),
    k8s({ verb: "get", resource: "secrets", user: "alice", tenant: "acme" }),
    // A GuardDuty finding for the same tenant -> its own detection, but excluded
    // from correlation because a finding carries no actor identity.
    gd({ findingType: "Backdoor:EC2/C&CActivity.B", severity: 8.0, tenant: "acme" }),
  ];
  const report = buildCloudDetections(events);
  // Per-source provenance counts are exact.
  assert.deepEqual(report.summary.bySource, { cloudtrail: 1, guardduty: 1, "k8s-audit": 1 });
  assert.equal(report.summary.events, 3);
  assert.equal(report.summary.detections, 3);
  // Every detection is labeled by its real source; none is blurred.
  assert.deepEqual(
    new Set(report.detections.map((detection) => detection.source)),
    new Set(["cloudtrail", "guardduty", "k8s-audit"]),
  );
  // Correlation groups only the two same-actor detections; the GuardDuty
  // finding (actor "unknown") is never fabricated into the group.
  assert.equal(report.correlated.length, 1);
  assert.equal(report.correlated[0]?.actor, "alice");
  assert.equal(report.correlated[0]?.detectionIds.length, 2);
  const guardDuty = report.detections.find((detection) => detection.source === "guardduty");
  assert.equal(guardDuty?.actor, "unknown");
  for (const id of report.correlated[0]?.detectionIds ?? []) {
    assert.notEqual(id, guardDuty?.id);
  }
});

test("output is deterministic and independent of input ordering", () => {
  const events: CloudDetectionEvent[] = [
    ct({ eventName: "StopLogging", principal: "u2" }),
    gd({ findingType: "X", severity: 8 }),
    k8s({ verb: "create", resource: "pods/exec", user: "u3" }),
    ct({ eventName: "AuthorizeSecurityGroupIngress", principal: "u2", params: { cidr: "0.0.0.0/0" } }),
  ];
  const forward = buildCloudDetections(events);
  const reversed = buildCloudDetections([...events].reverse());
  assert.deepEqual(forward, reversed);
  assert.deepEqual(buildCloudDetections(events), forward);
});
