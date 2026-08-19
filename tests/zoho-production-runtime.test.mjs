import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../deploy/ec2/compose.prod.yaml", import.meta.url), "utf8");
const host = await readFile(
  new URL("../deploy/ec2/cloudformation-single-node.yaml", import.meta.url),
  "utf8",
);
const redeploy = await readFile(new URL("../deploy/ec2/redeploy.sh", import.meta.url), "utf8");
const release = await readFile(new URL("../deploy/ec2/release-update.sh", import.meta.url), "utf8");
const sync = await readFile(new URL("../deploy/ec2/sync-zoho-runtime.sh", import.meta.url), "utf8");
const setup = await readFile(new URL("../scripts/setup-local-pilot.mjs", import.meta.url), "utf8");

test("production can switch between password and Zoho OIDC only through explicit runtime values", () => {
  assert.match(compose, /SUTRA_IDENTITY_MODE: \$\{SUTRA_IDENTITY_MODE:-password\}/u);
  assert.match(compose, /SUTRA_PRIVATE_BETA_OIDC_ENABLED: "true"/u);
  assert.match(compose, /SUTRA_OIDC_PROVIDERS: \$\{SUTRA_OIDC_PROVIDERS:-\}/u);
  assert.match(compose, /SUTRA_OIDC_TRANSACTION_KEY: \$\{SUTRA_OIDC_TRANSACTION_KEY:-\}/u);
  assert.match(setup, /const OIDC_VARS = \[[\s\S]*"SUTRA_OIDC_PROVIDERS"[\s\S]*"SUTRA_OIDC_TRANSACTION_KEY"/u);
  assert.match(setup, /hostedOidcProviderIssues\(process\.env\.SUTRA_OIDC_PROVIDERS\)/u);
  assert.match(redeploy, /SUTRA_REQUIRE_RUNTIME_SYNC:-false/u);
  assert.match(redeploy, /sync_args=\(\)/u);
  assert.match(redeploy, /sync_args=\(--optional\)/u);
  assert.match(release, /SUTRA_REQUIRE_RUNTIME_SYNC=true "\$ROOT\/deploy\/ec2\/redeploy\.sh"/u);
  assert.match(release, /docker\.env\.before-release/u);
  assert.match(release, /Restored the protected pre-release identity and mail runtime/u);
});

test("the host reads only the exact Zoho runtime secret", () => {
  assert.match(host, /PolicyName: ReadOnlyExactZohoRuntimeSecret/u);
  assert.match(
    host,
    /secret:sutra\/runtime\/zoho-\*/u,
  );
  assert.doesNotMatch(host, /secret:sutra\/runtime\/\*/u);
  assert.match(sync, /SECRET_ID=sutra\/runtime\/zoho/u);
  assert.match(sync, /secretsmanager get-secret-value/u);
  assert.doesNotMatch(sync, /secretsmanager (?:create|put|update|delete)-secret/u);
});

test("runtime synchronization is fail-closed and never prints credential values", () => {
  assert.match(sync, /Unknown keys are[\s\S]*refused/u);
  assert.match(sync, /SUTRA_CONTACT_PROVIDER == "zoho"/u);
  assert.match(sync, /SUTRA_INVITATION_EMAIL_PROVIDER == "zoho"/u);
  assert.match(sync, /SUTRA_IDENTITY_MODE == "password"/u);
  assert.match(sync, /SUTRA_IDENTITY_MODE == "oidc"/u);
  assert.match(sync, /SUTRA_OIDC_PROVIDERS[\s\S]*fromjson/u);
  assert.doesNotMatch(sync, /cat "\$payload"/u);
  assert.doesNotMatch(sync, /set -x/u);
  assert.match(redeploy, /require_runtime_sync.+true.+false/u);
  assert.match(redeploy, /SUTRA_REQUIRE_RUNTIME_SYNC must be exactly true or false/u);
});

test("the host accepts at most one optional Google provider pinned to Google's exact endpoints", () => {
  assert.match(sync, /\(length == 1 or length == 2\)/u);
  assert.match(sync, /\.\[1\]\.id == "google"/u);
  assert.match(sync, /\.\[1\]\.issuer == "https:\/\/accounts\.google\.com"/u);
  assert.match(sync, /\.\[1\]\.tokenEndpoint == "https:\/\/oauth2\.googleapis\.com\/token"/u);
  assert.match(sync, /\.\[1\]\.jwksUri == "https:\/\/www\.googleapis\.com\/oauth2\/v3\/certs"/u);
  assert.ok(sync.includes('test("^[A-Za-z0-9._-]{4,200}\\\\.apps\\\\.googleusercontent\\\\.com$")'));
  // No third entry: only lengths 1 and 2 appear in the provider gate.
  assert.doesNotMatch(sync, /\.\[2\]/u);
});
