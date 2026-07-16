import { resolve } from "node:path";

import { restoreLocalState } from "./local-data-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const backup = process.argv[2];
if (backup === undefined) {
  throw new Error("Usage: pnpm local:restore -- .sutra/backups/<backup-directory>");
}
const result = await restoreLocalState({ root, backup: resolve(root, backup) });
process.stdout.write(`Restored ${result.fileCount} verified local files from ${result.restoredFrom}\n`);
