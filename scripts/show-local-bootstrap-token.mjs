import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configuredPath = process.env.SUTRA_LOCAL_CONFIG_PATH ?? ".dev.vars";
if (/[\r\n]/u.test(configuredPath)) throw new Error("SUTRA_LOCAL_CONFIG_PATH must be a single path");
const variablesPath = resolve(root, configuredPath);
const metadata = await stat(variablesPath);
if ((metadata.mode & 0o077) !== 0) {
  throw new Error("The local runtime configuration permissions are too broad; run chmod 600 on it before reading the setup token");
}
const contents = await readFile(variablesPath, "utf8");
const match = /^SUTRA_LOCAL_BOOTSTRAP_TOKEN=(.+)$/mu.exec(contents);
if (match?.[1] === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(match[1])) {
  throw new Error("Generate the selected local runtime configuration before requesting its setup token");
}
process.stdout.write("Paste this one-time token into the Sutra first-time setup screen:\n");
process.stdout.write(`${match[1]}\n`);
