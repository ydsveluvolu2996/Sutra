import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const {
  hostedIdentityProviderSummaries,
  resolveHostedIdentityProviderIssuer,
} = await import("../lib/hosted-identity-provider-directory.ts");

const root = resolve(import.meta.dirname, "..");
const [invitationRoute, accessUi, scimRoute, scimUi, settingsUi] = await Promise.all([
  readFile(resolve(root, "app/api/v1/invitations/route.ts"), "utf8"),
  readFile(resolve(root, "app/access/access-browser.tsx"), "utf8"),
  readFile(resolve(root, "app/api/v1/scim-connectors/route.ts"), "utf8"),
  readFile(resolve(root, "app/settings/scim-connectors-panel.tsx"), "utf8"),
  readFile(resolve(root, "app/settings/settings-browser.tsx"), "utf8"),
]);

const ORIGIN = "https://app.sutra.example";
const PROVIDERS = JSON.stringify([
  {
    id: "google",
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    clientId: "sutra-google.apps.googleusercontent.com",
  },
  {
    id: "entra",
    issuer: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
    authorizationEndpoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
    jwksUri: "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/discovery/v2.0/keys",
    clientId: "00000000-0000-0000-0000-000000000000",
  },
]);

const ENV_KEYS = [
  "SUTRA_DEPLOYMENT_ENV",
  "SUTRA_HOSTED_ENABLED",
  "SUTRA_IDENTITY_MODE",
  "SUTRA_LOCAL_MODE",
  "SUTRA_PUBLIC_ORIGIN",
  "SUTRA_OIDC_PROVIDERS",
  "SUTRA_OIDC_TRANSACTION_KEY",
];

function configureHostedOidc() {
  for (const key of ENV_KEYS) delete cloudflare.env[key];
  Object.assign(cloudflare.env, {
    SUTRA_DEPLOYMENT_ENV: "production",
    SUTRA_HOSTED_ENABLED: "true",
    SUTRA_IDENTITY_MODE: "oidc",
    SUTRA_LOCAL_MODE: "false",
    SUTRA_PUBLIC_ORIGIN: ORIGIN,
    SUTRA_OIDC_PROVIDERS: PROVIDERS,
    SUTRA_OIDC_TRANSACTION_KEY: "A".repeat(43),
  });
}

test("provider descriptors resolve only to exact server-configured issuers", () => {
  configureHostedOidc();
  const request = new Request(`${ORIGIN}/api/v1/invitations`);
  assert.deepEqual(hostedIdentityProviderSummaries(request), [
    { kind: "oidc", id: "google", label: "Google Workspace" },
    { kind: "oidc", id: "entra", label: "Microsoft Entra ID" },
  ]);
  assert.equal(
    resolveHostedIdentityProviderIssuer(request, { kind: "oidc", id: "entra" }),
    "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0",
  );
  for (const invalid of [
    { kind: "oidc", id: "unknown" },
    { kind: "oidc", id: "google", issuer: "https://attacker.example" },
    { kind: "saml", id: "google" },
    "google",
    null,
  ]) {
    assert.throws(
      () => resolveHostedIdentityProviderIssuer(request, invalid),
      (error) => error?.code === "INVALID_INPUT" && error?.status === 400,
    );
  }
  for (const key of ENV_KEYS) delete cloudflare.env[key];
});

test("invitation creation sends a provider descriptor and never accepts a raw browser issuer", () => {
  assert.match(invitationRoute, /hostedIdentityProviderSummaries\(request\)/u);
  assert.match(invitationRoute, /resolveHostedIdentityProviderIssuer\(request, body\.identityProvider\)/u);
  assert.doesNotMatch(invitationRoute, /body\.allowedIssuer/u);
  assert.match(accessUi, /Required sign-in provider/u);
  assert.match(accessUi, /identityProvider: \{ kind: selectedProvider\.kind, id: selectedProvider\.id \}/u);
  assert.doesNotMatch(accessUi, /allowedIssuer/u);
});

test("SCIM operator UI is permission-gated, MFA-stepped-up, and keeps plaintext tokens ephemeral", () => {
  assert.match(settingsUi, /canManageMembers \? <ScimConnectorsPanel \/> : null/u);
  assert.match(scimRoute, /resolveHostedIdentityProviderIssuer\(request, body\.identityProvider\)/u);
  assert.doesNotMatch(scimRoute, /body\.identityIssuer/u);
  assert.match(scimUi, /postAuth\("\/api\/auth\/mfa\/step-up"/u);
  assert.match(scimUi, /method: "POST"/u);
  assert.match(scimUi, /method: "PATCH"/u);
  assert.match(scimUi, /method: "DELETE"/u);
  assert.match(scimUi, /setOneTimeToken\(null\)/u);
  assert.match(scimUi, /shown once/u);
  assert.doesNotMatch(scimUi, /localStorage|sessionStorage/u);
  assert.doesNotMatch(scimUi, /org_admin/u);
});
