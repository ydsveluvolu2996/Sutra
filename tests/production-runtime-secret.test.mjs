import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  PRODUCTION_RUNTIME_SECRET_KEYS,
  validateProductionRuntimeSecret,
} from "../scripts/validate-production-runtime-secret.mjs";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

function fixture() {
  const app = keyPair();
  const broker = keyPair();
  const outboundApp = keyPair();
  const outboundWorker = keyPair();
  const outboundFeed = keyPair();
  return {
    SUTRA_APP_PUBLIC_KEYS: JSON.stringify({ "production-app-signing": app.publicKey }),
    SUTRA_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
    SUTRA_BROKER_CLIENT_KEY_ID: "production-app-signing",
    SUTRA_BROKER_CLIENT_PRIVATE_KEY: app.privateKey,
    SUTRA_BROKER_RESPONSE_KEY_ID: "production-broker-response",
    SUTRA_BROKER_RESPONSE_PRIVATE_KEY: broker.privateKey,
    SUTRA_BROKER_RESPONSE_PUBLIC_KEY: broker.publicKey,
    SUTRA_CONNECTION_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64url"),
    SUTRA_CONTACT_FROM: "Sutra Contact <contact@sutracmdb.com>",
    SUTRA_CONTACT_RECIPIENT: "contact@sutracmdb.com",
    SUTRA_INVITATION_FROM: "Sutra Support <support@sutracmdb.com>",
    SUTRA_JOB_RUNNER_TOKEN: "ab".repeat(32),
    SUTRA_MANAGED_OUTBOUND_APP_KEY_ID: "production-outbound-app",
    SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY: outboundApp.privateKey,
    SUTRA_MANAGED_OUTBOUND_FEED_KEY_ID: "production-outbound-feed",
    SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY: outboundFeed.privateKey,
    SUTRA_MANAGED_OUTBOUND_URL: "https://outbound.sutracmdb.com",
    SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID: "production-outbound-worker",
    SUTRA_MANAGED_OUTBOUND_WORKER_PRIVATE_KEY: outboundWorker.privateKey,
    SUTRA_OIDC_PROVIDERS: JSON.stringify([{
      authorizationEndpoint: "https://accounts.zoho.in/oauth/v2/auth",
      clientId: "1000.PRODUCTION_ZOHO",
      clientSecret: "production-oidc-secret",
      id: "zoho",
      issuer: "https://accounts.zoho.in",
      jwksUri: "https://accounts.zoho.in/oauth/v2/keys",
      tokenEndpoint: "https://accounts.zoho.in/oauth/v2/token",
    }]),
    SUTRA_OIDC_TRANSACTION_KEY: Buffer.alloc(32, 3).toString("base64url"),
    SUTRA_REGISTRY_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64url"),
    SUTRA_TURNSTILE_SECRET_KEY: "0x4BBBBBBBBBBBBBBBBBBBBBBB",
    SUTRA_TURNSTILE_SITE_KEY: "0x4AAAAAAAAAAAAAAAAAAAAAAA",
    SUTRA_ZOHO_CLIENT_ID: "1000.PRODUCTION_ZOHO",
    SUTRA_ZOHO_CLIENT_SECRET: "production-mail-secret",
    SUTRA_ZOHO_DATACENTER: "in",
    SUTRA_ZOHO_MAIL_ACCOUNT_ID: "60080685470",
    SUTRA_ZOHO_REFRESH_TOKEN: `1000.${"r".repeat(48)}`,
  };
}

test("semantic preflight covers every runtime key referenced by the HA template", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = await readFile(
    new URL("../infrastructure/production-ha.yaml", import.meta.url),
    "utf8",
  );
  const referenced = [...template.matchAll(/ApplicationRuntimeSecretArn\}:([A-Z0-9_]+)::/gu)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual([...new Set(referenced)], [...PRODUCTION_RUNTIME_SECRET_KEYS]);
  assert.equal(validateProductionRuntimeSecret(fixture(), "oidc"), true);
});

test("semantic preflight rejects mismatched broker pairs and duplicate workload credentials", () => {
  const mismatched = fixture();
  mismatched.SUTRA_BROKER_RESPONSE_PUBLIC_KEY = keyPair().publicKey;
  assert.throws(
    () => validateProductionRuntimeSecret(mismatched, "oidc"),
    /broker response private\/public/u,
  );

  const duplicateId = fixture();
  duplicateId.SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID =
    duplicateId.SUTRA_MANAGED_OUTBOUND_APP_KEY_ID;
  assert.throws(
    () => validateProductionRuntimeSecret(duplicateId, "oidc"),
    /key IDs must be valid and distinct/u,
  );

  const duplicatePrivate = fixture();
  duplicatePrivate.SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY =
    duplicatePrivate.SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY;
  assert.throws(
    () => validateProductionRuntimeSecret(duplicatePrivate, "oidc"),
    /private keys must be distinct/u,
  );
});

test("identity mode is fail-closed and SAML keys are conditional", () => {
  const oidcWithSaml = {
    ...fixture(),
    SUTRA_SAML_PROVIDERS: "[]",
    SUTRA_SAML_TRANSACTION_KEY: Buffer.alloc(32, 5).toString("base64url"),
  };
  assert.throws(
    () => validateProductionRuntimeSecret(oidcWithSaml, "oidc"),
    /SAML keys must be absent/u,
  );
  assert.throws(
    () => validateProductionRuntimeSecret(fixture(), "federated"),
    /SUTRA_SAML_PROVIDERS/u,
  );
  assert.throws(
    () => validateProductionRuntimeSecret(fixture(), "password"),
    /SUTRA_EXPECTED_IDENTITY_MODE/u,
  );
});

test("CLI reads only stdin and never echoes rejected secret material", () => {
  const candidate = fixture();
  const marker = "do-not-leak-runtime-secret-marker";
  candidate.SUTRA_ZOHO_CLIENT_SECRET = marker;
  candidate.SUTRA_ZOHO_DATACENTER = "us";
  const result = spawnSync(
    process.execPath,
    ["scripts/validate-production-runtime-secret.mjs"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, SUTRA_EXPECTED_IDENTITY_MODE: "oidc" },
      input: JSON.stringify(candidate),
    },
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(marker, "u"));
  assert.match(result.stderr, /Zoho runtime aliases/u);
});
