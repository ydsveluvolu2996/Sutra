import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/onboard/onboard-account.tsx", import.meta.url),
  "utf8",
);

test("onboarding offers template and customer-managed role contracts", () => {
  assert.match(source, /Use Sutra template/u);
  assert.match(source, /Use customer-managed role/u);
  assert.match(source, /roleProvisioningMode/u);
  assert.match(source, /rolePath/u);
  assert.match(source, /roleName/u);
  assert.match(source, /validateCustomerManagedRoleSelection/u);
  assert.match(source, /admin, shared operations, power-user, break-glass/u);
});

test("one-time customer-role artifacts are Blob downloads and not query URLs", () => {
  assert.match(source, /buildCustomerManagedRoleArtifacts/u);
  assert.match(source, /URL\.createObjectURL\(new Blob/u);
  assert.match(source, /Download Terraform/u);
  assert.match(source, /Download CloudFormation/u);
  assert.match(source, /Download JSON trust policy/u);
  assert.doesNotMatch(source, /encodeURIComponent\(oneTimeExternalId\)/u);
  assert.match(source, /createdRoleMode !== "sutra_template"/u);
});

test("onboarding surfaces capability gaps and per-scan trust drift behavior", () => {
  assert.match(source, /inline-policy capabilities omitted/u);
  assert.match(source, /Effective access is confirmed separately by collection results/u);
  assert.match(source, /missingActions/u);
  assert.match(source, /re-attests trust and permission drift before every collection/u);
  assert.match(source, /restrictive STS session policy/u);
});
