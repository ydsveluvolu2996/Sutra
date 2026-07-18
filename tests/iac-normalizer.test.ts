import assert from "node:assert/strict";
import test from "node:test";

import { scanIacResources } from "../lib/iac-misconfiguration.ts";
import {
  IAC_NORMALIZER_DISCLAIMER,
  normalizeIac,
  normalizeKubernetesManifests,
  normalizeTerraformPlan,
} from "../lib/iac-normalizer.ts";

function plannedPlan(resources: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { planned_values: { root_module: { resources } } };
}

// ---- Terraform: happy path and end-to-end through the real scanner ----

test("a terraform aws_s3_bucket with a public acl normalizes so the scanner flags it", () => {
  const normalized = normalizeTerraformPlan(plannedPlan([
    { type: "aws_s3_bucket", name: "public", address: "aws_s3_bucket.public", values: { bucket: "b", acl: "public-read" } },
  ]));
  assert.deepEqual(normalized, [
    { kind: "aws_s3_bucket", name: "public", config: { bucket: "b", acl: "public-read" } },
  ]);

  const report = scanIacResources(normalized);
  const finding = report.findings.find((item) => item.ruleId === "S3_PUBLIC_ACL");
  assert.ok(finding !== undefined);
  assert.equal(finding.severity, "high");
  assert.equal(finding.kind, "aws_s3_bucket");
  assert.equal(finding.resourceName, "public");
  assert.equal(finding.evidencePath, "config.acl");
});

test("terraform security-group ingress passes through faithfully and the scanner flags SSH", () => {
  const normalized = normalizeTerraformPlan(plannedPlan([
    {
      type: "aws_security_group", name: "ssh",
      values: { ingress: [{ protocol: "tcp", from_port: 22, to_port: 22, cidr_blocks: ["0.0.0.0/0"] }] },
    },
  ]));
  const report = scanIacResources(normalized);
  const finding = report.findings.find((item) => item.ruleId === "SG_UNRESTRICTED_INGRESS");
  assert.ok(finding !== undefined);
  assert.match(finding.message, /SSH/u);
  assert.equal(finding.evidencePath, "config.ingress[0]");
});

test("terraform values for db/ebs pass through so publicly-accessible + unencrypted are flagged", () => {
  const normalized = normalizeTerraformPlan(plannedPlan([
    { type: "aws_db_instance", name: "db", values: { publicly_accessible: true, storage_encrypted: false } },
    { type: "aws_ebs_volume", name: "vol", values: { encrypted: false } },
  ]));
  const report = scanIacResources(normalized);
  assert.deepEqual(
    report.findings.map((item) => item.ruleId).sort(),
    ["EBS_NOT_ENCRYPTED", "RDS_PUBLICLY_ACCESSIBLE", "RDS_STORAGE_NOT_ENCRYPTED"],
  );
});

test("terraform reads resource_changes (change.after) when planned_values is absent", () => {
  const normalized = normalizeTerraformPlan({
    resource_changes: [
      {
        type: "aws_ebs_volume", name: "vol", address: "aws_ebs_volume.vol",
        change: { actions: ["create"], after: { encrypted: false } },
      },
    ],
  });
  assert.deepEqual(normalized, [{ kind: "aws_ebs_volume", name: "vol", config: { encrypted: false } }]);
  assert.equal(scanIacResources(normalized).findings[0]?.ruleId, "EBS_NOT_ENCRYPTED");
});

test("a resource present in both planned_values and resource_changes is not double-counted", () => {
  const normalized = normalizeTerraformPlan({
    planned_values: { root_module: { resources: [
      { type: "aws_ebs_volume", name: "vol", address: "aws_ebs_volume.vol", values: { encrypted: false } },
    ] } },
    resource_changes: [
      { type: "aws_ebs_volume", name: "vol", address: "aws_ebs_volume.vol", change: { after: { encrypted: false } } },
    ],
  });
  assert.equal(normalized.length, 1);
});

