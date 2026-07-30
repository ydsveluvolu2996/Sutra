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
  const provider = Array.isArray(providers) ? providers[0] : undefined;
  const providerKeys = provider === null || typeof provider !== "object"
    ? []
    : Object.keys(provider).sort();
  if (
    !Array.isArray(providers)
    || providers.length !== 1
    || providerKeys.join("\0") !== [
      "authorizationEndpoint",
      "clientId",
      "clientSecret",
      "id",
      "issuer",
      "jwksUri",
      "tokenEndpoint",
    ].join("\0")
    || provider?.id !== "zoho"
    || provider?.issuer !== "https://accounts.zoho.in"
    || provider?.authorizationEndpoint !== "https://accounts.zoho.in/oauth/v2/auth"
    || provider?.tokenEndpoint !== "https://accounts.zoho.in/oauth/v2/token"
    || provider?.jwksUri !== "https://accounts.zoho.in/oauth/v2/keys"
    || !oneLine(provider?.clientId)
    || !oneLine(provider?.clientSecret)
  ) {
    throw new Error("The Keychain OIDC provider does not match the approved Zoho India contract.");
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
