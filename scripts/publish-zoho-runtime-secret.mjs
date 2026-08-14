#!/usr/bin/env node
/**
 * Publish the workstation's validated Zoho integration bundle to the one
 * account-local Secrets Manager document the production host can read.
 *
 * The secret moves from Keychain to the AWS CLI over stdin. It is never placed
 * in argv, stdout, a repository file, or a temporary file.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXPECTED_ACCOUNT_ID = "738663485493";
const AWS_REGION = "ap-south-1";
const SECRET_ID = "sutra/runtime/zoho";
const KEYCHAIN_SERVICE = "com.sutracmdb.zoho.integration";

const KEYS = [
  "SUTRA_CONTACT_RECIPIENT",
  "SUTRA_CONTACT_FROM",
  "SUTRA_CONTACT_PROVIDER",
  "SUTRA_INVITATION_FROM",
  "SUTRA_INVITATION_EMAIL_PROVIDER",
  "SUTRA_ZOHO_DATACENTER",
  "SUTRA_ZOHO_MAIL_ACCOUNT_ID",
  "SUTRA_ZOHO_CLIENT_ID",
  "SUTRA_ZOHO_CLIENT_SECRET",
  "SUTRA_ZOHO_REFRESH_TOKEN",
  "SUTRA_OIDC_PROVIDERS",
  "SUTRA_OIDC_TRANSACTION_KEY",
];

function oneLine(value) {
  return typeof value === "string"
    && value.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function buildRuntimeSecret(bundle, identityMode) {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("The Keychain bundle is not a JSON object.");
  }
  if (identityMode !== "password" && identityMode !== "oidc") {
    throw new Error("Identity mode must be password or oidc.");
  }
  for (const key of KEYS) {
    if (!oneLine(bundle[key])) throw new Error(`The Keychain bundle is missing ${key}.`);
  }
  if (
    bundle.SUTRA_CONTACT_RECIPIENT !== "contact@sutracmdb.com"
    || bundle.SUTRA_CONTACT_FROM !== "Sutra Contact <contact@sutracmdb.com>"
    || bundle.SUTRA_CONTACT_PROVIDER !== "zoho"
    || bundle.SUTRA_INVITATION_FROM !== "Sutra Support <support@sutracmdb.com>"
    || bundle.SUTRA_INVITATION_EMAIL_PROVIDER !== "zoho"
    || bundle.SUTRA_ZOHO_DATACENTER !== "in"
    || bundle.SUTRA_OIDC_REDIRECT_URI !== "https://www.sutracmdb.com/api/auth/oidc/callback"
    || !/^[0-9]{6,32}$/u.test(bundle.SUTRA_ZOHO_MAIL_ACCOUNT_ID)
    || !/^[A-Za-z0-9._-]{8,256}$/u.test(bundle.SUTRA_ZOHO_CLIENT_ID)
    || bundle.SUTRA_ZOHO_CLIENT_SECRET.length < 8
    || bundle.SUTRA_ZOHO_CLIENT_SECRET.length > 512
    || !/^[A-Za-z0-9._-]{16,2048}$/u.test(bundle.SUTRA_ZOHO_REFRESH_TOKEN)
    || !/^[A-Za-z0-9_-]{43,128}$/u.test(bundle.SUTRA_OIDC_TRANSACTION_KEY)
  ) {
    throw new Error("The Keychain bundle does not match the approved Sutra aliases and endpoints.");
  }
  const providers = JSON.parse(bundle.SUTRA_OIDC_PROVIDERS);
  const providerKeys = (provider) => (provider === null || typeof provider !== "object"
    ? []
    : Object.keys(provider).sort());
  const EXACT_PROVIDER_KEYS = [
    "authorizationEndpoint",
    "clientId",
    "clientSecret",
    "id",
    "issuer",
    "jwksUri",
    "tokenEndpoint",
  ].join("\0");
  // `authorizationPrompt` is accepted either present-and-select_account or
  // absent. Bundles published before the field existed omit it, and the runtime
  // now defaults Google to the account chooser rather than rejecting them, so
  // demanding the key here would refuse to republish a bundle the runtime is
  // perfectly willing to serve.
  const GOOGLE_PROVIDER_KEY_SHAPES = new Set([
    [
      "authorizationEndpoint",
      "authorizationPrompt",
      "clientId",
      "clientSecret",
      "id",
      "issuer",
      "jwksUri",
      "tokenEndpoint",
    ].join("\0"),
    [
      "authorizationEndpoint",
      "clientId",
      "clientSecret",
      "id",
      "issuer",
      "jwksUri",
      "tokenEndpoint",
    ].join("\0"),
  ]);
  // Exactly one Zoho provider, optionally followed by exactly one Google
  // provider for public self-serve signup. Both are pinned to their exact
  // published endpoints -- the bundle chooses WHETHER Google sign-in exists,
  // never WHERE its endpoints point.
  const zoho = Array.isArray(providers) ? providers[0] : undefined;
  if (
    !Array.isArray(providers)
    || providers.length < 1
    || providers.length > 2
    || providerKeys(zoho).join("\0") !== EXACT_PROVIDER_KEYS
    || zoho?.id !== "zoho"
    || zoho?.issuer !== "https://accounts.zoho.in"
    || zoho?.authorizationEndpoint !== "https://accounts.zoho.in/oauth/v2/auth"
    || zoho?.tokenEndpoint !== "https://accounts.zoho.in/oauth/v2/token"
    || zoho?.jwksUri !== "https://accounts.zoho.in/oauth/v2/keys"
    || !oneLine(zoho?.clientId)
    || !oneLine(zoho?.clientSecret)
  ) {
    throw new Error("The Keychain OIDC provider does not match the approved Zoho India contract.");
  }
  const google = providers[1];
  if (
    providers.length === 2
    && (
      !GOOGLE_PROVIDER_KEY_SHAPES.has(providerKeys(google).join("\0"))
      || google?.id !== "google"
      || google?.issuer !== "https://accounts.google.com"
      || google?.authorizationEndpoint !== "https://accounts.google.com/o/oauth2/v2/auth"
      || google?.tokenEndpoint !== "https://oauth2.googleapis.com/token"
      || google?.jwksUri !== "https://www.googleapis.com/oauth2/v3/certs"
      || (google?.authorizationPrompt ?? "select_account") !== "select_account"
      || typeof google?.clientId !== "string"
      || !/^[A-Za-z0-9._-]{4,200}\.apps\.googleusercontent\.com$/u.test(google.clientId)
      || !oneLine(google?.clientSecret)
      || google.clientSecret.length < 8
      || google.clientSecret.length > 512
    )
  ) {
    throw new Error("The Keychain OIDC provider does not match the approved Google contract.");
  }
  return Object.fromEntries([
    ...KEYS.map((key) => [key, bundle[key]]),
    ["SUTRA_IDENTITY_MODE", identityMode],
  ]);
}

function runAws(arguments_, options = {}) {
  const result = spawnSync("aws", [...arguments_, "--no-cli-pager"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `AWS CLI exited ${result.status ?? "without a status"}.`);
  }
  return result.stdout;
}

function main() {
  const modeArgument = process.argv.find((argument) => argument.startsWith("--identity-mode="));
  const identityMode = modeArgument?.slice("--identity-mode=".length);
  if (identityMode !== "password" && identityMode !== "oidc") {
    throw new Error("Usage: pnpm zoho:publish-runtime --identity-mode=password|oidc");
  }

  const caller = JSON.parse(runAws(["sts", "get-caller-identity", "--output", "json"]));
  if (caller.Account !== EXPECTED_ACCOUNT_ID) {
    throw new Error(`Refusing AWS account ${caller.Account ?? "unknown"}; expected the Sutra host account.`);
  }

  const bundle = JSON.parse(execFileSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8", maxBuffer: 256 * 1024 },
  ));
  const secret = JSON.stringify(buildRuntimeSecret(bundle, identityMode));

  const describe = spawnSync("aws", [
    "secretsmanager",
    "describe-secret",
    "--region", AWS_REGION,
    "--secret-id", SECRET_ID,
    "--output", "json",
    "--no-cli-pager",
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });

  let output;
  if (describe.status === 0) {
    output = runAws([
      "secretsmanager",
      "put-secret-value",
      "--region", AWS_REGION,
      "--secret-id", SECRET_ID,
      "--secret-string", "file:///dev/stdin",
      "--output", "json",
    ], { input: secret });
  } else {
    output = runAws([
      "secretsmanager",
      "create-secret",
      "--region", AWS_REGION,
      "--name", SECRET_ID,
      "--description", "Sutra production Zoho Mail and OIDC runtime configuration",
      "--tags",
      "Key=sutra:component,Value=identity",
      "Key=sutra:managed-by,Value=operator",
      "--secret-string", "file:///dev/stdin",
      "--output", "json",
    ], { input: secret });
  }
  const published = JSON.parse(output);
  const expectedArn = new RegExp(
    `^arn:aws:secretsmanager:${AWS_REGION}:${EXPECTED_ACCOUNT_ID}:secret:sutra/runtime/zoho-[A-Za-z0-9]+$`,
    "u",
  );
  if (!expectedArn.test(published.ARN ?? "")) {
    throw new Error("Secrets Manager returned an unexpected resource identity.");
  }
  process.stdout.write(`Published ${SECRET_ID} with identity mode ${identityMode}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
