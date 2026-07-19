import { resolve } from "node:path";

import { restoreLocalState } from "./local-data-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const argumentsWithoutSeparator = process.argv.slice(2).filter((value) => value !== "--");
if (argumentsWithoutSeparator.length !== 1) {
  throw new Error("Usage: pnpm local:restore -- .sutra/backups/<backup-directory>");
}
const result = await restoreLocalState({ root, backup: resolve(root, argumentsWithoutSeparator[0]) });
process.stdout.write(`Restored ${result.fileCount} verified local files from ${result.restoredFrom}\n`);