test("terraform resources inside child_modules are collected, never dropped", () => {
  const normalized = normalizeTerraformPlan({
    planned_values: { root_module: {
      resources: [{ type: "aws_ebs_volume", name: "root", values: { encrypted: false } }],
      child_modules: [
        { resources: [{ type: "aws_ebs_volume", name: "child", values: { encrypted: false } }] },
        { child_modules: [{ resources: [{ type: "aws_ebs_volume", name: "grandchild", values: { encrypted: false } }] }] },
      ],
    } },
  });
  assert.deepEqual(normalized.map((item) => item.name).sort(), ["child", "grandchild", "root"]);
});

// ---- Kubernetes: happy path and end-to-end through the real scanner ----

test("a k8s privileged Pod normalizes so the scanner flags it", () => {
  const normalized = normalizeKubernetesManifests([
    {
      apiVersion: "v1", kind: "Pod", metadata: { name: "priv" },
      spec: { containers: [{ name: "app", securityContext: { privileged: true } }] },
    },
  ]);
  assert.deepEqual(normalized, [
    { kind: "kubernetes_pod", name: "priv", config: { privileged: true, has_resource_limits: false } },
  ]);

  const report = scanIacResources(normalized);
  const finding = report.findings.find((item) => item.ruleId === "K8S_POD_PRIVILEGED");
  assert.ok(finding !== undefined);
  assert.equal(finding.severity, "critical");
  assert.equal(finding.kind, "kubernetes_pod");
  assert.equal(finding.resourceName, "priv");
});

test("a k8s Pod maps host_network, run_as_non_root and resource limits into scanner flags", () => {
  const normalized = normalizeKubernetesManifests([
    {
      kind: "Pod", metadata: { name: "risky" },
      spec: {
        hostNetwork: true,
        securityContext: { runAsNonRoot: false },
        containers: [{ name: "app", securityContext: { privileged: false } }],
      },
    },
  ]);
  assert.deepEqual(normalized[0]?.config, {
    host_network: true, privileged: false, run_as_non_root: false, has_resource_limits: false,
  });
  const report = scanIacResources(normalized);
  assert.deepEqual(
    report.findings.map((item) => item.ruleId).sort(),
    ["K8S_POD_HOST_NETWORK", "K8S_POD_MISSING_RESOURCE_LIMITS", "K8S_POD_RUN_AS_NON_ROOT"],
  );
});

test("a hardened k8s Pod yields safe config values and no findings", () => {
  const normalized = normalizeKubernetesManifests([
    {
      kind: "Pod", metadata: { name: "hardened" },
      spec: {
        hostNetwork: false,
        securityContext: { runAsNonRoot: true },
        containers: [{
          name: "app",
          securityContext: { privileged: false },
          resources: { limits: { cpu: "500m", memory: "256Mi" } },
        }],
      },
    },
  ]);
  assert.deepEqual(normalized[0]?.config, {
    host_network: false, privileged: false, run_as_non_root: true, has_resource_limits: true,
  });
  assert.equal(scanIacResources(normalized).findings.length, 0);
});

test("privileged aggregates across containers: any explicit true wins over an unset sibling", () => {
  const normalized = normalizeKubernetesManifests([
    {
      kind: "Pod", metadata: { name: "mixed" },
      spec: { containers: [
        { name: "a", securityContext: { privileged: true } },
        { name: "b" },
      ] },
    },
  ]);
  assert.equal(normalized[0]?.config.privileged, true);
});

test("pod-level runAsNonRoot is inherited when a container does not override it", () => {
  const normalized = normalizeKubernetesManifests([
    {
      kind: "Pod", metadata: { name: "inherit" },
      spec: { securityContext: { runAsNonRoot: true }, containers: [{ name: "a" }] },
    },
  ]);
  assert.equal(normalized[0]?.config.run_as_non_root, true);
});

test("a k8s Deployment pod template is extracted and evaluated as a kubernetes_pod", () => {
  const normalized = normalizeKubernetesManifests([
    {
      kind: "Deployment", metadata: { name: "web" },
      spec: { template: { spec: { containers: [{ name: "app", securityContext: { privileged: true } }] } } },
    },
  ]);
  assert.equal(normalized[0]?.kind, "kubernetes_pod");
  assert.equal(normalized[0]?.config.privileged, true);
  assert.ok(scanIacResources(normalized).findings.some((item) => item.ruleId === "K8S_POD_PRIVILEGED"));
});

