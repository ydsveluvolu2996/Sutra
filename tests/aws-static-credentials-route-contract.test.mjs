import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const credentialsRoute = await readFile(
  new URL("../app/api/pilot/connections/credentials/route.ts", import.meta.url),
  "utf8",
);
const onboardingRoute = await readFile(
  new URL("../app/api/pilot/connections/route.ts", import.meta.url),
  "utf8",
);
const validateRoute = await readFile(
  new URL("../app/api/pilot/connections/validate/route.ts", import.meta.url),
  "utf8",
);
const offboardRoute = await readFile(
  new URL("../app/api/pilot/connections/offboard/route.ts", import.meta.url),
  "utf8",
);
const pilotServer = await readFile(new URL("../lib/pilot-server.ts", import.meta.url), "utf8");
const pilotRepository = await readFile(
  new URL("../db/pilot-repository.ts", import.meta.url),
  "utf8",
);
const securityBoundary = await readFile(
  new URL("../lib/aws-pilot-security.ts", import.meta.url),
  "utf8",
);
const hostedCollectorJob = await readFile(
  new URL("../lib/hosted-collector-job.ts", import.meta.url),
  "utf8",
);

test("credential submission route keeps the exact security boundary of the role route", () => {
  // Exact parser, capability, and same-origin checks.
  assert.match(credentialsRoute, /parseAwsStaticCredentialsSubmission\(await readBoundedJson\(request\)\)/u);
  assert.match(credentialsRoute, /requirePilotActor\(request, "workspace:read"\)/u);
  assert.match(credentialsRoute, /assertSameOrigin\(request\)/u);
  assert.match(credentialsRoute, /assertSessionCapability\(actor\.authenticated, "connection:manage", stored\.customerId\)/u);
  assert.match(credentialsRoute, /withLocalOnboardingAccountLock\(/u);
  // Server-side tenant binding on every repository and collector call.
  assert.match(credentialsRoute, /getStoredConnectionSecretForOrg\(actor\.orgId, body\.connectionId\)/u);
  assert.match(credentialsRoute, /commitVerifiedConnectionCredentials\(\{[\s\S]*?orgId: actor\.orgId/u);
  // Post-lock drift re-check and fail-closed state guards.
  assert.match(credentialsRoute, /current\.customerId !== stored\.customerId/u);
  assert.match(credentialsRoute, /current\.sourceKind !== "aws_static_credentials"/u);
  assert.match(credentialsRoute, /current\.status === "disabled"/u);
  assert.match(credentialsRoute, /health\.mode !== "live"/u);
  assert.match(credentialsRoute, /!health\.staticCredentials\.ready/u);
  assert.match(credentialsRoute, /registration\.secretReference\.secretArn\.split\(":"\)\[4\] !== health\.sourceAccountId/u);
});

test("credential submission stages, verifies, commits, then activates in order", () => {
  const stage = credentialsRoute.indexOf("stageCollector: registerCredentialsWithCollector");
  const verify = credentialsRoute.indexOf("verifyCollector: verifyCredentialsWithCollector");
  const commit = credentialsRoute.indexOf("commitVerifiedControlPlaneRole:");
  const activate = credentialsRoute.indexOf("activateCollector:");
  const finalize = credentialsRoute.indexOf("finalizeControlPlaneActivation:");
  const compensate = credentialsRoute.indexOf("compensateStagedCollector:");
  assert.ok(stage > 0 && verify > stage && commit > verify && activate > commit
    && finalize > activate && compensate > finalize);
  assert.match(credentialsRoute, /stageVerifyThenCommitRole\(\{/u);
  // Activation and compensation reuse the shared lifecycle calls with an empty
  // roleArn, matching the fixed collector wire contract.
  assert.match(credentialsRoute, /activateCollectorConnection\(\{[\s\S]*?roleArn: "",[\s\S]*?secretVersionId:/u);
  assert.match(credentialsRoute, /discardStagedCollectorConnection\(\{[\s\S]*?roleArn: "",[\s\S]*?secretVersionId:/u);
  assert.match(credentialsRoute, /finalizeControlPlaneActivation:[\s\S]*?activateVerifiedConnectionCredentials\(\{/u);
  // The first collection is enqueued durably with a stable operation id.
  assert.match(credentialsRoute, /enqueueTenantCollectionJob\(new JobQueueRepository\(\), \{/u);
  assert.match(
    credentialsRoute,
    /onboardingCollectionOperationId\([\s\S]*?current\.connectionId,[\s\S]*?requireStagedSecretReference\(stagedSecretReference\)\.versionId/u,
  );
  assert.match(credentialsRoute, /collection: \{ jobId: collection\.jobId, status: "queued" \}/u);
});

test("credentials never reach logs, responses, audit calls, or database writes", () => {
  // No console logging anywhere in the route.
  assert.doesNotMatch(credentialsRoute, /console\./u);
  // The raw credential fields are only ever forwarded inside the one
  // staticCredentials broker registration binding; they must never be
  // interpolated into a response, jsonResponse, error, or audit call.
  const jsonResponseCalls = credentialsRoute.match(/jsonResponse\(\{[\s\S]*?\n {8}\}\)/gu) ?? [];
  assert.ok(jsonResponseCalls.length > 0);
  for (const call of jsonResponseCalls) {
    assert.doesNotMatch(call, /secretAccessKey|sessionToken|accessKeyId/u);
  }
  for (const errorThrow of credentialsRoute.match(/new Error\([^)]*\)/gu) ?? []) {
    assert.doesNotMatch(errorThrow, /secretAccessKey|sessionToken|accessKeyId|\$\{/u);
  }
  // The only accessKeyId/secret references outside imports and
  // comments are the parser result and the staticCredentials broker binding.
  assert.match(credentialsRoute, /staticCredentials: \{\s*accessKeyId: body\.accessKeyId,\s*secretAccessKey: body\.secretAccessKey,\s*\}/u);
  // The DB commit persists only the exact non-secret ARN/version/last4 pointer;
  // raw credential fields never appear in the repository.
  const commitFunction = pilotRepository.slice(
    pilotRepository.indexOf("async function commitVerifiedConnectionCredentialsWithAtomicAudit"),
    pilotRepository.indexOf("export function disableAwsConnection"),
  );
  assert.ok(commitFunction.length > 0);
  assert.match(commitFunction, /SET credential_secret_arn = \?, credential_secret_version_id = \?,[\s\S]*?credential_access_key_last4 = \?, status = 'validating'/u);
  assert.match(commitFunction, /activateVerifiedConnectionCredentials[\s\S]*?SET status = 'active'/u);
  assert.match(credentialsRoute, /secretReference: requireStagedSecretReference\(stagedSecretReference\)/u);
  assert.doesNotMatch(commitFunction, /secretAccessKey|sessionToken|secret_access_key|session_token|accessKeyId(?!Last)/u);
  assert.doesNotMatch(pilotRepository, /secretAccessKey|sessionToken|secret_access_key|session_token/u);
  // The audit metadata may carry only the accessKeyLast4 derivative.
  assert.match(commitFunction, /accessKeyLast4: input\.verification\.accessKeyLast4/u);
  assert.match(commitFunction, /credentialsStoredInControlPlane: false/u);
});

test("collector wire contract matches the fixed static registration and verification shapes", () => {
  assert.match(pilotServer, /credentialKind: "static_credentials"/u);
  assert.match(
    pilotServer,
    /registerCollectorStaticCredentialConnection[\s\S]*?brokerFetch<unknown>\(`\/v1\/connections\/\$\{input\.connectionId\}`, "PUT"/u,
  );
  // Registration for static connections carries no role-contract keys.
  const registration = pilotServer.slice(
    pilotServer.indexOf("export async function registerCollectorStaticCredentialConnection"),
    pilotServer.indexOf("export async function activateCollectorConnection"),
  );
  assert.ok(registration.length > 0);
  assert.doesNotMatch(registration, /roleArn|externalId|roleProvisioningMode|expectedRolePath|expectedRoleName/u);
  // Verification uses the same verify action and payload, with a strict
  // exact-shape response parser cross-checked against caller expectations.
  assert.match(
    pilotServer,
    /verifyCollectorCredentialConnection[\s\S]*?\{ tenantId: input\.tenantId, connectionId: input\.connectionId, jobId: input\.jobId \}/u,
  );
  assert.match(pilotServer, /parseStaticCredentialVerificationResponse\(/u);
  assert.match(pilotServer, /\{ accountId: input\.accountId, partition: input\.partition \}/u);
});

test("static revalidation and offboarding stay method-specific", () => {
  const staticBranch = validateRoute.slice(
    validateRoute.indexOf('if (stored.sourceKind === "aws_static_credentials") {',
      validateRoute.indexOf("validationClaimed = true")),
    validateRoute.indexOf("if (!stored.roleArn)"),
  );
  assert.ok(staticBranch.length > 0);
  assert.match(staticBranch, /credentialSecretArn === null/u);
  assert.match(staticBranch, /credentialSecretVersionId === null/u);
  assert.match(staticBranch, /credentialAccessKeyLast4 === null/u);
  assert.match(staticBranch, /verifyCollectorCredentialConnection\(\{/u);
  assert.match(staticBranch, /commitVerifiedConnectionCredentials\(\{[\s\S]*?secretReference:/u);
  assert.match(staticBranch, /activateCollectorConnection\(\{[\s\S]*?roleArn: ""/u);
  assert.doesNotMatch(staticBranch, /decryptExternalId|registerCollectorConnection/u);
  assert.match(
    offboardRoute,
    /customerIamRoleRevocationRequired: current\.sourceKind === "aws_trust_role"/u,
  );
  assert.match(
    offboardRoute,
    /customerAccessKeyRevocationRequired: current\.sourceKind === "aws_static_credentials"/u,
  );
});

test("draft onboarding and ownership boundaries recognize both live source kinds", () => {
  // The onboarding route maps the parsed method onto the persisted kind and
  // skips the public CloudFormation template for static drafts.
  assert.match(
    onboardingRoute,
    /sourceKind: body\.connectionMethod === "static_credentials"\s*\?\s*"aws_static_credentials"\s*:\s*"aws_trust_role"/u,
  );
  assert.match(onboardingRoute, /body\.connectionMethod === "static_credentials"[\s\S]*?createHandoff\(null\)/u);
  // One live owner per account across both kinds.
  assert.match(
    pilotRepository,
    /liveAccountOwnershipExists[\s\S]*?source_kind IN \('aws_trust_role', 'aws_static_credentials'\)/u,
  );
  // The role ownership query deliberately stays trust-role-only.
  assert.match(
    pilotRepository,
    /liveRoleOwnershipExists[\s\S]*?source_kind = 'aws_trust_role' AND role_arn = \?/u,
  );
  // The static credential parser enforces the exact credential grammar.
  assert.match(securityBoundary, /\^AKIA\[A-Z0-9\]\{16\}\$/u);
  assert.match(securityBoundary, /\^\[A-Za-z0-9\/\+\]\{40\}\$/u);
  assert.match(
    securityBoundary,
    /exactRecord\(value, \[\s*"connectionId",\s*"accessKeyId",\s*"secretAccessKey",\s*\]\)/u,
  );
  assert.doesNotMatch(securityBoundary, /sessionToken/u);
  // The hosted collector job accepts both live kinds through the shared helper.
  assert.match(hostedCollectorJob, /isLiveAwsSourceKind\(connection\.sourceKind\)/u);
});
