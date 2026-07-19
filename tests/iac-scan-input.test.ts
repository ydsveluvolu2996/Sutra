import assert from "node:assert/strict";
import test from "node:test";
import { parseIacScanInput } from "../lib/iac-scan-input.ts";
import { normalizeIac } from "../lib/iac-normalizer.ts";
import { scanIacResources } from "../lib/iac-misconfiguration.ts";

test("blank inputs parse to an empty, error-free scan input", () => {
  const result = parseIacScanInput({ terraformText: "   ", manifestsText: "" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.input.terraform, null);
  assert.equal(result.input.manifests, null);
});

test("invalid JSON is reported per input, not thrown", () => {
  const result = parseIacScanInput({ terraformText: "{not json", manifestsText: "also bad" });
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /Terraform plan is not valid JSON/u);
});

test("a single Kubernetes manifest object is wrapped into an array", () => {
  const result = parseIacScanInput({ manifestsText: JSON.stringify({ apiVersion: "v1", kind: "Pod", metadata: { name: "p" }, spec: {} }) });
  assert.deepEqual(result.errors, []);
  assert.equal(Array.isArray(result.input.manifests), true);
  assert.equal(result.input.manifests?.length, 1);
});

test("end-to-end: a parsed Terraform plan flows through normalize + scan to a finding", () => {
  const plan = {
    planned_values: {
      root_module: {
        resources: [
          { type: "aws_s3_bucket", name: "public", address: "aws_s3_bucket.public", values: { acl: "public-read" } },
        ],
      },
    },
  };
  const { input, errors } = parseIacScanInput({ terraformText: JSON.stringify(plan) });
  assert.deepEqual(errors, []);
  const report = scanIacResources(normalizeIac(input));
  assert.ok(report.findings.some((finding) => finding.ruleId === "S3_PUBLIC_ACL"), "the public-ACL bucket is flagged");
});
