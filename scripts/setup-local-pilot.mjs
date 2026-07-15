import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const variablesPath = resolve(root, ".dev.vars");
const stateDirectory = resolve(root, ".sutra");

await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await chmod(stateDirectory, 0o700);

let exists = false;
try {
  await readFile(variablesPath, "utf8");
  exists = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (!exists) {
  const secret = () => randomBytes(32).toString("base64url");
  const values = [
    "# Generated once by `npm run pilot:setup`. Never commit this file.",
    "SUTRA_LOCAL_MODE=true",
    "SUTRA_LOCAL_OPERATOR_EMAIL=local-admin@sutra.invalid",
    `SUTRA_CONNECTION_ENCRYPTION_KEY=${secret()}`,
    "SUTRA_CONNECTION_KEY_VERSION=local-v1",
    `SUTRA_BROKER_SHARED_SECRET=${secret()}`,
    `SUTRA_REGISTRY_ENCRYPTION_KEY=${secret()}`,
    "SUTRA_BROKER_URL=http://127.0.0.1:8788",
    "SUTRA_COLLECTOR_MODE=fixture",
    "SUTRA_COLLECTOR_PRINCIPAL_ARN=arn:aws:iam::999988887777:role/SutraLocalCollector",
    "SUTRA_FIXTURE_ACCOUNT_ID=123456789012",
    "SUTRA_REGISTRY_PATH=.sutra/collector-registry.enc",
    "",
  ];
  await writeFile(variablesPath, values.join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
}
await chmod(variablesPath, 0o600);
process.stdout.write(exists ? "Local pilot configuration already exists.\n" : "Created secure local pilot configuration.\n");
