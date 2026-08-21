import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseUpdate = await readFile(
  new URL("../deploy/ec2/release-update.sh", import.meta.url),
  "utf8",
);
const publicAuth = await readFile(
  new URL("../deploy/ec2/verify-public-auth.sh", import.meta.url),
  "utf8",
);

test("EC2 release retries Cloudflare indexable-body convergence without weakening checks", () => {
  assert.match(releaseUpdate, /require_indexable_body_match\(\)/u);
  assert.match(
    releaseUpdate,
    /for \(\(content_attempt = 1; content_attempt <= 3; content_attempt \+= 1\)\)/u,
  );
  assert.match(releaseUpdate, /fetch_public "\$path" "\$label" 3/u);
  assert.match(releaseUpdate, /require_indexable_response "\$path"/u);
  assert.match(releaseUpdate, /"Sitemap: \$PUBLIC_ORIGIN\/sitemap\.xml"/u);
  assert.match(releaseUpdate, /"<loc>\$PUBLIC_ORIGIN\/<\/loc>"/u);
  assert.match(releaseUpdate, /The public robots\.txt does not advertise the canonical sitemap/u);
  assert.match(releaseUpdate, /The public sitemap does not contain the canonical site origin/u);
});

test("EC2 release commits only after the public Google and Zoho identity contract passes", () => {
  const authCheck = releaseUpdate.indexOf('bash "$ROOT/deploy/ec2/verify-public-auth.sh"');
  const commit = releaseUpdate.indexOf("RELEASE_COMMITTED=true");
  assert.ok(authCheck > 0 && commit > authCheck);
  assert.match(releaseUpdate, /verify-public-auth\.sh sutra\.service/u);
  assert.match(releaseUpdate, /SUTRA_REQUIRE_RUNTIME_SYNC=true/u);
  assert.match(releaseUpdate, /docker\.env\.before-release/u);
  assert.match(releaseUpdate, /install -o 0 -g 0 -m 0600 "\$RUNTIME_ENV_BACKUP" "\$DOCKER_ENV"/u);
});

test("the public identity verifier pins self-serve providers and Google's secure PKCE start", () => {
  assert.match(publicAuth, /\.identityMode == "oidc"/u);
  assert.match(publicAuth, /\.invitationOnly == false/u);
  assert.match(publicAuth, /\.providers \| type == "array" and length == 2/u);
  assert.match(publicAuth, /\.id == "google"/u);
  assert.match(publicAuth, /\.id == "zoho"/u);
  assert.match(publicAuth, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/u);
  assert.match(publicAuth, /prompt=select_account/u);
  assert.match(publicAuth, /code_challenge_method=S256/u);
  assert.match(
    publicAuth,
    /redirect_uri=https%3A%2F%2Fwww\.sutracmdb\.com%2Fapi%2Fauth%2Foidc%2Fcallback/u,
  );
  for (const cookieAttribute of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=300"]) {
    assert.match(publicAuth, new RegExp(cookieAttribute));
  }
  assert.doesNotMatch(publicAuth, /curl[^\n]*(?:--location|-L)(?:\s|$)/u);
  assert.doesNotMatch(publicAuth, /echo[^\n]*(?:location|cookie|client_id)/iu);
});
