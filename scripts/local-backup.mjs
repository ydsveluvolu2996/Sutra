import { resolve } from "node:path";

import { backupLocalState } from "./local-data-utils.mjs";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2] === undefined ? undefined : resolve(root, process.argv[2]);
const result = await backupLocalState({ root, target });
process.stdout.write(`Created verified local backup: ${result.backupDirectory}\n`);
