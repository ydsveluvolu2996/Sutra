#!/usr/bin/env node
/**
 * Semantic preflight for the one managed-production runtime secret.
 *
 * The executable accepts the secret JSON document only on stdin. It never
 * prints, writes, or includes a candidate value in an error. The expected
 * non-secret stack identity mode is supplied through
 * SUTRA_EXPECTED_IDENTITY_MODE.
 */
import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} from "node:crypto";
import { pathToFileURL } from "node:url";

import { hostedSamlProviderIssues } from "../lib/hosted-saml-providers.ts";

const MAXIMUM_SECRET_BYTES = 256 * 1024;
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{8,256}$/u;
const ZOHO_TOKEN = /^[A-Za-z0-9._-]{16,2048}$/u;
const TURNSTILE_KEY = /^[A-Za-z0-9_-]{20,128}$/u;
const TRANSACTION_KEY = /^[A-Za-z0-9_-]{43}$/u;
const JOB_RUNNER_TOKEN = /^[A-Fa-f0-9]{64}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const TEST_TURNSTILE_SITE_KEYS = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const TEST_TURNSTILE_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

export const PRODUCTION_RUNTIME_SECRET_KEYS = Object.freeze([
  "SUTRA_APP_PUBLIC_KEYS",
  "SUTRA_AUTH_ENCRYPTION_KEY",
  "SUTRA_BROKER_CLIENT_KEY_ID",
  "SUTRA_BROKER_CLIENT_PRIVATE_KEY",
  "SUTRA_BROKER_RESPONSE_KEY_ID",
  "SUTRA_BROKER_RESPONSE_PRIVATE_KEY",
  "SUTRA_BROKER_RESPONSE_PUBLIC_KEY",
  "SUTRA_CONNECTION_ENCRYPTION_KEY",
  "SUTRA_CONTACT_FROM",
  "SUTRA_CONTACT_RECIPIENT",
  "SUTRA_INVITATION_FROM",
  "SUTRA_JOB_RUNNER_TOKEN",
  "SUTRA_MANAGED_OUTBOUND_APP_KEY_ID",
  "SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY",
  "SUTRA_MANAGED_OUTBOUND_FEED_KEY_ID",
  "SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY",
  "SUTRA_MANAGED_OUTBOUND_URL",
  "SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID",
  "SUTRA_MANAGED_OUTBOUND_WORKER_PRIVATE_KEY",
  "SUTRA_OIDC_PROVIDERS",
  "SUTRA_OIDC_TRANSACTION_KEY",
  "SUTRA_REGISTRY_ENCRYPTION_KEY",
  "SUTRA_SAML_PROVIDERS",
  "SUTRA_SAML_TRANSACTION_KEY",
  "SUTRA_TURNSTILE_SECRET_KEY",
  "SUTRA_TURNSTILE_SITE_KEY",
  "SUTRA_ZOHO_CLIENT_ID",
  "SUTRA_ZOHO_CLIENT_SECRET",
  "SUTRA_ZOHO_DATACENTER",
  "SUTRA_ZOHO_MAIL_ACCOUNT_ID",
  "SUTRA_ZOHO_REFRESH_TOKEN",
]);

function invalid(message) {
  throw new Error(message);
}

function exactObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be a JSON object`);
  }
  return value;
}

function oneLine(value, minimum, maximum, label) {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(`${label} is missing or invalid`);
  }
  return value;
}

function exactBase64Url256(value, label) {
  const source = oneLine(value, 43, 43, label);
  if (!BASE64URL_256.test(source)) invalid(`${label} must contain exactly 256 bits`);
  const bytes = Buffer.from(source, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== source) {
    invalid(`${label} must be canonical base64url`);
  }
  return source;
}

function privateEd25519(value, label) {
  const source = oneLine(value, 40, 4_096, label);
  if (!/^[A-Za-z0-9_-]+$/u.test(source)) invalid(`${label} must be canonical base64url`);
  try {
    const key = createPrivateKey({
      key: Buffer.from(source, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    if (
      key.type !== "private"
      || key.asymmetricKeyType !== "ed25519"
      || key.export({ format: "der", type: "pkcs8" }).toString("base64url") !== source
    ) {
      invalid(`${label} must be an Ed25519 PKCS8 key`);
    }
    return key;
  } catch {
    invalid(`${label} must be an Ed25519 PKCS8 key`);
  }
}

function publicEd25519(value, label) {
  const source = oneLine(value, 40, 4_096, label);
  if (!/^[A-Za-z0-9_-]+$/u.test(source)) invalid(`${label} must be canonical base64url`);
  try {
    const key = createPublicKey({
      key: Buffer.from(source, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      key.type !== "public"
      || key.asymmetricKeyType !== "ed25519"
      || key.export({ format: "der", type: "spki" }).toString("base64url") !== source
    ) {
      invalid(`${label} must be an Ed25519 SPKI key`);
    }
    return key;
  } catch {
    invalid(`${label} must be an Ed25519 SPKI key`);
  }
}

function samePublicKey(left, right) {
  const leftDer = left.export({ format: "der", type: "spki" });
  const rightDer = right.export({ format: "der", type: "spki" });
  return leftDer.length === rightDer.length && timingSafeEqual(leftDer, rightDer);
}

function parseJsonString(value, label) {
  const source = oneLine(value, 2, 64 * 1024, label);
  try {
    return JSON.parse(source);
  } catch {
    invalid(`${label} must be valid JSON`);
  }
}

function validateZoho(secret) {
  if (
    secret.SUTRA_CONTACT_RECIPIENT !== "contact@sutracmdb.com"
    || secret.SUTRA_CONTACT_FROM !== "Sutra Contact <contact@sutracmdb.com>"
    || secret.SUTRA_INVITATION_FROM !== "Sutra Support <support@sutracmdb.com>"
    || secret.SUTRA_ZOHO_DATACENTER !== "in"
  ) {
    invalid("The Zoho runtime aliases and India data center are invalid");
  }
  if (
    typeof secret.SUTRA_ZOHO_MAIL_ACCOUNT_ID !== "string"
    || !/^[0-9]{6,32}$/u.test(secret.SUTRA_ZOHO_MAIL_ACCOUNT_ID)
    || typeof secret.SUTRA_ZOHO_CLIENT_ID !== "string"
    || !SAFE_IDENTIFIER.test(secret.SUTRA_ZOHO_CLIENT_ID)
    || typeof secret.SUTRA_ZOHO_REFRESH_TOKEN !== "string"
    || !ZOHO_TOKEN.test(secret.SUTRA_ZOHO_REFRESH_TOKEN)
  ) {
    invalid("The Zoho Mail credential shape is invalid");
  }
  oneLine(secret.SUTRA_ZOHO_CLIENT_SECRET, 8, 512, "SUTRA_ZOHO_CLIENT_SECRET");

  const providers = parseJsonString(secret.SUTRA_OIDC_PROVIDERS, "SUTRA_OIDC_PROVIDERS");
  const provider = Array.isArray(providers) ? providers[0] : null;
  const expectedKeys = [
    "authorizationEndpoint",
    "clientId",
    "clientSecret",
    "id",
    "issuer",
    "jwksUri",
    "tokenEndpoint",
  ];
  if (
    !Array.isArray(providers)
    || providers.length !== 1
    || provider === null
    || typeof provider !== "object"
    || Array.isArray(provider)
    || Object.keys(provider).sort().join("\0") !== expectedKeys.join("\0")
    || provider.id !== "zoho"
    || provider.issuer !== "https://accounts.zoho.in"
    || provider.authorizationEndpoint !== "https://accounts.zoho.in/oauth/v2/auth"
    || provider.tokenEndpoint !== "https://accounts.zoho.in/oauth/v2/token"
    || provider.jwksUri !== "https://accounts.zoho.in/oauth/v2/keys"
    || typeof provider.clientId !== "string"
    || !SAFE_IDENTIFIER.test(provider.clientId)
  ) {
    invalid("SUTRA_OIDC_PROVIDERS must match the exact Zoho India provider contract");
  }
  oneLine(provider.clientSecret, 8, 512, "SUTRA_OIDC_PROVIDERS clientSecret");
}

function validateIdentity(secret, expectedIdentityMode) {
  if (expectedIdentityMode !== "oidc" && expectedIdentityMode !== "federated") {
    invalid("SUTRA_EXPECTED_IDENTITY_MODE must be oidc or federated");
  }
  const oidcTransactionKey = oneLine(
    secret.SUTRA_OIDC_TRANSACTION_KEY,
    43,
    43,
    "SUTRA_OIDC_TRANSACTION_KEY",
  );
  if (!TRANSACTION_KEY.test(oidcTransactionKey)) {
    invalid("SUTRA_OIDC_TRANSACTION_KEY must contain exactly 256 bits");
  }

  if (expectedIdentityMode === "oidc") {
    if (
      secret.SUTRA_SAML_PROVIDERS !== undefined
      || secret.SUTRA_SAML_TRANSACTION_KEY !== undefined
    ) {
      invalid("SAML keys must be absent when IdentityMode is oidc");
    }
    return;
  }

  const samlProviders = oneLine(
    secret.SUTRA_SAML_PROVIDERS,
    2,
    48 * 1024,
    "SUTRA_SAML_PROVIDERS",
  );
  if (hostedSamlProviderIssues(samlProviders).length > 0) {
    invalid("SUTRA_SAML_PROVIDERS does not match the hosted SAML provider contract");
  }
  const transactionKey = oneLine(
    secret.SUTRA_SAML_TRANSACTION_KEY,
    43,
    43,
    "SUTRA_SAML_TRANSACTION_KEY",
  );
  if (!TRANSACTION_KEY.test(transactionKey) || transactionKey === oidcTransactionKey) {
    invalid("SUTRA_SAML_TRANSACTION_KEY must be a distinct 256-bit key");
  }
}

function validateAsymmetricKeys(secret) {
  const appKeyId = oneLine(
    secret.SUTRA_BROKER_CLIENT_KEY_ID,
    1,
    64,
    "SUTRA_BROKER_CLIENT_KEY_ID",
  );
  const brokerKeyId = oneLine(
    secret.SUTRA_BROKER_RESPONSE_KEY_ID,
    1,
    64,
    "SUTRA_BROKER_RESPONSE_KEY_ID",
  );
  const outboundKeyIds = [
    secret.SUTRA_MANAGED_OUTBOUND_APP_KEY_ID,
    secret.SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID,
    secret.SUTRA_MANAGED_OUTBOUND_FEED_KEY_ID,
  ].map((value, index) => oneLine(
    value,
    1,
    64,
    [
      "SUTRA_MANAGED_OUTBOUND_APP_KEY_ID",
      "SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID",
      "SUTRA_MANAGED_OUTBOUND_FEED_KEY_ID",
    ][index],
  ));
  const allKeyIds = [appKeyId, brokerKeyId, ...outboundKeyIds];
  if (allKeyIds.some((value) => !KEY_ID.test(value)) || new Set(allKeyIds).size !== allKeyIds.length) {
    invalid("All app, broker, and managed-outbound key IDs must be valid and distinct");
  }

  const appPrivate = privateEd25519(
    secret.SUTRA_BROKER_CLIENT_PRIVATE_KEY,
    "SUTRA_BROKER_CLIENT_PRIVATE_KEY",
  );
  const brokerPrivate = privateEd25519(
    secret.SUTRA_BROKER_RESPONSE_PRIVATE_KEY,
    "SUTRA_BROKER_RESPONSE_PRIVATE_KEY",
  );
  const outboundPrivateSources = [
    secret.SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY,
    secret.SUTRA_MANAGED_OUTBOUND_WORKER_PRIVATE_KEY,
    secret.SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY,
  ];
  outboundPrivateSources.forEach((value, index) => privateEd25519(
    value,
    [
      "SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY",
      "SUTRA_MANAGED_OUTBOUND_WORKER_PRIVATE_KEY",
      "SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY",
    ][index],
  ));
  const allPrivateSources = [
    secret.SUTRA_BROKER_CLIENT_PRIVATE_KEY,
    secret.SUTRA_BROKER_RESPONSE_PRIVATE_KEY,
    ...outboundPrivateSources,
  ];
  if (new Set(allPrivateSources).size !== allPrivateSources.length) {
    invalid("All app, broker, and managed-outbound private keys must be distinct");
  }

  const appPublicKeys = exactObject(
    parseJsonString(secret.SUTRA_APP_PUBLIC_KEYS, "SUTRA_APP_PUBLIC_KEYS"),
    "SUTRA_APP_PUBLIC_KEYS",
  );
  const entries = Object.entries(appPublicKeys);
  if (
    entries.length < 1
    || entries.length > 16
    || entries.some(([keyId]) => !KEY_ID.test(keyId))
    || !Object.hasOwn(appPublicKeys, appKeyId)
  ) {
    invalid("SUTRA_APP_PUBLIC_KEYS must contain the active app key ID");
  }
  const parsedAppPublicKeys = new Map(entries.map(([keyId, value]) => [
    keyId,
    publicEd25519(value, "SUTRA_APP_PUBLIC_KEYS entry"),
  ]));
  const activeAppPublic = parsedAppPublicKeys.get(appKeyId);
  if (
    activeAppPublic === undefined
    || !samePublicKey(createPublicKey(appPrivate), activeAppPublic)
  ) {
    invalid("The active app private/public Ed25519 key pair does not match");
  }

  const brokerPublic = publicEd25519(
    secret.SUTRA_BROKER_RESPONSE_PUBLIC_KEY,
    "SUTRA_BROKER_RESPONSE_PUBLIC_KEY",
  );
  if (!samePublicKey(createPublicKey(brokerPrivate), brokerPublic)) {
    invalid("The broker response private/public Ed25519 key pair does not match");
  }
}

export function validateProductionRuntimeSecret(candidate, expectedIdentityMode) {
  const secret = exactObject(candidate, "Production runtime secret");
  for (const key of PRODUCTION_RUNTIME_SECRET_KEYS) {
    if (key === "SUTRA_SAML_PROVIDERS" || key === "SUTRA_SAML_TRANSACTION_KEY") continue;
    if (!(key in secret)) invalid(`Production runtime secret is missing ${key}`);
  }

  const encryptionKeys = [
    exactBase64Url256(secret.SUTRA_AUTH_ENCRYPTION_KEY, "SUTRA_AUTH_ENCRYPTION_KEY"),
    exactBase64Url256(secret.SUTRA_CONNECTION_ENCRYPTION_KEY, "SUTRA_CONNECTION_ENCRYPTION_KEY"),
    exactBase64Url256(secret.SUTRA_REGISTRY_ENCRYPTION_KEY, "SUTRA_REGISTRY_ENCRYPTION_KEY"),
  ];
  if (new Set(encryptionKeys).size !== encryptionKeys.length) {
    invalid("Application encryption keys must be distinct");
  }
  if (
    typeof secret.SUTRA_JOB_RUNNER_TOKEN !== "string"
    || !JOB_RUNNER_TOKEN.test(secret.SUTRA_JOB_RUNNER_TOKEN)
  ) {
    invalid("SUTRA_JOB_RUNNER_TOKEN must be a 256-bit hexadecimal token");
  }

  const siteKey = oneLine(secret.SUTRA_TURNSTILE_SITE_KEY, 20, 128, "SUTRA_TURNSTILE_SITE_KEY");
  const turnstileSecret = oneLine(
    secret.SUTRA_TURNSTILE_SECRET_KEY,
    20,
    128,
    "SUTRA_TURNSTILE_SECRET_KEY",
  );
  if (
    !TURNSTILE_KEY.test(siteKey)
    || !TURNSTILE_KEY.test(turnstileSecret)
    || siteKey === turnstileSecret
    || TEST_TURNSTILE_SITE_KEYS.has(siteKey)
    || TEST_TURNSTILE_SECRET_KEYS.has(turnstileSecret)
  ) {
    invalid("Production Turnstile keys are invalid");
  }

  if (
    typeof secret.SUTRA_CONTACT_RECIPIENT !== "string"
    || !EMAIL.test(secret.SUTRA_CONTACT_RECIPIENT)
  ) {
    invalid("SUTRA_CONTACT_RECIPIENT is invalid");
  }
  validateZoho(secret);
  validateIdentity(secret, expectedIdentityMode);

  if (secret.SUTRA_MANAGED_OUTBOUND_URL !== "https://outbound.sutracmdb.com") {
    invalid("SUTRA_MANAGED_OUTBOUND_URL must be the exact production origin");
  }
  validateAsymmetricKeys(secret);
  return true;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAXIMUM_SECRET_BYTES) invalid("Production runtime secret exceeds the size limit");
    chunks.push(chunk);
  }
  if (size === 0) invalid("Production runtime secret JSON is required on stdin");
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let candidate;
  try {
    candidate = JSON.parse(await readStdin());
  } catch (error) {
    if (error instanceof SyntaxError) invalid("Production runtime secret must be valid JSON");
    throw error;
  }
  validateProductionRuntimeSecret(candidate, process.env.SUTRA_EXPECTED_IDENTITY_MODE);
  process.stdout.write("Production runtime secret semantic validation passed.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Production runtime secret validation failed"}\n`);
    process.exitCode = 1;
  });
}
