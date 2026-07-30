import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeSecret } from "../scripts/publish-zoho-runtime-secret.mjs";

const BUNDLE = {
  SUTRA_CONTACT_RECIPIENT: "contact@sutracmdb.com",
  SUTRA_CONTACT_FROM: "Sutra Contact <contact@sutracmdb.com>",
  SUTRA_CONTACT_PROVIDER: "zoho",
  SUTRA_INVITATION_FROM: "Sutra Support <support@sutracmdb.com>",
  SUTRA_INVITATION_EMAIL_PROVIDER: "zoho",
  SUTRA_ZOHO_DATACENTER: "in",
  SUTRA_ZOHO_MAIL_ACCOUNT_ID: "60080685470",
  SUTRA_ZOHO_CLIENT_ID: "1000.MAIL_CLIENT",
  SUTRA_ZOHO_CLIENT_SECRET: "mail-client-secret",
  SUTRA_ZOHO_REFRESH_TOKEN: `1000.${"r".repeat(48)}`,
  SUTRA_OIDC_PROVIDERS: JSON.stringify([{
    id: "zoho",
    issuer: "https://accounts.zoho.in",
    authorizationEndpoint: "https://accounts.zoho.in/oauth/v2/auth",
    tokenEndpoint: "https://accounts.zoho.in/oauth/v2/token",
    jwksUri: "https://accounts.zoho.in/oauth/v2/keys",
    clientId: "1000.OIDC_CLIENT",
    clientSecret: "oidc-client-secret",
  }]),
  SUTRA_OIDC_TRANSACTION_KEY: "t".repeat(43),
  SUTRA_OIDC_REDIRECT_URI: "https://www.sutracmdb.com/api/auth/oidc/callback",
};

test("publisher copies only approved values and supplies the explicit identity mode", () => {
  const result = buildRuntimeSecret({ ...BUNDLE, ignored: "not-published" }, "password");
  assert.equal(result.SUTRA_IDENTITY_MODE, "password");
  assert.equal(result.SUTRA_CONTACT_PROVIDER, "zoho");
  assert.equal(result.ignored, undefined);
  assert.equal(result.SUTRA_OIDC_REDIRECT_URI, undefined);
});

test("publisher refuses an unapproved endpoint, missing secret, or identity mode", () => {
  assert.throws(
    () => buildRuntimeSecret({ ...BUNDLE, SUTRA_ZOHO_CLIENT_SECRET: "" }, "password"),
    /SUTRA_ZOHO_CLIENT_SECRET/u,
  );
  assert.throws(
    () => buildRuntimeSecret({ ...BUNDLE, SUTRA_OIDC_REDIRECT_URI: "https://attacker.example/callback" }, "oidc"),
    /approved Sutra aliases and endpoints/u,
  );
  assert.throws(
    () => buildRuntimeSecret({ ...BUNDLE, SUTRA_ZOHO_REFRESH_TOKEN: "short" }, "password"),
    /approved Sutra aliases and endpoints/u,
  );
  assert.throws(
    () => buildRuntimeSecret({
      ...BUNDLE,
      SUTRA_OIDC_PROVIDERS: JSON.stringify([{
        ...JSON.parse(BUNDLE.SUTRA_OIDC_PROVIDERS)[0],
        unexpectedEndpoint: "https://attacker.example",
      }]),
    }, "oidc"),
    /approved Zoho India contract/u,
  );
  assert.throws(() => buildRuntimeSecret(BUNDLE, "hybrid"), /password or oidc/u);
});