test("a k8s CronJob nested pod template is extracted as a kubernetes_pod", () => {
  const normalized = normalizeKubernetesManifests([
    {
      kind: "CronJob", metadata: { name: "batch" },
      spec: { jobTemplate: { spec: { template: { spec: {
        containers: [{ name: "app", securityContext: { privileged: true } }],
      } } } } },
    },
  ]);
  assert.equal(normalized[0]?.kind, "kubernetes_pod");
  assert.equal(normalized[0]?.config.privileged, true);
});

// ---- Honesty edges: absent stays absent, wrong types read as absent ----

test("a source missing a field yields config without that field (terraform)", () => {
  const normalized = normalizeTerraformPlan(plannedPlan([
    { type: "aws_s3_bucket", name: "b", values: { bucket: "only-name" } },
  ]));
  assert.equal("acl" in normalized[0]!.config, false);
  // The scanner then records acl-dependent rules as field-absent, not a fail.
  const report = scanIacResources(normalized);
  assert.equal(report.findings.length, 0);
  assert.ok(report.coverage.notEvaluated.every((item) => item.reason === "field-absent"));
});

test("a k8s Pod with no securityContext yields config without a privileged flag", () => {
  const normalized = normalizeKubernetesManifests([
    { kind: "Pod", metadata: { name: "bare" }, spec: { containers: [{ name: "app" }] } },
  ]);
  assert.equal("privileged" in normalized[0]!.config, false);
  assert.equal("run_as_non_root" in normalized[0]!.config, false);
  assert.equal("host_network" in normalized[0]!.config, false);
  // Only the presence-derived has_resource_limits is emitted, never fabricated booleans.
  assert.deepEqual(normalized[0]!.config, { has_resource_limits: false });

  const report = scanIacResources(normalized);
  assert.equal(report.findings.some((item) => item.ruleId === "K8S_POD_PRIVILEGED"), false);
  assert.ok(report.coverage.notEvaluated.some((item) => item.ruleId === "K8S_POD_PRIVILEGED"));
});

test("a wrong-typed source field is treated as absent, not coerced", () => {
  const terraform = normalizeTerraformPlan(plannedPlan([
    // hostNetwork-style boolean given as a string must not become a real value.
    { type: "aws_ebs_volume", name: "vol", values: { encrypted: "false" } },
  ]));
  // Passthrough keeps the raw string; the scanner's own reader rejects it as absent.
  assert.equal(terraform[0]?.config.encrypted, "false");
  assert.equal(scanIacResources(terraform).findings.length, 0);

  const k8s = normalizeKubernetesManifests([
    { kind: "Pod", metadata: { name: "p" }, spec: { hostNetwork: "true", containers: [{ name: "a" }] } },
  ]);
  assert.equal("host_network" in k8s[0]!.config, false);
});

test("a pod with no containers cannot prove limits, so has_resource_limits stays absent", () => {
  const normalized = normalizeKubernetesManifests([
    { kind: "Pod", metadata: { name: "empty" }, spec: {} },
  ]);
  assert.deepEqual(normalized[0]?.config, {});
});

// ---- Unknown kinds are surfaced, never dropped ----

test("an unknown terraform resource type appears in the normalized output with raw values", () => {
  const normalized = normalizeTerraformPlan(plannedPlan([
    { type: "aws_lambda_function", name: "fn", values: { runtime: "nodejs20.x", memory_size: 512 } },
  ]));
  assert.deepEqual(normalized, [
    { kind: "aws_lambda_function", name: "fn", config: { runtime: "nodejs20.x", memory_size: 512 } },
  ]);
  const report = scanIacResources(normalized);
  assert.deepEqual(report.coverage.notEvaluated, [
    { resourceName: "fn", kind: "aws_lambda_function", ruleId: null, reason: "kind-not-supported" },
  ]);
});

