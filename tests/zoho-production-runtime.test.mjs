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

test("production can switch between password and Zoho OIDC only through explicit runtime values", () => {
  assert.match(compose, /SUTRA_IDENTITY_MODE: \$\{SUTRA_IDENTITY_MODE:-password\}/u);
  assert.match(compose, /SUTRA_OIDC_PROVIDERS: \$\{SUTRA_OIDC_PROVIDERS:-\}/u);
  assert.match(compose, /SUTRA_OIDC_TRANSACTION_KEY: \$\{SUTRA_OIDC_TRANSACTION_KEY:-\}/u);
  assert.match(redeploy, /sync-zoho-runtime\.sh" --optional/u);
  assert.match(release, /sync-zoho-runtime\.sh/u);
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
});
