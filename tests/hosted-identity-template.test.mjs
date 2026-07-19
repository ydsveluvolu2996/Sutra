import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("hosted identity requires TOTP MFA and administrator-created users", async () => {
  const template = await readFile(resolve(root, "infrastructure/hosted-identity.yaml"), "utf8");
  assert.match(template, /MfaConfiguration: ON/u);
  assert.match(template, /EnabledMfas:\s*\n\s*- SOFTWARE_TOKEN_MFA/u);
  assert.match(template, /AllowAdminCreateUserOnly: true/u);
  assert.match(template, /DeletionProtection: ACTIVE/u);
  assert.match(template, /DeletionPolicy: Retain/u);
  assert.match(template, /TemporaryPasswordValidityDays: 2/u);
  assert.doesNotMatch(template, /SMS_MFA|phone_number/u);
});

test("hosted identity uses code flow with PKCE-compatible public client settings", async () => {
  const template = await readFile(resolve(root, "infrastructure/hosted-identity.yaml"), "utf8");
  assert.match(template, /GenerateSecret: false/u);
  assert.match(template, /AllowedOAuthFlows:\s*\n\s*- code/u);
  assert.match(template, /AllowedOAuthScopes:[\s\S]+- openid[\s\S]+- email[\s\S]+- profile/u);
  assert.match(template, /PreventUserExistenceErrors: ENABLED/u);
  assert.match(template, /EnableTokenRevocation: true/u);
  assert.match(template, /AccessTokenValidity: 15/u);
  assert.match(template, /IdTokenValidity: 15/u);
  assert.match(template, /RefreshTokenValidity: 1/u);
  assert.doesNotMatch(template, /ClientSecret|Implicit|GenerateSecret: true/u);
});

test("hosted identity accepts only HTTPS callback and logout contracts", async () => {
  const template = await readFile(resolve(root, "infrastructure/hosted-identity.yaml"), "utf8");
  assert.match(template, /AllowedPattern: '\^https:\/\//u);
  assert.match(template, /\/api\/auth\/oidc\/callback\$/u);
  assert.match(template, /CallbackURLs:\s*\n\s*- Ref: CallbackUrl/u);
  assert.match(template, /LogoutURLs:\s*\n\s*- Ref: LogoutUrl/u);
});
