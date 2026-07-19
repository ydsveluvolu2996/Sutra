import assert from "node:assert/strict";
import test from "node:test";

import { scanIacResources, type IacResource } from "../lib/iac-misconfiguration.ts";

function resource(
  kind: string,
  name: string,
  config: Record<string, unknown>,
  sourceRef?: IacResource["sourceRef"],
): IacResource {
  return { kind, name, config, ...(sourceRef ? { sourceRef } : {}) };
}

test("flags a public S3 bucket ACL as a high finding and echoes the observed value", () => {
  const report = scanIacResources([
    resource("aws_s3_bucket", "public-bucket", {
      acl: "public-read", server_side_encryption_enabled: true, block_public_access: true,
    }),
  ]);
  assert.equal(report.findings.length, 1);
  const finding = report.findings[0];
  assert.equal(finding?.ruleId, "S3_PUBLIC_ACL");
  assert.equal(finding?.severity, "high");
  assert.equal(finding?.kind, "aws_s3_bucket");
  assert.equal(finding?.resourceName, "public-bucket");
  assert.equal(finding?.evidencePath, "config.acl");
  assert.match(finding?.message ?? "", /public-read/u);
  assert.ok((finding?.remediationHint ?? "").length > 0);
  // Present-and-safe fields pass silently: not findings, not notEvaluated.
  assert.equal(report.coverage.notEvaluated.length, 0);
  assert.deepEqual(report.coverage.evaluatedKinds, ["aws_s3_bucket"]);
});

test("flags security group ingress open to 0.0.0.0/0 on port 22 as SSH", () => {
  const report = scanIacResources([
    resource("aws_security_group", "ssh-sg", {
      ingress: [{ protocol: "tcp", from_port: 22, to_port: 22, cidr_blocks: ["0.0.0.0/0"] }],
    }),
  ]);
  const finding = report.findings.find((item) => item.ruleId === "SG_UNRESTRICTED_INGRESS");
  assert.ok(finding !== undefined);
  assert.equal(finding.severity, "high");
  assert.equal(finding.evidencePath, "config.ingress[0]");
  assert.match(finding.message, /SSH/u);
});

test("flags a security group open to all ports as critical and RDP separately", () => {
  const allPorts = scanIacResources([
    resource("aws_security_group", "all-open", {
      ingress: [{ protocol: "-1", from_port: 0, to_port: 0, cidr_blocks: ["0.0.0.0/0"] }],
    }),
  ]);
  const wide = allPorts.findings.find((item) => item.ruleId === "SG_UNRESTRICTED_INGRESS");
  assert.equal(wide?.severity, "critical");
  assert.match(wide?.message ?? "", /all inbound/u);

  const rdp = scanIacResources([
    resource("aws_security_group", "rdp", {
      ingress: [{ protocol: "tcp", from_port: 3389, to_port: 3389, cidr_blocks: ["0.0.0.0/0"] }],
    }),
  ]);
  assert.match(rdp.findings.find((item) => item.ruleId === "SG_UNRESTRICTED_INGRESS")?.message ?? "", /RDP/u);
});

test("a security group restricted to a private CIDR produces no finding", () => {
  const report = scanIacResources([
    resource("aws_security_group", "internal", {
      ingress: [{ protocol: "tcp", from_port: 22, to_port: 22, cidr_blocks: ["10.0.0.0/8"] }],
    }),
  ]);
  assert.equal(report.findings.length, 0);
  // The ingress field was present, so this is evaluated-clear, not notEvaluated.
  assert.equal(report.coverage.notEvaluated.length, 0);
  assert.deepEqual(report.coverage.evaluatedKinds, ["aws_security_group"]);
});

test("flags an IAM policy granting Action '*' on Resource '*'", () => {
  const report = scanIacResources([
    resource("aws_iam_policy", "admin", {
      statement: [{ effect: "Allow", action: "*", resource: "*" }],
    }),
  ]);
  const finding = report.findings.find((item) => item.ruleId === "IAM_WILDCARD_ACTION_RESOURCE");
  assert.ok(finding !== undefined);
  assert.equal(finding.severity, "critical");
  assert.equal(finding.evidencePath, "config.statement[0]");
});

test("a scoped or half-wildcard IAM statement is not flagged", () => {
  const scoped = scanIacResources([
    resource("aws_iam_policy", "scoped", {
      statement: [{ effect: "Allow", action: ["s3:GetObject"], resource: ["arn:aws:s3:::bucket/*"] }],
    }),
  ]);
  assert.equal(scoped.findings.length, 0);

  // Wildcard action but scoped resource: the rule requires BOTH to be '*'.
  const half = scanIacResources([
    resource("aws_iam_policy", "half", {
      statement: [{ effect: "Allow", action: ["*"], resource: ["arn:aws:s3:::bucket"] }],
    }),
  ]);
  assert.equal(half.findings.length, 0);

  // A Deny with wildcards is not an over-permission.
  const deny = scanIacResources([
    resource("aws_iam_policy", "deny", {
      statement: [{ effect: "Deny", action: "*", resource: "*" }],
    }),
  ]);
  assert.equal(deny.findings.length, 0);
});

test("flags a publicly accessible and unencrypted RDS instance", () => {
  const report = scanIacResources([
    resource("aws_db_instance", "db", { publicly_accessible: true, storage_encrypted: false }),
  ]);
  assert.deepEqual(
    report.findings.map((item) => item.ruleId).sort(),
    ["RDS_PUBLICLY_ACCESSIBLE", "RDS_STORAGE_NOT_ENCRYPTED"],
  );
  assert.equal(report.coverage.notEvaluated.length, 0);
});

