import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const variablesPath = resolve(root, ".dev.vars");
const metadata = await stat(variablesPath);
if ((metadata.mode & 0o077) !== 0) {
  throw new Error(".dev.vars permissions are too broad; run chmod 600 .dev.vars before reading the setup token");
}
const contents = await readFile(variablesPath, "utf8");
const match = /^SUTRA_LOCAL_BOOTSTRAP_TOKEN=(.+)$/mu.exec(contents);
if (match?.[1] === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(match[1])) {
  throw new Error("Run pnpm pilot:setup before requesting the local setup token");
}
process.stdout.write("Paste this one-time token into the Sutra first-time setup screen:\n");
process.stdout.write(`${match[1]}\n`);
