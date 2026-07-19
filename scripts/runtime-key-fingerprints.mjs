import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const path = process.env.SUTRA_LOCAL_CONFIG_PATH ?? "/app/runtime/.dev.vars";
const contents = await readFile(path, "utf8");
const values = new Map();
for (const rawLine of contents.split(/\r?\n/u)) {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
}

const names = [
  "SUTRA_CONNECTION_ENCRYPTION_KEY",
  "SUTRA_AUTH_ENCRYPTION_KEY",
  "SUTRA_BROKER_SHARED_SECRET",
  "SUTRA_REGISTRY_ENCRYPTION_KEY",
];
const fingerprints = {};
for (const name of names) {
  const value = values.get(name);
  if (value === undefined || value.length < 32) throw new Error(`Local runtime configuration is missing ${name}`);
  fingerprints[name] = createHash("sha256").update(value, "utf8").digest("hex");
}
process.stdout.write(`${JSON.stringify(fingerprints)}\n`);
