import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const variablesPath = resolve(root, process.env.SUTRA_LOCAL_CONFIG_PATH ?? ".dev.vars");
const stateDirectory = resolve(root, ".sutra");

await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await chmod(stateDirectory, 0o700);

let existingContents = null;
try {
  existingContents = await readFile(variablesPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const secret = () => randomBytes(32).toString("base64url");
const databaseUrl = process.env.DATABASE_URL?.trim();
if (databaseUrl !== undefined && /[\r\n]/u.test(databaseUrl)) {
  throw new Error("DATABASE_URL must be a single line");
}
// The background-job runner token must reach the Worker runtime (which reads it
// from .dev.vars via `env`), not just the container process env — otherwise the
// internal drain endpoint responds 503 NOT_CONFIGURED and jobs never run.
const jobRunnerToken = process.env.SUTRA_JOB_RUNNER_TOKEN?.trim();
if (jobRunnerToken !== undefined && /[\r\n]/u.test(jobRunnerToken)) {
  throw new Error("SUTRA_JOB_RUNNER_TOKEN must be a single line");
}

// Wrangler and the collector are launched from the generated runtime file, so
// the deployment-selected collector boundary must be materialized there too.
// Live mode is accepted only as an explicit, internally consistent triple; it
// can never be inferred from the presence of AWS credentials on the host.
const collectorMode = process.env.SUTRA_COLLECTOR_MODE?.trim() || "fixture";
const allowLiveAws = process.env.SUTRA_ALLOW_LIVE_AWS?.trim() || "false";
const collectorPrincipalArn = process.env.SUTRA_COLLECTOR_PRINCIPAL_ARN?.trim()
  || "arn:aws:iam::999988887777:role/SutraLocalCollector";
const brokerUrl = process.env.SUTRA_BROKER_URL?.trim() || "http://127.0.0.1:8788";
if (collectorMode !== "fixture" && collectorMode !== "live") {
  throw new Error("SUTRA_COLLECTOR_MODE must be exactly fixture or live");
}
if (allowLiveAws !== "true" && allowLiveAws !== "false") {
  throw new Error("SUTRA_ALLOW_LIVE_AWS must be exactly true or false");
}
if (/[\r\n]/u.test(collectorPrincipalArn) || !/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/u.test(collectorPrincipalArn)) {
  throw new Error("SUTRA_COLLECTOR_PRINCIPAL_ARN must be an exact IAM role ARN");
}
if (brokerUrl !== "http://127.0.0.1:8788") {
  throw new Error("SUTRA_BROKER_URL must use the container-local collector endpoint");
}
if (collectorMode === "live" && allowLiveAws !== "true") {
  throw new Error("live collector mode requires SUTRA_ALLOW_LIVE_AWS=true");
}
if (collectorMode === "fixture" && allowLiveAws !== "false") {
  throw new Error("fixture collector mode cannot enable live AWS access");
}
const collectorVars = [
  { name: "SUTRA_BROKER_URL", value: brokerUrl },
  { name: "SUTRA_COLLECTOR_MODE", value: collectorMode },
  { name: "SUTRA_ALLOW_LIVE_AWS", value: allowLiveAws },
  { name: "SUTRA_COLLECTOR_PRINCIPAL_ARN", value: collectorPrincipalArn },
];
// The public contact form's delivery config must reach the Worker runtime (which
// reads it from .dev.vars via `env`), not just the container process env —
// otherwise a submission is persisted but never emailed. Each is optional and
// only written when present in the container env.
const CONTACT_VARS = [
  "SUTRA_CONTACT_RECIPIENT",
  "SUTRA_CONTACT_FROM",
  "SUTRA_CONTACT_PROVIDER",
  "SUTRA_CONTACT_WEBHOOK_URL",
  "SUTRA_CONTACT_EMAIL_API_URL",
  "SUTRA_CONTACT_EMAIL_API_KEY",
];
const contactVars = CONTACT_VARS.map((name) => {
  const value = process.env[name]?.trim();
  if (value !== undefined && /[\r\n]/u.test(value)) {
    throw new Error(`${name} must be a single line`);
  }
  return { name, value };
}).filter((entry) => entry.value);

// A network-reachable password pilot is never inferred from a domain or from
// NODE_ENV. It must use the exact, staging-only opt-in and a small allowlist of
// fixed security settings. Those settings are copied into `.dev.vars` because
// Wrangler reads its runtime binding values from that file rather than directly
// from the container process environment.
const privateBetaSwitch = process.env.SUTRA_PRIVATE_BETA_PASSWORD_ENABLED;
if (privateBetaSwitch !== undefined && privateBetaSwitch !== "true" && privateBetaSwitch !== "false") {
  throw new Error("SUTRA_PRIVATE_BETA_PASSWORD_ENABLED must be exactly true or false");
}
const privateBetaRequested = privateBetaSwitch === "true";
let privateBetaVars = [];
if (privateBetaRequested) {
  const expected = {
    SUTRA_DEPLOYMENT_ENV: "staging",
    SUTRA_LOCAL_MODE: "false",
    SUTRA_IDENTITY_MODE: "password",
    SUTRA_PASSWORD_MFA_REQUIRED: "true",
  };
  for (const [name, required] of Object.entries(expected)) {
    const value = process.env[name];
    if (value !== required) throw new Error(`${name} must be exactly ${required} for the private beta`);
  }
  const publicOrigin = process.env.SUTRA_PUBLIC_ORIGIN ?? "";
  let parsedOrigin;
  try {
    parsedOrigin = new URL(publicOrigin);
  } catch {
    throw new Error("SUTRA_PUBLIC_ORIGIN must be a canonical non-loopback HTTPS origin");
  }
  if (
    /[\r\n]/u.test(publicOrigin) ||
    parsedOrigin.protocol !== "https:" ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    parsedOrigin.hostname === "localhost" ||
    parsedOrigin.hostname === "127.0.0.1" ||
    parsedOrigin.hostname === "::1"
  ) {
    throw new Error("SUTRA_PUBLIC_ORIGIN must be a canonical non-loopback HTTPS origin");
  }
  privateBetaVars = [
    ...Object.entries(expected).map(([name, value]) => ({ name, value })),
    { name: "SUTRA_PUBLIC_ORIGIN", value: parsedOrigin.origin },
    { name: "SUTRA_PRIVATE_BETA_PASSWORD_ENABLED", value: "true" },
  ];
}

function upsertVariable(contents, additions, name, value) {
  const linePattern = new RegExp(`^${name}=`, "mu");
  if (linePattern.test(contents)) {
    return contents.replace(new RegExp(`^${name}=.*$`, "mu"), `${name}=${value}`);
  }
  additions.push(`${name}=${value}`);
  return contents;
}

if (existingContents === null) {
  const values = [
    "# Generated once by `npm run pilot:setup`. Never commit this file.",
    ...(privateBetaRequested
      ? privateBetaVars.map(({ name, value }) => `${name}=${value}`)
      : ["SUTRA_LOCAL_MODE=true"]),
    `SUTRA_LOCAL_BOOTSTRAP_TOKEN=${secret()}`,
    `SUTRA_AUTH_ENCRYPTION_KEY=${secret()}`,
    `SUTRA_AUTH_KEY_VERSION=${privateBetaRequested ? "private-beta-auth-v1" : "local-auth-v1"}`,
    `SUTRA_CONNECTION_ENCRYPTION_KEY=${secret()}`,
    "SUTRA_CONNECTION_KEY_VERSION=local-v1",
    `SUTRA_BROKER_SHARED_SECRET=${secret()}`,
    `SUTRA_REGISTRY_ENCRYPTION_KEY=${secret()}`,
    ...collectorVars.map(({ name, value }) => `${name}=${value}`),
    "SUTRA_FIXTURE_ACCOUNT_ID=123456789012",
    "SUTRA_REGISTRY_PATH=.sutra/collector-registry.enc",
    ...(databaseUrl ? [`DATABASE_URL=${databaseUrl}`] : []),
    ...(jobRunnerToken ? [`SUTRA_JOB_RUNNER_TOKEN=${jobRunnerToken}`] : []),
    ...contactVars.map(({ name, value }) => `${name}=${value}`),
    "",
  ];
  await writeFile(variablesPath, values.join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
} else {
  let updatedContents = existingContents;
  const additions = [];
  if (!/^SUTRA_LOCAL_BOOTSTRAP_TOKEN=/mu.test(existingContents)) {
    additions.push(`SUTRA_LOCAL_BOOTSTRAP_TOKEN=${secret()}`);
  }
  if (!/^SUTRA_AUTH_ENCRYPTION_KEY=/mu.test(existingContents)) {
    additions.push(`SUTRA_AUTH_ENCRYPTION_KEY=${secret()}`);
  }
  if (!/^SUTRA_AUTH_KEY_VERSION=/mu.test(existingContents)) {
    additions.push(`SUTRA_AUTH_KEY_VERSION=${privateBetaRequested ? "private-beta-auth-v1" : "local-auth-v1"}`);
  }
  for (const { name, value } of privateBetaVars) {
    updatedContents = upsertVariable(updatedContents, additions, name, value);
  }
  for (const { name, value } of collectorVars) {
    updatedContents = upsertVariable(updatedContents, additions, name, value);
  }
  // Removing the opt-in from the container configuration must fail closed even
  // when a persistent runtime volume still contains a prior enabled value.
  if (!privateBetaRequested && /^SUTRA_PRIVATE_BETA_PASSWORD_ENABLED=true$/mu.test(updatedContents)) {
    updatedContents = upsertVariable(updatedContents, additions, "SUTRA_PRIVATE_BETA_PASSWORD_ENABLED", "false");
  }
  if (databaseUrl) {
    if (/^DATABASE_URL=/mu.test(updatedContents)) {
      updatedContents = updatedContents.replace(/^DATABASE_URL=.*$/mu, `DATABASE_URL=${databaseUrl}`);
    } else {
      additions.push(`DATABASE_URL=${databaseUrl}`);
    }
  }
  if (jobRunnerToken) {
    if (/^SUTRA_JOB_RUNNER_TOKEN=/mu.test(updatedContents)) {
      updatedContents = updatedContents.replace(/^SUTRA_JOB_RUNNER_TOKEN=.*$/mu, `SUTRA_JOB_RUNNER_TOKEN=${jobRunnerToken}`);
    } else {
      additions.push(`SUTRA_JOB_RUNNER_TOKEN=${jobRunnerToken}`);
    }
  }
  for (const { name, value } of contactVars) {
    updatedContents = upsertVariable(updatedContents, additions, name, value);
  }
  if (additions.length > 0 || updatedContents !== existingContents) {
    const prefix = updatedContents.endsWith("\n") ? updatedContents : `${updatedContents}\n`;
    await writeFile(variablesPath, `${prefix}${additions.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
await chmod(variablesPath, 0o600);
process.stdout.write(existingContents === null
  ? "Created secure local pilot configuration.\n"
  : "Local pilot configuration is ready.\n");
