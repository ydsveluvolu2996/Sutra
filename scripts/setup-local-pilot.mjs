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

if (existingContents === null) {
  const values = [
    "# Generated once by `npm run pilot:setup`. Never commit this file.",
    "SUTRA_LOCAL_MODE=true",
    `SUTRA_LOCAL_BOOTSTRAP_TOKEN=${secret()}`,
    `SUTRA_AUTH_ENCRYPTION_KEY=${secret()}`,
    "SUTRA_AUTH_KEY_VERSION=local-auth-v1",
    `SUTRA_CONNECTION_ENCRYPTION_KEY=${secret()}`,
    "SUTRA_CONNECTION_KEY_VERSION=local-v1",
    `SUTRA_BROKER_SHARED_SECRET=${secret()}`,
    `SUTRA_REGISTRY_ENCRYPTION_KEY=${secret()}`,
    "SUTRA_BROKER_URL=http://127.0.0.1:8788",
    "SUTRA_COLLECTOR_MODE=fixture",
    "SUTRA_ALLOW_LIVE_AWS=false",
    "SUTRA_COLLECTOR_PRINCIPAL_ARN=arn:aws:iam::999988887777:role/SutraLocalCollector",
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
    additions.push("SUTRA_AUTH_KEY_VERSION=local-auth-v1");
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
    const linePattern = new RegExp(`^${name}=`, "mu");
    if (linePattern.test(updatedContents)) {
      updatedContents = updatedContents.replace(new RegExp(`^${name}=.*$`, "mu"), `${name}=${value}`);
    } else {
      additions.push(`${name}=${value}`);
    }
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