test("an unknown k8s kind is surfaced as kubernetes_<kind> and reported by scanner coverage", () => {
  const normalized = normalizeKubernetesManifests([
    { kind: "Service", metadata: { name: "svc" }, spec: { type: "LoadBalancer" } },
  ]);
  assert.deepEqual(normalized, [
    { kind: "kubernetes_service", name: "svc", config: { type: "LoadBalancer" } },
  ]);
  assert.equal(scanIacResources(normalized).coverage.notEvaluated[0]?.reason, "kind-not-supported");
});

// ---- sourceRef, combination, determinism, robustness, disclaimer ----

test("sourceRef is passed through when present and omitted when absent", () => {
  const withRef = normalizeTerraformPlan(plannedPlan([
    { type: "aws_ebs_volume", name: "vol", values: { encrypted: false }, sourceRef: { file: "main.tf", line: 12 } },
  ]));
  assert.deepEqual(withRef[0]?.sourceRef, { file: "main.tf", line: 12 });
  assert.deepEqual(scanIacResources(withRef).findings[0]?.sourceRef, { file: "main.tf", line: 12 });

  const withoutRef = normalizeKubernetesManifests([
    { kind: "Pod", metadata: { name: "p" }, spec: { containers: [{ name: "a", securityContext: { privileged: true } }] } },
  ]);
  assert.equal("sourceRef" in withoutRef[0]!, false);
});

test("normalizeIac concatenates terraform then manifest resources for one scanner pass", () => {
  const resources = normalizeIac({
    terraform: plannedPlan([{ type: "aws_ebs_volume", name: "vol", values: { encrypted: false } }]),
    manifests: [
      {
        kind: "Pod", metadata: { name: "p" },
        spec: { containers: [{ name: "a", securityContext: { privileged: true }, resources: { limits: { cpu: "1" } } }] },
      },
    ],
  });
  assert.deepEqual(resources.map((item) => item.kind), ["aws_ebs_volume", "kubernetes_pod"]);
  const report = scanIacResources(resources, { tenant: "acme" });
  assert.equal(report.tenant, "acme");
  assert.deepEqual(
    report.findings.map((item) => item.ruleId).sort(),
    ["EBS_NOT_ENCRYPTED", "K8S_POD_PRIVILEGED"],
  );
});

test("normalization is deterministic for identical input", () => {
  const build = () => normalizeIac({
    terraform: plannedPlan([{ type: "aws_s3_bucket", name: "b", values: { acl: "public-read" } }]),
    manifests: [{ kind: "Pod", metadata: { name: "p" }, spec: { hostNetwork: true, containers: [{ name: "a" }] } }],
  });
  assert.deepEqual(build(), build());
});

test("malformed and empty inputs yield an empty array rather than throwing or fabricating", () => {
  assert.deepEqual(normalizeTerraformPlan(null), []);
  assert.deepEqual(normalizeTerraformPlan(undefined), []);
  assert.deepEqual(normalizeTerraformPlan({}), []);
  assert.deepEqual(normalizeTerraformPlan(plannedPlan([])), []);
  assert.deepEqual(normalizeKubernetesManifests(null), []);
  assert.deepEqual(normalizeKubernetesManifests([]), []);
  assert.deepEqual(normalizeIac(null), []);
  assert.deepEqual(normalizeIac({}), []);
  // Entries that cannot be classified (no type / no kind) are skipped, not faked.
  assert.deepEqual(normalizeTerraformPlan(plannedPlan([{ name: "no-type", values: {} }])), []);
  assert.deepEqual(normalizeKubernetesManifests([{ metadata: { name: "no-kind" }, spec: {} }]), []);
});

test("the disclaimer documents the honesty contract mirroring the sibling scanners", () => {
  assert.match(IAC_NORMALIZER_DISCLAIMER, /never reads files or parses raw/u);
  assert.match(IAC_NORMALIZER_DISCLAIMER, /field-absent/u);
  assert.match(IAC_NORMALIZER_DISCLAIMER, /never dropped/u);
});
