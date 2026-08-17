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
  // Both role contracts are still offered; they are now cards rather than the
  // second of two nested selects.
  assert.match(source, /id: "sutra_template_role"/u);
  assert.match(source, /id: "customer_managed_role"/u);
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

test("all three access-grant paths are visible in one step, customer-managed first", () => {
  // The customer-managed role answers the objection that actually blocks
  // onboarding -- a Sutra CloudFormation stack raising drift alerts in the
  // customer's account -- but it used to appear only after choosing "IAM
  // role", so it read as missing. All three are now one choice.
  const start = source.indexOf("const ONBOARD_PATHS");
  assert.ok(start > 0, "the paths must be declared as data, not inline markup");
  const paths = source.slice(start, source.indexOf("] as const)", start));
  const order = [...paths.matchAll(/id: "([a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(order, ["customer_managed_role", "sutra_template_role", "static_credentials"]);
  // Exactly one path is recommended, and it is the one that deploys nothing in
  // the customer's account.
  assert.equal([...paths.matchAll(/recommended: true/gu)].length, 1);
  const recommended = paths.slice(0, paths.indexOf("recommended: true"));
  assert.equal(recommended.lastIndexOf('id: "customer_managed_role"') > -1, true);
  assert.ok(
    !recommended.includes('id: "sutra_template_role"'),
    "the recommendation must sit on the customer-managed path",
  );
  // The trade-off each path carries is stated rather than left to be discovered.
  assert.match(paths, /No stack in their account/u);
  assert.match(paths, /Creates a stack/u);
  assert.match(paths, /Customer must rotate/u);

  // Selecting a card writes both underlying values, so the wire contract is
  // unchanged: connectionMethod is sent only for the static-credential branch.
  assert.match(source, /function selectOnboardPath\(next: OnboardPath\): void/u);
  assert.match(source, /connectionMethod: "static_credentials"/u);

  assert.match(source, /How will the customer grant access\?/u);
  // Native radios keep keyboard and assistive-technology behaviour.
  assert.match(source, /type="radio"/u);
  assert.match(source, /name="onboard-path"/u);
});

test("the onboarding sidebar no longer explains the isolation model", () => {
  // Isolation is enforced in the repository layer and asserted by
  // tests/explicit-org-scope.test.mjs. Restating it beside the form spent the
  // reader's attention and pushed the live collector state below the fold.
  assert.doesNotMatch(source, /Trust checklist/u);
  assert.doesNotMatch(source, /Customer stays in control/u);
  assert.doesNotMatch(source, /Credential path/u);
  // The operational state stays: it changes what the operator can do next.
  assert.match(source, /Collector mode/u);
});

test("credentials form posts to the fixed credentials route with masked, non-autofilled inputs", () => {
  assert.match(source, /\/api\/pilot\/connections\/credentials/u);
  assert.match(source, /type="password"/u);
  assert.match(source, /autoComplete="off"/u);
  assert.match(source, /accessKeyLast4/u);
  assert.match(source, /Access key ····/u);
});

test("access-key format is restricted to persistent AKIA IAM-user credentials", () => {
  assert.match(source, /\^AKIA\[A-Z0-9\]\{16\}\$/u);
  assert.match(source, /AWS_SECRET_ACCESS_KEY_LENGTH = 40/u);
  assert.doesNotMatch(source, /accessKeyId\.startsWith\("ASIA"\)|sessionToken/u);
  assert.match(source, /temporary ASIA session credentials are not accepted/u);
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
  assert.doesNotMatch(credentials, /sessionToken/u);
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
