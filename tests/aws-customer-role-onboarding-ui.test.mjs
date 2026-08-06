import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/onboard/onboard-account.tsx", import.meta.url),
  "utf8",
);
const roleRoute = await readFile(
  new URL("../app/api/pilot/connections/role/route.ts", import.meta.url),
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

test("onboarding offers both connection methods with the role method recommended", () => {
  assert.match(source, /Connection method/u);
  assert.match(source, /<option value="iam_role">IAM role \(CloudFormation\)<\/option>/u);
  assert.match(source, /<option value="static_credentials">Access keys<\/option>/u);
  // The role flow stays the wire default: connectionMethod is sent only for
  // the static-credential branch of the create call.
  assert.match(source, /connectionMethod: "static_credentials"/u);
  assert.match(source, /IAM role method remains the recommended default/u);
});

test("credentials form posts to the fixed credentials route with masked, non-autofilled inputs", () => {
  assert.match(source, /\/api\/pilot\/connections\/credentials/u);
  assert.match(source, /type="password"/u);
  assert.match(source, /autoComplete="off"/u);
  assert.match(source, /accessKeyLast4/u);
  assert.match(source, /Access key ····/u);
});

test("access-key format and ASIA session-token requirements are enforced client-side", () => {
  assert.match(source, /\^\(AKIA\|ASIA\)\[A-Z0-9\]\{16\}\$/u);
  assert.match(source, /AWS_SECRET_ACCESS_KEY_LENGTH = 40/u);
  assert.match(source, /accessKeyId\.startsWith\("ASIA"\)/u);
  assert.match(source, /!temporaryAccessKey \|\| sessionToken\.trim\(\)\.length > 0/u);
});

test("credential secrets never enter the sessionStorage handoff draft path and are cleared on submit", () => {
  const draftStart = source.indexOf("interface PendingHandoffDraft");
  const draftEnd = source.indexOf("export function OnboardAccount");
  assert.ok(draftStart >= 0 && draftEnd > draftStart);
  const draftPath = source.slice(draftStart, draftEnd);
  assert.match(draftPath, /sessionStorage/u);
  assert.doesNotMatch(draftPath, /accessKeyId|secretAccessKey|sessionToken/u);
  // The static-credential create branch stores no sessionStorage draft at all.
  const staticCreate = source.slice(
    source.indexOf('if (connectionMethod === "static_credentials") {'),
    source.indexOf("const existingDraft"),
  );
  assert.doesNotMatch(staticCreate, /storeHandoffDraft|sessionStorage|accessKeyId|secretAccessKey|sessionToken/u);
  // Submitting clears every secret from component state, success or failure.
  const credentialsStart = source.indexOf("async function registerCredentials");
  const credentialsEnd = source.indexOf("async function validateAndSync", credentialsStart);
  const credentials = source.slice(credentialsStart, credentialsEnd);
  assert.match(credentials, /setAccessKeyId\(""\)/u);
  assert.match(credentials, /setSecretAccessKey\(""\)/u);
  assert.match(credentials, /setSessionToken\(""\)/u);
});

test("role registration reuses the MFA-verified session without a second onboarding code", () => {
  const registrationStart = source.indexOf("async function registerRole");
  const validationStart = source.indexOf("async function validateAndSync", registrationStart);
  const registration = source.slice(registrationStart, validationStart);
  assert.doesNotMatch(registration, /mfa\/step-up|roleStepUpCode|one-time-code/u);
  assert.doesNotMatch(roleRoute, /requireRecentMfa/u);
  assert.match(roleRoute, /requirePilotActor\(request, "workspace:read"\)/u);
  assert.match(roleRoute, /assertSameOrigin\(request\)/u);
  assert.match(roleRoute, /assertSessionCapability\(actor\.authenticated, "connection:manage", stored\.customerId\)/u);
  assert.match(source, /existing MFA-verified Sutra session authorizes this step/u);
});