test("flags an unencrypted EBS volume as a medium finding", () => {
  const report = scanIacResources([resource("aws_ebs_volume", "data", { encrypted: false })]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.ruleId, "EBS_NOT_ENCRYPTED");
  assert.equal(report.findings[0]?.severity, "medium");
});

test("flags privileged, host-network, root-allowed and limitless kubernetes pods", () => {
  const report = scanIacResources([
    resource("kubernetes_pod", "pod", {
      privileged: true, host_network: true, run_as_non_root: false, has_resource_limits: false,
    }),
  ]);
  assert.deepEqual(
    report.findings.map((item) => item.ruleId).sort(),
    ["K8S_POD_HOST_NETWORK", "K8S_POD_MISSING_RESOURCE_LIMITS", "K8S_POD_PRIVILEGED", "K8S_POD_RUN_AS_NON_ROOT"],
  );
  assert.equal(report.findings.find((item) => item.ruleId === "K8S_POD_PRIVILEGED")?.severity, "critical");
});

test("a hardened kubernetes pod produces no findings and no unknowns", () => {
  const report = scanIacResources([
    resource("kubernetes_pod", "hardened", {
      privileged: false, host_network: false, run_as_non_root: true, has_resource_limits: true,
    }),
  ]);
  assert.equal(report.findings.length, 0);
  assert.equal(report.coverage.notEvaluated.length, 0);
});

test("a missing field a rule needs becomes field-absent, never a false fail", () => {
  const report = scanIacResources([resource("aws_ebs_volume", "data", {})]);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(report.coverage.notEvaluated, [
    { resourceName: "data", kind: "aws_ebs_volume", ruleId: "EBS_NOT_ENCRYPTED", reason: "field-absent" },
  ]);
  // The kind was still evaluated even though its only rule could not decide.
  assert.deepEqual(report.coverage.evaluatedKinds, ["aws_ebs_volume"]);
});

test("a partially specified resource mixes evaluated-clear with field-absent per rule", () => {
  const report = scanIacResources([resource("aws_s3_bucket", "bucket", { acl: "private" })]);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(
    report.coverage.notEvaluated.map((item) => item.ruleId),
    ["S3_NO_BLOCK_PUBLIC_ACCESS", "S3_NO_SERVER_SIDE_ENCRYPTION"],
  );
  assert.ok(report.coverage.notEvaluated.every((item) => item.reason === "field-absent"));
});

test("a wrong-typed field reads as absent rather than being coerced", () => {
  // encrypted is the string "false", not the boolean false: must not be flagged.
  const report = scanIacResources([resource("aws_ebs_volume", "data", { encrypted: "false" })]);
  assert.equal(report.findings.length, 0);
  assert.equal(report.coverage.notEvaluated[0]?.reason, "field-absent");
  assert.equal(report.coverage.notEvaluated[0]?.ruleId, "EBS_NOT_ENCRYPTED");
});

test("empty input yields no findings, empty coverage and zeroed summary", () => {
  const report = scanIacResources([]);
  assert.equal(report.findings.length, 0);
  assert.equal(report.coverage.notEvaluated.length, 0);
  assert.deepEqual(report.coverage.evaluatedKinds, []);
  assert.deepEqual(report.summary, {
    resources: 0, findings: 0, critical: 0, high: 0, medium: 0, low: 0, notEvaluated: 0,
  });
});

test("an unsupported kind is surfaced as kind-not-supported, not silently dropped", () => {
  const report = scanIacResources([resource("aws_lambda_function", "fn", { runtime: "nodejs20.x" })]);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(report.coverage.notEvaluated, [
    { resourceName: "fn", kind: "aws_lambda_function", ruleId: null, reason: "kind-not-supported" },
  ]);
  assert.deepEqual(report.coverage.evaluatedKinds, []);
});

test("sourceRef is propagated to findings when present and omitted when absent", () => {
  const withRef = scanIacResources([
    resource("aws_ebs_volume", "data", { encrypted: false }, { file: "main.tf", line: 12 }),
  ]);
  assert.deepEqual(withRef.findings[0]?.sourceRef, { file: "main.tf", line: 12 });

  const withoutRef = scanIacResources([resource("aws_ebs_volume", "data", { encrypted: false })]);
  assert.equal("sourceRef" in (withoutRef.findings[0] ?? {}), false);
});

test("output is deterministic and findings are ordered by severity", () => {
  const build = () => scanIacResources([
    resource("aws_ebs_volume", "vol", { encrypted: false }), // medium
    resource("aws_iam_policy", "admin", { statement: [{ effect: "Allow", action: "*", resource: "*" }] }), // critical
    resource("kubernetes_pod", "pod", { has_resource_limits: false }), // low
    resource("aws_db_instance", "db", { publicly_accessible: true }), // high
  ], { tenant: "acme" });
  const first = build();
  const second = build();
  assert.deepEqual(first, second);
  assert.deepEqual(first.findings.map((item) => item.severity), ["critical", "high", "medium", "low"]);
  assert.equal(first.tenant, "acme");
});

test("tenant defaults to null and the disclaimer documents the honesty contract", () => {
  const report = scanIacResources([]);
  assert.equal(report.tenant, null);
  assert.equal(report.schema, "sutra.iac-misconfiguration.v1");
  assert.match(report.disclaimer, /field-absent/u);
  assert.match(report.disclaimer, /not proof of a secure configuration/u);
});

test("summary tallies severities and notEvaluated entries", () => {
  const report = scanIacResources([
    resource("aws_s3_bucket", "bucket", { acl: "public-read" }), // 1 high finding; sse + bpa absent
  ]);
  assert.equal(report.summary.resources, 1);
  assert.equal(report.summary.findings, 1);
  assert.equal(report.summary.high, 1);
  assert.equal(report.summary.critical, 0);
  assert.equal(report.summary.notEvaluated, 2);
});
